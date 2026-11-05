import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { citedKeys, documentClassOf, parseBibtex, samePaper, usageStatus, type LibraryRef, type UsageRecord, type UsageStatus } from "@margin/shared";
import { parseBibitems } from "./ai/citations.ts";
import { textOf } from "./ai/paper.ts";
import { DATA_DIR } from "./config.ts";
import { listDocuments } from "./documents.ts";
import { addRefs, enrich, load, mutate as mutateLibrary } from "./library.ts";
import { getProject, projectDir } from "./storage.ts";

/**
 * Which references each document cites, now and over time
 * (DATA_DIR/library-usage.json). Refreshed after compiles and saved versions;
 * the first time a project is seen, its git history is replayed so "formerly
 * cited" has real dates from the start.
 */

interface Stored { records: UsageRecord[]; backfilled: string[] }

const FILE = path.join(DATA_DIR, "library-usage.json");
let cache: Stored | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function loadUsage(): Promise<Stored> {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8").catch(() => '{"records":[],"backfilled":[]}')) as Stored;
  return cache;
}

function mutate<T>(fn: (s: Stored) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const s = await loadUsage();
    const result = await fn(s);
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, JSON.stringify(s));
    await rename(`${FILE}.tmp`, FILE);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export interface Entry { key: string; type?: string; fields: Record<string, string>; bibitem?: boolean }
export interface DocScan { document: string; cited: Set<string>; entries: Entry[] }

/** Cited keys and bibliography entries in a set of files. */
export function scanTexts(files: Map<string, string>): { cited: Set<string>; entries: Entry[] } {
  const cited = new Set<string>();
  const entries: Entry[] = [];
  for (const [file, text] of files) {
    if (file.endsWith(".bib")) for (const e of parseBibtex(text)) entries.push({ key: e.key, type: e.type, fields: e.fields });
    else if (file.endsWith(".tex")) {
      for (const { key } of citedKeys(text)) cited.add(key);
      if (text.includes("\\bibitem")) for (const e of parseBibitems(text)) entries.push({ key: e.key, fields: e.fields, bibitem: true });
    }
  }
  return { cited, entries };
}

/** Each document in the project as it is now. */
export async function scanProject(projectId: string): Promise<DocScan[]> {
  const out: DocScan[] = [];
  for (const doc of await listDocuments(projectId)) {
    const files = new Map<string, string>();
    for (const f of doc.files ?? [doc.path]) {
      if (!f.endsWith(".tex") && !f.endsWith(".bib")) continue;
      const text = await textOf(projectId, f);
      if (text !== null) files.set(f, text);
    }
    out.push({ document: doc.path, ...scanTexts(files) });
  }
  return out;
}

/** The library reference for a paper's entry. */
function refFor(refs: LibraryRef[], e: Entry) {
  return refs.find((r) => samePaper(r.fields, e.fields));
}

/**
 * Fold one observation of a project (now, or a past version) into the
 * records. `complete` marks it as the latest state: anything not seen is no
 * longer cited or listed.
 */
export function observe(records: UsageRecord[], projectId: string, scans: DocScan[], refs: LibraryRef[], at: string, complete: boolean) {
  const seen = new Set<UsageRecord>();
  for (const scan of scans) {
    for (const e of scan.entries) {
      const ref = refFor(refs, e);
      if (!ref) continue;
      let rec = records.find((r) => r.refId === ref.id && r.projectId === projectId && r.document === scan.document);
      if (!rec) {
        rec = { refId: ref.id, projectId, document: scan.document, key: e.key, citedNow: false, inBibliography: false, firstSeen: at, lastSeen: at };
        records.push(rec);
      }
      const cited = scan.cited.has(e.key);
      if (at < rec.firstSeen) rec.firstSeen = at;
      if (at >= rec.lastSeen) { rec.lastSeen = at; rec.key = e.key; }
      if (cited) {
        if (!rec.firstCited || at < rec.firstCited) rec.firstCited = at;
        if (!rec.lastCited || at > rec.lastCited) rec.lastCited = at;
      }
      if (complete) { rec.citedNow = cited; rec.inBibliography = true; }
      seen.add(rec);
    }
  }
  if (complete) {
    for (const r of records) {
      if (r.projectId === projectId && !seen.has(r)) { r.citedNow = false; r.inBibliography = false; }
    }
  }
}

