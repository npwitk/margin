import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import {
  byline, isGenericKey, parseBibtex, refTitle, samePaper, suggestKey, toBibitem, toBibtex,
  type CiteOptions, type LibraryAddResult, type LibraryRef, type LibraryView, type Session,
} from "@margin/shared";
import type { AppEnv } from "./auth.ts";
import { canAccess } from "./access.ts";
import { withDoc } from "./collab.ts";
import { DATA_DIR } from "./config.ts";
import { fetchDoiBibtex, parseBibitems } from "./ai/citations.ts";
import { textFiles, textOf } from "./ai/paper.ts";
import { limit } from "./ratelimit.ts";
import { HttpError, getProject, listProjects, writeText } from "./storage.ts";

/**
 * The workspace's shared reference library (DATA_DIR/library.json). A
 * reference is stored once; `projects` lists the papers it belongs to, which
 * are the library's sections. Inserting one into a paper writes it to that
 * paper's .bib (or its thebibliography) through the live document.
 */

interface Stored { refs: LibraryRef[] }

const FILE = path.join(DATA_DIR, "library.json");
let cache: Stored | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Stored> {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8").catch(() => '{"refs":[]}')) as Stored;
  return cache;
}

/** Serialize read-modify-write so concurrent adds don't lose each other. */
function mutate<T>(fn: (s: Stored) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const s = await load();
    const result = await fn(s);
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, JSON.stringify(s, null, 1));
    await rename(`${FILE}.tmp`, FILE);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

/** Crossref sometimes returns HTML inside BibTeX: "Computers &amp; Security", "<i>Notice of Removal</i>". */
const decodeHtml = (s: string) => s
  .replace(/<\/?(?:i|b|em|strong|sup|sub|span|scp|mml:[a-z]+)\b[^>]*>/gi, "")
  .replace(/&amp;/g, "\\&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const clean = (fields: Record<string, string>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const name = k.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const value = decodeHtml(String(v ?? "")).replace(/\s+/g, " ").trim().slice(0, 4000);
    if (name && value) out[name] = value;
  }
  return out;
};

function uniqueKey(s: Stored, wanted: string, except?: string) {
  const base = wanted.replace(/[^\w:.-]/g, "").slice(0, 60) || "ref";
  let key = base, n = 2;
  while (s.refs.some((r) => r.key === key && r.id !== except)) key = `${base}${String.fromCharCode(96 + Math.min(n++, 26))}`;
  return key;
}

interface Incoming { key?: string; type?: string; fields: Record<string, string> }

/** Add references, merging with ones already in the library; tag them with a project. */
async function addRefs(items: Incoming[], session: Session, projectId?: string): Promise<LibraryAddResult> {
  return mutate((s) => {
    const result: LibraryAddResult = { added: [], merged: [] };
    const now = new Date().toISOString();
    for (const item of items) {
      const fields = clean(item.fields);
      if (!fields.title && !fields.doi) continue;
      const existing = s.refs.find((r) => samePaper(r.fields, fields));
      if (existing) {
        // Fill in fields the library copy lacks; never overwrite edits.
        for (const [k, v] of Object.entries(fields)) if (!existing.fields[k]) existing.fields[k] = v;
        if (projectId && !existing.projects.includes(projectId)) existing.projects.push(projectId);
        existing.updatedAt = now;
        if (!result.merged.includes(existing) && !result.added.includes(existing)) result.merged.push(existing);
        continue;
      }
      const wanted = item.key && !isGenericKey(item.key) ? item.key : suggestKey(fields);
      const ref: LibraryRef = {
        id: randomUUID(), key: uniqueKey(s, wanted), type: (item.type || "misc").toLowerCase(), fields,
        projects: projectId ? [projectId] : [], addedBy: session.name, addedAt: now, updatedAt: now,
      };
      s.refs.push(ref);
      result.added.push(ref);
    }
    return result;
  });
}

/** Every reference a project already has, from its .bib files and any thebibliography. */
async function projectEntries(projectId: string) {
  const out: { key: string; type: string; file: string; fields: Record<string, string> }[] = [];
  for (const f of await textFiles(projectId)) {
    const isBib = f.path.endsWith(".bib");
    if (!isBib && !f.path.endsWith(".tex")) continue;
    const text = (await textOf(projectId, f.path)) ?? "";
    if (isBib) for (const e of parseBibtex(text)) out.push({ key: e.key, type: e.type, file: f.path, fields: e.fields });
    else if (text.includes("\\bibitem")) for (const e of parseBibitems(text)) out.push({ key: e.key, type: "misc", file: f.path, fields: e.fields });
  }
  return out;
}

