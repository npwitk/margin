import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  authorList, byline, checkProxy, viaProxy, isGenericKey, plainTex, normDoi, parseBibcite, refVenue, summaryTldr, parseBibtex, refTitle, samePaper, suggestKey, toBibitem, toBibtex,
  type CiteCard, type CiteOptions, type UsageView, type LibraryAddResult, type LibraryPdf, type LibraryRef, type LibraryView, type Session,
} from "@margin/shared";
import { refreshUsage, scanProject, usageRecords } from "./citeUsage.ts";
import { listDocuments, pdfPathOf, resolveDocument } from "./documents.ts";
import { MAX_PDF, findPdf, pdfFile, readPages, removeFiles, savePdf } from "./libraryFiles.ts";
import type { AppEnv } from "./auth.ts";
import { canAccess } from "./access.ts";
import { isGuest } from "./workspace.ts";
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

interface Stored { refs: LibraryRef[]; /** The university library's proxy link (see viaProxy). */ proxy?: string }

const FILE = path.join(DATA_DIR, "library.json");
let cache: Stored | null = null;
let queue: Promise<unknown> = Promise.resolve();

export async function load(): Promise<Stored> {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8").catch(() => '{"refs":[]}')) as Stored;
  return cache;
}

/** Serialize read-modify-write so concurrent adds don't lose each other. */
export function mutate<T>(fn: (s: Stored) => T | Promise<T>): Promise<T> {
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

export interface Incoming { key?: string; type?: string; fields: Record<string, string> }

/** Add references, merging with ones already in the library; tag them with a project. */
export async function addRefs(items: Incoming[], session: Session, projectId?: string): Promise<LibraryAddResult> {
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
export async function projectEntries(projectId: string) {
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
export async function enrich(entries: Awaited<ReturnType<typeof projectEntries>>) {
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

/**
 * A reference by whatever someone calls it: its library id or key, a DOI, the
 * key a project uses for it (ref7), or a title.
 */
export async function resolveRef(query: string, projectId?: string): Promise<LibraryRef> {
  const q = query.trim();
  const refs = (await load()).refs;
  const hit = refs.find((r) => r.id === q) ?? refs.find((r) => r.key === q)
    ?? (normDoi(q).startsWith("10.") ? refs.find((r) => normDoi(r.fields.doi) === normDoi(q)) : undefined);
  if (hit) return hit;
  if (projectId) {
    const entry = (await projectEntries(projectId)).find((e) => e.key === q);
    const match = entry && refs.find((r) => samePaper(r.fields, entry.fields));
    if (match) return match;
    if (entry) throw new HttpError(404, `${q} is in the paper but not in the library yet. Run add_reference with its DOI or title first.`);
  }
  const lower = q.toLowerCase();
  const byTitle = refs.filter((r) => refTitle(r.fields).toLowerCase().includes(lower));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new HttpError(409, `"${q}" matches ${byTitle.length} references: ${byTitle.slice(0, 5).map((r) => r.key).join(", ")}`);
  throw new HttpError(404, `No reference "${q}" in the library`);
}

/** Store a PDF for a reference and record it. */
export async function attachPdf(refId: string, data: Buffer, by: string, source: LibraryPdf["source"]) {
  const { pages, size } = await savePdf(refId, data);
  return mutate((s) => {
    const r = s.refs.find((x) => x.id === refId);
    if (!r) throw new HttpError(404, "Reference not found");
    r.pdf = { size, pages, addedAt: new Date().toISOString(), addedBy: by, source };
    r.updatedAt = r.pdf.addedAt;
    return r;
  });
}

/** Try to fetch a free copy; attach it when found. */
export async function fetchPdfFor(ref: LibraryRef, by: string) {
  const lookup = await findPdf(ref, (await load()).proxy);
  const { data, ...rest } = lookup;
  if (!data) return { ...rest, ref };
  return { ...rest, ref: await attachPdf(ref.id, data, by, lookup.source ?? "openalex") };
}

export async function setSummary(refId: string, markdown: string, status: "ai-draft" | "verified", by: string, tags?: string[]) {
  return mutate((s) => {
    const r = s.refs.find((x) => x.id === refId);
    if (!r) throw new HttpError(404, "Reference not found");
    const now = new Date().toISOString();
    r.summary = markdown.trim() ? { markdown: markdown.slice(0, 100_000), status, updatedAt: now, updatedBy: by } : undefined;
    if (tags) r.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 30);
    r.updatedAt = now;
    return r;
  });
}

/** A PDF from a request: the raw body (application/pdf) or a multipart "file". */
async function pdfFromRequest(c: Context<AppEnv>) {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("multipart/")) {
    const file = (await c.req.formData()).get("file");
    if (!file || typeof file === "string") throw new HttpError(400, "Send the PDF as \"file\"");
    return Buffer.from(await file.arrayBuffer());
  }
  return Buffer.from(await c.req.arrayBuffer());
}

const pdfLimit = bodyLimit({ maxSize: MAX_PDF, onError: (c) => c.json({ error: "PDFs up to 60 MB" }, 413) });

async function servePdf(refId: string) {
  const data = await readFile(pdfFile(refId)).catch(() => null);
  if (!data) throw new HttpError(404, "No PDF attached yet");
  return new Response(data, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=300" } });
}

/**
 * What of the library someone may see. Workspace members see all of it. A
 * guest (say, an advisor invited to one paper) sees every reference their
 * papers list or cite, and nothing else, and can't change library entries.
 */
export async function libraryScope(s: Session) {
  const projects = await visibleProjects(s);
  const ids = new Set(projects.map((p) => p.id));
  if (!(await isGuest(s))) return { full: true, guest: false, projects, ids, refIds: null as Set<string> | null };
  const used = new Set((await usageRecords({ projectIds: ids })).map((u) => u.refId));
  for (const r of (await load()).refs) if (r.projects.some((p) => ids.has(p))) used.add(r.id);
  return { full: false, guest: true, projects, ids, refIds: used };
}

export async function assertVisible(ref: LibraryRef, s: Session) {
  const scope = await libraryScope(s);
  if (scope.refIds && !scope.refIds.has(ref.id)) throw new HttpError(404, "No such reference in your papers");
  return ref;
}

async function requireMember(s: Session) {
  if (await isGuest(s)) throw new HttpError(403, "Guests can read the references of their papers but not change the library. Ask a co-author.");
}

export async function visibleProjects(s: Session) {
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
    const { projects, ids, refIds } = await libraryScope(c.get("session"));
    const refs = (await load()).refs.filter((r) => !refIds || refIds.has(r.id)).map((r) => ({ ...r, projects: r.projects.filter((p) => ids.has(p)) }));
    return c.json({ refs, projects, proxy: (await load()).proxy } satisfies LibraryView);
  })
  .put("/settings", async (c) => {
    await requireMember(c.get("session"));
    const body = await parseBody<{ proxy?: string }>(c);
    const { proxy, error } = checkProxy(body.proxy ?? "");
    if (error) throw new HttpError(400, error);
    await mutate((s) => { s.proxy = proxy; });
    return c.json({ proxy });
  })
  .post("/doi", limit("library-doi", 60, 600), async (c) => {
    await requireMember(c.get("session"));
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
    await requireMember(c.get("session"));
    const { text, projectId } = await parseBody<{ text?: string; projectId?: string }>(c);
    if (projectId && !(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    const entries = parseBibtex((text ?? "").slice(0, 2_000_000));
    if (!entries.length) throw new HttpError(400, "No BibTeX entries found. Paste entries like @article{key, title = {…}, …}");
    return c.json(await addRefs(entries.map((e) => ({ key: e.key, type: e.type, fields: e.fields })), c.get("session"), projectId), 201);
  })
  .post("/import-project", async (c) => {
    await requireMember(c.get("session"));
    const { projectId } = await parseBody<{ projectId?: string }>(c);
    if (!projectId || !(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    const entries = await enrich(await projectEntries(projectId));
    if (!entries.length) throw new HttpError(400, "That paper has no references yet (no .bib entries or \\bibitem).");
    return c.json(await addRefs(entries, c.get("session"), projectId), 201);
  })
  .patch("/:id", async (c) => {
    await requireMember(c.get("session"));
    const body = await parseBody<{ key?: string; type?: string; fields?: Record<string, string>; projects?: string[]; note?: string; summary?: string; summaryStatus?: "ai-draft" | "verified"; tags?: string[] }>(c);
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
      if (body.summary !== undefined) {
        r.summary = body.summary.trim()
          ? { markdown: body.summary.slice(0, 100_000), status: body.summaryStatus ?? r.summary?.status ?? "ai-draft", updatedAt: r.updatedAt, updatedBy: c.get("session").name }
          : undefined;
      } else if (body.summaryStatus && r.summary) r.summary.status = body.summaryStatus;
      if (body.tags) r.tags = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 30);
      return r;
    });
    return c.json(ref);
  })
  .delete("/:id", async (c) => {
    await requireMember(c.get("session"));
    const id = c.req.param("id");
    await mutate((s) => { s.refs = s.refs.filter((r) => r.id !== id); });
    await removeFiles(id, "all").catch(() => {});
    return c.json({ ok: true });
  })
  .get("/usage", async (c) => {
    const projects = await visibleProjects(c.get("session"));
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const projectId = c.req.query("project") || undefined;
    if (projectId && !names.has(projectId)) throw new HttpError(404, "Project not found");
    // Bring the paper's records up to date (the first time, this also replays its history).
    if (projectId) await refreshUsage(projectId, c.get("session").name);
    const documents: UsageView["documents"] = [];
    for (const p of projectId ? projects.filter((x) => x.id === projectId) : projects) {
      for (const d of await listDocuments(p.id).catch(() => [])) if (!d.archived) documents.push({ projectId: p.id, path: d.path, title: d.title });
    }
    const titles = new Map(documents.map((d) => [`${d.projectId}:${d.path}`, d.title]));
    const refId = c.req.query("ref") || undefined;
    if (refId) await assertVisible(await resolveRef(refId), c.get("session"));
    const records = (await usageRecords({ projectIds: new Set(names.keys()), projectId, document: c.req.query("document") || undefined, refId }))
      .map((r) => ({ ...r, projectName: names.get(r.projectId) ?? r.projectId, documentTitle: titles.get(`${r.projectId}:${r.document}`) ?? r.document }));
    return c.json({ records, documents } satisfies UsageView);
  })
  .post("/usage/refresh", async (c) => {
    const projectId = c.req.query("project") ?? "";
    if (!(await canAccess(projectId, c.get("session")))) throw new HttpError(404, "Project not found");
    await refreshUsage(projectId, c.get("session").name);
    return c.json({ ok: true });
  })
  .get("/:id/pdf", async (c) => servePdf((await assertVisible(await resolveRef(c.req.param("id")), c.get("session"))).id))
  .put("/:id/pdf", pdfLimit, async (c) => {
    const ref = await assertVisible(await resolveRef(c.req.param("id")), c.get("session"));
    return c.json(await attachPdf(ref.id, await pdfFromRequest(c), c.get("session").name, "upload"));
  })
  .delete("/:id/pdf", async (c) => {
    await requireMember(c.get("session"));
    const id = c.req.param("id");
    await removeFiles(id, "pdf");
    return c.json(await mutate((s) => {
      const r = s.refs.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Reference not found");
      delete r.pdf;
      return r;
    }));
  })
  .post("/:id/find-pdf", limit("library-find-pdf", 30, 600), async (c) => {
    const ref = await assertVisible(await resolveRef(c.req.param("id")), c.get("session"));
    return c.json(await fetchPdfFor(ref, c.get("session").name));
  })
  .get("/:id/text", async (c) => {
    const pages = await readPages((await assertVisible(await resolveRef(c.req.param("id")), c.get("session"))).id);
    if (!pages) throw new HttpError(404, "No PDF attached yet");
    return c.json({ pages });
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
  // For agents, which reach Margin through a project: attach a PDF they have locally.
  .put("/:id/library/:ref/pdf", pdfLimit, async (c) => {
    const session = c.get("session");
    const ref = await assertVisible(await resolveRef(decodeURIComponent(c.req.param("ref")), c.req.param("id")), session);
    const r = await attachPdf(ref.id, await pdfFromRequest(c), session.agent ? `${session.agent} (for ${session.name})` : session.name, "upload");
    return c.json({ id: r.id, key: r.key, title: refTitle(r.fields), pdf: r.pdf });
  })
  .get("/:id/cite-map", async (c) => c.json(await citeMap(c.req.param("id"), c.req.query("doc"))))
  .get("/:id/library/:ref/pdf", async (c) => servePdf((await assertVisible(await resolveRef(decodeURIComponent(c.req.param("ref")), c.req.param("id")), c.get("session"))).id))
  .post("/:id/library-import", async (c) => {
    const entries = await enrich(await projectEntries(c.req.param("id")));
    return c.json(await addRefs(entries, c.get("session"), c.req.param("id")), 201);
  });

/**
 * What each printed citation in a compiled document points to: labels from
 * the .aux file's \bibcite lines, joined to the paper's entries and the library.
 */
/** A paper's DOI (or URL) opened through the library proxy. */
const linkThroughLibrary = (proxy: string | undefined, f: Record<string, string>) => {
  const target = normDoi(f.doi) ? `https://doi.org/${normDoi(f.doi)}` : f.url;
  return target ? viaProxy(proxy, target) : undefined;
};

/** "Ji, Jeonil and Song, Youngbae" → "Jeonil Ji, Youngbae Song". */
const readableAuthors = (author?: string) => {
  const names = authorList(author).map((n) => {
    const plain = plainTex(n);
    const [last, ...first] = plain.split(",");
    return first.length ? `${first.join(",").trim()} ${last.trim()}` : plain;
  });
  if (!names.length) return undefined;
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} et al.` : names.join(", ");
};

export async function citeMap(projectId: string, doc?: string): Promise<CiteCard[]> {
  const { path: docPath } = await resolveDocument(projectId, doc);
  const aux = await readFile(pdfPathOf(projectId, docPath).replace(/\.pdf$/, ".aux"), "utf8").catch(() => "");
  if (!aux) return [];
  const scan = (await scanProject(projectId)).find((s) => s.document === docPath);
  const { refs, proxy } = await load();
  return parseBibcite(aux).map(({ key, label, authorYear }) => {
    const entry = scan?.entries.find((e) => e.key === key);
    const ref = entry && refs.find((r) => samePaper(r.fields, entry.fields));
    const f = { ...(entry?.fields ?? {}), ...(ref?.fields ?? {}) };
    return {
      label, authorYear, key,
      title: refTitle(f), byline: byline(f), authors: readableAuthors(f.author),
      venue: refVenue(f) || undefined, year: f.year, doi: normDoi(f.doi) || undefined, url: f.url,
      tldr: summaryTldr(ref?.summary?.markdown), refId: ref?.id, hasPdf: !!ref?.pdf,
      libraryUrl: ref?.pdf ? undefined : linkThroughLibrary(proxy, f),
    };
  });
}

/** Called when someone adds a DOI inside a paper, so it lands in the library too. */
export const rememberInLibrary = (item: Incoming, session: Session, projectId: string) =>
  addRefs([item], session, projectId).catch((err) => console.error("library:", err));