/** Bring a project's records up to date, adding unseen bibliography entries to the library. */
export async function refreshUsage(projectId: string, by = "Margin") {
  const scans = await scanProject(projectId);
  let refs = (await load()).refs;
  const unknown = scans.flatMap((s) => s.entries).filter((e) => (e.fields.title || e.fields.doi) && !refFor(refs, e));
  if (unknown.length) {
    // Hand-written \bibitems carry little; fetch the full record when they have a DOI.
    const full = await enrich(unknown.map((e) => ({ key: e.key, type: e.type ?? "misc", file: e.bibitem ? "thebibliography.tex" : "references.bib", fields: e.fields })));
    await addRefs(full.map((e) => ({ key: e.key, type: e.type, fields: e.fields })), { name: by }, projectId);
    refs = (await load()).refs;
  }
  // Every reference a document lists belongs to that project's section of the library.
  const listed = new Set(scans.flatMap((s) => s.entries).map((e) => refFor(refs, e)?.id).filter(Boolean));
  if (refs.some((r) => listed.has(r.id) && !r.projects.includes(projectId))) {
    await mutateLibrary((s) => { for (const r of s.refs) if (listed.has(r.id) && !r.projects.includes(projectId)) r.projects.push(projectId); });
  }
  const needsBackfill = !(await loadUsage()).backfilled.includes(projectId);
  if (needsBackfill) await backfill(projectId, refs).catch((err) => console.error("usage backfill:", err));
  await mutate((s) => observe(s.records, projectId, scans, refs, new Date().toISOString(), true));
}

const pending = new Map<string, Promise<void>>();
/** Refresh in the background, at most one run per project at a time. */
export function refreshSoon(projectId: string, by?: string) {
  if (pending.has(projectId)) return;
  const run = refreshUsage(projectId, by).catch((err) => console.error("usage:", err)).finally(() => pending.delete(projectId));
  pending.set(projectId, run);
}

const exec = promisify(execFile);
const MAX_VERSIONS = 120;

/**
 * Replay the project's history: for a sample of past versions, which keys each
 * of today's documents cited. Files are assigned to a document when it
 * includes them today, or when they sit in its folder.
 */
async function backfill(projectId: string, refs: LibraryRef[]) {
  const dir = projectDir(projectId);
  const { stdout } = await exec("git", ["log", "--reverse", "--format=%H %cI", "--", "*.tex", "*.bib"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  const commits = stdout.trim().split("\n").filter(Boolean).map((l) => { const [hash, date] = l.split(" "); return { hash, date: new Date(date).toISOString() }; });
  const sample = commits.length <= MAX_VERSIONS ? commits
    : Array.from({ length: MAX_VERSIONS }, (_, i) => commits[Math.round((i * (commits.length - 1)) / (MAX_VERSIONS - 1))]);
  const docs = await listDocuments(projectId);
  const { mainFile } = await getProject(projectId);
  const records: UsageRecord[] = [];
  for (const { hash, date } of sample) {
    const { stdout: tree } = await exec("git", ["ls-tree", "-r", "--name-only", "-z", hash], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    const paths = tree.split("\0").filter((p) => /\.(tex|bib)$/.test(p) && !/(^|\/)(_out|Reference)\//.test(p));
    const texts = new Map<string, string>();
    for (const p of paths) {
      const { stdout: text } = await exec("git", ["show", `${hash}:${p}`], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
      texts.set(p, text);
    }
    const scans: DocScan[] = [];
    for (const doc of docs) {
      const folder = path.posix.dirname(doc.path);
      const mine = new Map([...texts].filter(([p]) => (doc.files ?? []).includes(p)
        || ((folder === "." ? !p.includes("/") || doc.path === mainFile : p.startsWith(`${folder}/`))
          && !(p.endsWith(".tex") && p !== doc.path && documentClassOf(texts.get(p) ?? "")))));
      if (mine.size) scans.push({ document: doc.path, ...scanTexts(mine) });
    }
    observe(records, projectId, scans, refs, date, false);
  }
  await mutate((s) => {
    for (const old of records) {
      const cur = s.records.find((r) => r.refId === old.refId && r.projectId === projectId && r.document === old.document);
      if (!cur) { s.records.push({ ...old, citedNow: false, inBibliography: false }); continue; }
      if (old.firstSeen < cur.firstSeen) cur.firstSeen = old.firstSeen;
      if (old.firstCited && (!cur.firstCited || old.firstCited < cur.firstCited)) cur.firstCited = old.firstCited;
      if (old.lastCited && (!cur.lastCited || old.lastCited > cur.lastCited)) cur.lastCited = old.lastCited;
    }
    if (!s.backfilled.includes(projectId)) s.backfilled.push(projectId);
  });
}

export async function usageRecords(filter: { projectIds: Set<string>; projectId?: string; document?: string; refId?: string }) {
  return (await loadUsage()).records
    .filter((r) => filter.projectIds.has(r.projectId)
      && (!filter.projectId || r.projectId === filter.projectId)
      && (!filter.document || r.document === filter.document)
      && (!filter.refId || r.refId === filter.refId))
    .map((r) => ({ ...r, status: usageStatus(r) as UsageStatus }));
}

/** Whether this project's history has been replayed yet. */
export async function isBackfilled(projectId: string) {
  return (await loadUsage()).backfilled.includes(projectId);
}
