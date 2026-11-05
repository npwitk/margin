import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { samePaper, type Session } from "@margin/shared";
import { fetchDoiBibtex } from "./ai/citations.ts";
import { addRefs, attachPdf, load, mutate, projectEntries } from "./library.ts";
import { saveSource } from "./libraryFiles.ts";
import { listFiles, resolvePath } from "./storage.ts";

/**
 * Move a project's hand-kept reference folder into the library: for each
 * <folder>/papers/<name>/ with a summary.md (YAML front matter: bibkey, title,
 * authors, venue, year, doi, tags, summary_status), attach its paper.pdf,
 * source/ files and the summary to the matching library reference.
 */

export interface ImportItem {
  folder: string;
  bibkey?: string;
  title: string;
  /** Library reference it went to (or would go to). */
  refKey?: string;
  action: "matched" | "added" | "skipped";
  pdf: boolean;
  sourceFiles: number;
  summary: boolean;
  notes: string[];
}

const split = (md: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md.replace(/\r\n/g, "\n"));
  if (!m) return { meta: {} as Record<string, unknown>, body: md };
  let meta: Record<string, unknown> = {};
  try { meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>; } catch { /* keep going with the body */ }
  return { meta, body: m[2].trim() };
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/** BibTeX-ish fields from the front matter. */
export function fieldsFromFrontMatter(meta: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  const authors = Array.isArray(meta.authors) ? meta.authors.map(str) : str(meta.authors).split(/\s*,\s*|\s+and\s+/);
  if (authors.filter(Boolean).length) fields.author = authors.filter(Boolean).join(" and ");
  for (const [from, to] of [["title", "title"], ["venue", "journal"], ["year", "year"], ["doi", "doi"], ["url", "url"]] as const) {
    if (str(meta[from])) fields[to] = str(meta[from]);
  }
  return fields;
}

export async function importReferenceFolder(projectId: string, folder: string, session: Session, dryRun: boolean) {
  const root = folder.replace(/^\/+|\/+$/g, "") || "Reference";
  const files = (await listFiles(projectId)).filter((f) => f.type === "file" && f.path.startsWith(`${root}/`));
  const summaries = files.filter((f) => /\/summary\.md$/.test(f.path) && !f.path.includes("/_template/"));
  if (!summaries.length) throw new Error(`No ${root}/**/summary.md files in this project`);
  const entries = await projectEntries(projectId);
  const items: ImportItem[] = [];
  const by = session.agent ? `${session.agent} (for ${session.name})` : session.name;

  for (const s of summaries) {
    const dir = s.path.slice(0, -"/summary.md".length);
    const { meta, body } = split(await readFile(resolvePath(projectId, s.path), "utf8"));
    const bibkey = str(meta.bibkey) || undefined;
    let fields = fieldsFromFrontMatter(meta);
    const item: ImportItem = { folder: dir, bibkey, title: fields.title ?? dir, action: "skipped", pdf: false, sourceFiles: 0, summary: !!body, notes: [] };
    items.push(item);

    const entry = bibkey ? entries.find((e) => e.key === bibkey) : undefined;
    if (bibkey && !entry) item.notes.push(`\\bibitem{${bibkey}} isn't in the paper`);
    if (entry) fields = { ...fields, ...entry.fields, ...(fields.doi && !entry.fields.doi ? { doi: fields.doi } : {}) };
    if (!fields.title && !fields.doi) { item.notes.push("no title or DOI"); continue; }

    const refs = (await load()).refs;
    let ref = refs.find((r) => samePaper(r.fields, fields) || (entry && samePaper(r.fields, entry.fields)));
    item.action = ref ? "matched" : "added";
    const pdfPath = files.find((f) => f.path === `${dir}/${str(meta.pdf) || "paper.pdf"}`) ?? files.find((f) => f.path.startsWith(`${dir}/`) && f.path.endsWith(".pdf") && !f.path.includes("/source/"));
    const sources = files.filter((f) => f.path.startsWith(`${dir}/source/`));
    item.pdf = !!pdfPath;
    item.sourceFiles = sources.length;
    if (dryRun) { item.refKey = ref?.key; continue; }

    if (!ref) {
      // A DOI gives the full record; the front matter is the fallback.
      let full: { type: string; fields: Record<string, string> } = { type: "article", fields };
      if (fields.doi) try { const { entry: e } = await fetchDoiBibtex(fields.doi); full = { type: e.type, fields: { ...e.fields, doi: fields.doi } }; } catch { /* keep the front matter */ }
      const res = await addRefs([{ key: bibkey, ...full }], session, projectId);
      ref = res.added[0] ?? res.merged[0];
    }
    if (!ref) { item.action = "skipped"; item.notes.push("couldn't add to the library"); continue; }
    item.refKey = ref.key;

    if (pdfPath && !ref.pdf) await attachPdf(ref.id, await readFile(resolvePath(projectId, pdfPath.path)), by, "import");
    else if (pdfPath) item.notes.push("library already had a PDF; kept it");
    for (const f of sources) await saveSource(ref.id, f.path.slice(`${dir}/source/`.length), await readFile(resolvePath(projectId, f.path)));
    const status = str(meta.summary_status).startsWith("verified") ? "verified" as const : "ai-draft" as const;
    const tags = Array.isArray(meta.tags) ? meta.tags.map(str).filter(Boolean) : [];
    const refId = ref.id;
    await mutate((st) => {
      const r = st.refs.find((x) => x.id === refId);
      if (!r) return;
      const now = new Date().toISOString();
      if (body && !r.summary) r.summary = { markdown: body, status, updatedAt: now, updatedBy: by };
      else if (body) item.notes.push("library already had a summary; kept it");
      if (tags.length) r.tags = [...new Set([...(r.tags ?? []), ...tags])];
      if (sources.length) r.hasSource = true;
      if (!r.projects.includes(projectId)) r.projects.push(projectId);
      r.updatedAt = now;
    });
  }
  return { folder: root, dryRun, items };
}