/**
 * A hand-written \bibitem only gives us a title, first author and year. When
 * it has a DOI, fetch the full record so the library copy is complete.
 */
async function enrich(entries: Awaited<ReturnType<typeof projectEntries>>) {
  const known = (await load()).refs;
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < entries.length) {
      const e = entries[next++];
      if (!e.file.endsWith(".tex") || !e.fields.doi || known.some((r) => samePaper(r.fields, e.fields))) continue;
      try {
        const { entry } = await fetchDoiBibtex(e.fields.doi);
        e.type = entry.type;
        e.fields = { ...entry.fields, doi: e.fields.doi };
      } catch { /* keep what the \bibitem says */ }
    }
  }));
  return entries;
}

/** The .bib a project compiles with: the one named by \bibliography/\addbibresource, else the first. */
async function bibTarget(projectId: string) {
  const files = await textFiles(projectId);
  const bibs = files.filter((f) => f.path.endsWith(".bib")).map((f) => f.path);
  if (bibs.length <= 1) return bibs[0];
  const named = new Set<string>();
  for (const f of files.filter((f) => f.path.endsWith(".tex"))) {
    const text = (await textOf(projectId, f.path)) ?? "";
    for (const m of text.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]+)\}/g))
      for (const n of m[1].split(",")) named.add(path.basename(n.trim()).replace(/\.bib$/, ""));
  }
  return bibs.find((b) => named.has(path.basename(b, ".bib"))) ?? bibs[0];
}

