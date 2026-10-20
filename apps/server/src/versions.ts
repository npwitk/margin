import { stat } from "node:fs/promises";
import { isTextPath, type Checkpoint, type PendingChanges, type Session } from "@margin/shared";
import { emit, flushProject, releasePath, writeThroughCollab } from "./collab.ts";
import { checkpoint, fileAt, filesAt, history, withGitLock } from "./git.ts";
import { HttpError, deleteEntry, listFiles, projectDir, resolvePath, writeBinary } from "./storage.ts";

/**
 * Version history, like Google Docs: Margin remembers who edited which file and
 * saves a version on its own once editing goes quiet (or every half hour of
 * non-stop editing), crediting everyone involved. People can also save named
 * versions, see what each version changed, and restore a file or the whole
 * project. Restoring never loses anything: the current state is saved first,
 * and the restore itself becomes a new version.
 */

const QUIET_MS = Number(process.env.MARGIN_AUTOSAVE_QUIET_MS ?? 5 * 60_000);
const MAX_MS = Number(process.env.MARGIN_AUTOSAVE_MAX_MS ?? 30 * 60_000);

interface Pending { editors: Map<string, Set<string>>; first: number; last: number }
const pending = new Map<string, Pending>();

/** Who's credited for an edit: the person, or "Claude Code (for Alice)" for their agent. */
export const editorName = (s: Session) => (s.agent ? `${s.agent} (for ${s.name})` : s.name);

/** Called for every edit to a project file (live typing, agents, pushes). */
export function recordEdit(projectId: string, file: string, who: string) {
  const now = Date.now();
  const p = pending.get(projectId) ?? { editors: new Map(), first: now, last: now };
  p.last = now;
  if (!p.editors.has(who)) p.editors.set(who, new Set());
  p.editors.get(who)!.add(file);
  pending.set(projectId, p);
}

export function pendingChanges(projectId: string): PendingChanges | null {
  const p = pending.get(projectId);
  if (!p) return null;
  return { people: [...p.editors.keys()], files: [...new Set([...p.editors.values()].flatMap((s) => [...s]))].sort(), since: p.first };
}

const short = (files: string[]) => {
  const names = files.map((f) => f.split("/").pop()!);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more files`;
};

/**
 * Save a version of everything edited so far. With a message it's a named
 * version by `by`; without one it's an automatic version credited to whoever
 * edited most. Returns null when nothing changed.
 */
export async function saveVersion(projectId: string, opts: { message?: string; by?: string; kind?: Checkpoint["kind"] } = {}) {
  const p = pending.get(projectId);
  pending.delete(projectId);
  await flushProject(projectId);
  const editors = [...(p?.editors ?? new Map<string, Set<string>>()).entries()].sort((a, b) => b[1].size - a[1].size);
  const people = editors.map(([n]) => n);
  const files = [...new Set(editors.flatMap(([, f]) => [...f]))];
  const author = opts.by ?? people[0] ?? "Margin";
  const message = opts.message?.trim() || (files.length ? `Edited ${short(files)}` : "Saved changes");
  try {
    const cp = await withGitLock(projectId, () => checkpoint(projectDir(projectId), message, author, { coAuthors: people, kind: opts.kind ?? (opts.message ? "named" : "auto") }));
    if (cp) emit(projectId, "historyVersion", Date.now());
    return cp;
  } catch (err) {
    // Keep the edits pending so the next attempt includes them.
    if (p) pending.set(projectId, p);
    throw err;
  }
}

// Auto-save: a version after QUIET_MS without edits, or every MAX_MS while people keep typing.
const timer = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (now - p.last >= QUIET_MS || now - p.first >= MAX_MS) {
      void saveVersion(id).catch((err) => console.error(`autosave ${id}:`, err));
    }
  }
}, Math.min(60_000, QUIET_MS));
timer.unref();

/** Save every project's pending edits as versions (on shutdown). */
export async function saveAllPending() {
  await Promise.all([...pending.keys()].map((id) => saveVersion(id).catch(() => null)));
}

export const listVersions = (projectId: string, limit = 60, skip = 0) => history(projectDir(projectId), limit, skip);

/**
 * Bring back a file, or the whole project, as it was in version `hash`.
 * Saves the current state first, writes through the live documents so open
 * editors update, and records the restore as its own version.
 */
export async function restoreVersion(projectId: string, hash: string, session: Session, file?: string) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new HttpError(400, "Bad version id");
  const dir = projectDir(projectId);
  const target = (await history(dir, 400)).find((c) => c.hash.startsWith(hash));
  if (!target) throw new HttpError(404, "Version not found");
  await saveVersion(projectId, { message: `Before restoring ${file ?? "the project"}`, by: session.name, kind: "auto" });

  const then = (await filesAt(dir, target.hash)).filter((f) => !f.startsWith(".margin/"));
  const wanted = file ? then.filter((f) => f === file) : then;
  if (file && !wanted.length) throw new HttpError(404, `${file} didn't exist in that version`);

  for (const rel of wanted) {
    const data = await fileAt(dir, target.hash, rel);
    if (!data) continue;
    const exists = await stat(resolvePath(projectId, rel)).then((st) => st.isFile(), () => false);
    if (exists && isTextPath(rel)) await writeThroughCollab(projectId, rel, data.toString("utf8"), session);
    else await writeBinary(projectId, rel, data);
  }
  if (!file) {
    // Files added after that version go away (they stay in the history).
    const keep = new Set(then);
    for (const f of await listFiles(projectId)) {
      if (f.type !== "file" || keep.has(f.path)) continue;
      await releasePath(projectId, f.path);
      await deleteEntry(projectId, f.path);
    }
  }
  emit(projectId, "filesVersion", Date.now());
  const when = new Date(target.date).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const label = target.kind === "named" ? `“${target.message}”` : `the version from ${when}`;
  const cp = await saveVersion(projectId, { message: `Restored ${file ?? "the project"} to ${label}`, by: session.name, kind: "restore" });
  return { restored: wanted.length, checkpoint: cp };
}