/** Put a library reference into a project. Returns the key to \cite (the paper's own key if it already has it). */
export async function insertIntoProject(projectId: string, refId: string, session: Session) {
  const ref = (await load()).refs.find((r) => r.id === refId);
  if (!ref) throw new HttpError(404, "Reference not found");
  const tag = () => mutate((s) => {
    const r = s.refs.find((x) => x.id === refId);
    if (r && !r.projects.includes(projectId)) r.projects.push(projectId);
  });

  const entries = await projectEntries(projectId);
  const have = entries.find((e) => samePaper(e.fields, ref.fields));
  if (have) { await tag(); return { key: have.key, file: have.file, added: false }; }

  let key = ref.key, n = 2;
  while (entries.some((e) => e.key === key)) key = `${ref.key}${n++}`;

  const bib = await bibTarget(projectId);
  if (bib) {
    await withDoc(projectId, bib, session, (doc) => {
      const t = doc.getText("content");
      const cur = t.toString();
      t.insert(cur.length, `${cur.trim() ? (cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n") : ""}${toBibtex({ ...ref, key })}\n`);
    });
    await tag();
    return { key, file: bib, added: true };
  }

  // No .bib: add a \bibitem to a hand-written thebibliography.
  for (const f of (await textFiles(projectId)).filter((x) => x.path.endsWith(".tex"))) {
    if (!((await textOf(projectId, f.path)) ?? "").includes("\\end{thebibliography}")) continue;
    const ok = await withDoc(projectId, f.path, session, (doc) => {
      const t = doc.getText("content");
      const at = t.toString().lastIndexOf("\\end{thebibliography}");
      if (at < 0) return false;
      t.insert(at, `${toBibitem({ ...ref, key })}\n\n`);
      return true;
    });
    if (ok) { await tag(); return { key, file: f.path, added: true }; }
  }

  // Nothing yet: start a references.bib next to the main file.
  const { mainFile } = await getProject(projectId);
  const file = path.posix.join(path.posix.dirname(mainFile), "references.bib").replace(/^\.\//, "");
  await writeText(projectId, file, `${toBibtex({ ...ref, key })}\n`);
  await tag();
  return { key, file, added: true, note: `Created ${file}. Add \\bibliography{references} to ${mainFile} to print it.` };
}

async function visibleProjects(s: Session) {
  const all = await listProjects();
  const ok = await Promise.all(all.map((p) => canAccess(p.id, s)));
  return all.filter((_, i) => ok[i]).map((p) => ({ id: p.id, name: p.name }));
}

const parseBody = <T>(c: { req: { json<U>(): Promise<U> } }) => c.req.json<T>().catch(() => ({} as T));

/** /api/library */
export const libraryRoutes = new Hono<AppEnv>()
  .onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: (err as Error).message || "Server error" }, 400);
  })
  .get("/", async (c) => {
    const projects = await visibleProjects(c.get("session"));
    const ids = new Set(projects.map((p) => p.id));
    const refs = (await load()).refs.map((r) => ({ ...r, projects: r.projects.filter((p) => ids.has(p)) }));
    return c.json({ refs, projects } satisfies LibraryView);
  })
  .post("/doi", limit("library-doi", 60, 600), async (c) => {
    const { dois, projectId } = await parseBody<{ dois?: string[]; projectId?: string }>(c);
    if (projectId && !(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    const list = (dois ?? []).map((d) => d.trim()).filter(Boolean).slice(0, 50);
    if (!list.length) throw new HttpError(400, "Paste at least one DOI");
    const items: Incoming[] = [];
    const failed: string[] = [];
    for (const d of list) {
      try { const { entry } = await fetchDoiBibtex(d); items.push({ type: entry.type, fields: entry.fields }); }
      catch (err) { failed.push((err as Error).message); }
    }
    if (!items.length) throw new HttpError(400, failed[0] ?? "Nothing found");
    return c.json({ ...(await addRefs(items, c.get("session"), projectId)), failed }, 201);
  })
  .post("/bibtex", async (c) => {
    const { text, projectId } = await parseBody<{ text?: string; projectId?: string }>(c);
    if (projectId && !(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    const entries = parseBibtex((text ?? "").slice(0, 2_000_000));
    if (!entries.length) throw new HttpError(400, "No BibTeX entries found. Paste entries like @article{key, title = {…}, …}");
    return c.json(await addRefs(entries.map((e) => ({ key: e.key, type: e.type, fields: e.fields })), c.get("session"), projectId), 201);
  })
  .post("/import-project", async (c) => {
    const { projectId } = await parseBody<{ projectId?: string }>(c);
    if (!projectId || !(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    const entries = await enrich(await projectEntries(projectId));
    if (!entries.length) throw new HttpError(400, "That paper has no references yet (no .bib entries or \\bibitem).");
    return c.json(await addRefs(entries, c.get("session"), projectId), 201);
  })
  .patch("/:id", async (c) => {
    const body = await parseBody<{ key?: string; type?: string; fields?: Record<string, string>; projects?: string[]; note?: string }>(c);
    const visible = new Set((await visibleProjects(c.get("session"))).map((p) => p.id));
    const ref = await mutate((s) => {
      const r = s.refs.find((x) => x.id === c.req.param("id"));
      if (!r) throw new HttpError(404, "Reference not found");
      if (body.key !== undefined) {
        const key = body.key.trim();
        if (!/^[\w:.-]{1,60}$/.test(key)) throw new HttpError(400, "Keys may use letters, digits and _ : . -");
        if (s.refs.some((x) => x.key === key && x.id !== r.id)) throw new HttpError(409, `${key} is already used in the library`);
        r.key = key;
      }
      if (body.type) r.type = body.type.toLowerCase().replace(/[^a-z]/g, "") || r.type;
      if (body.fields) r.fields = clean(body.fields);
      // Only projects you can see change; others stay as they were.
      if (body.projects) r.projects = [...r.projects.filter((p) => !visible.has(p)), ...body.projects.filter((p) => visible.has(p))];
      if (body.note !== undefined) r.note = body.note.slice(0, 4000) || undefined;
      r.updatedAt = new Date().toISOString();
      return r;
    });
    return c.json(ref);
  })
  .delete("/:id", async (c) => {
    await mutate((s) => { s.refs = s.refs.filter((r) => r.id !== c.req.param("id")); });
    return c.json({ ok: true });
  });

/** /api/projects/:id/library (behind the project gate) */
export const projectLibraryRoutes = new Hono<AppEnv>()
  .onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: (err as Error).message || "Server error" }, 400);
  })
  .get("/:id/library", async (c) => {
    const entries = await projectEntries(c.req.param("id"));
    const refs = (await load()).refs;
    const result: CiteOptions = {
      paper: entries.map((e) => ({ key: e.key, title: refTitle(e.fields), byline: byline(e.fields) })),
      library: refs.filter((r) => !entries.some((e) => samePaper(e.fields, r.fields)))
        .map((r) => ({ key: r.key, title: refTitle(r.fields), byline: byline(r.fields), refId: r.id })),
    };
    return c.json(result);
  })
  .post("/:id/library/:refId", async (c) => c.json(await insertIntoProject(c.req.param("id"), c.req.param("refId"), c.get("session"))))
  .post("/:id/library-import", async (c) => {
    const entries = await enrich(await projectEntries(c.req.param("id")));
    return c.json(await addRefs(entries, c.get("session"), c.req.param("id")), 201);
  });

/** Called when someone adds a DOI inside a paper, so it lands in the library too. */
export const rememberInLibrary = (item: Incoming, session: Session, projectId: string) =>
  addRefs([item], session, projectId).catch((err) => console.error("library:", err));
