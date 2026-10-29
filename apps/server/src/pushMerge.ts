import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Y from "yjs";
import { ROOM, isTextPath, type Task, type TaskColumn } from "@margin/shared";
import { applyText, dropDoc, emit, liveDoc, mergeIntoLive, noteConflict } from "./collab.ts";
import { editorsOf } from "./versions.ts";
import { projectDir } from "./storage.ts";

const exec = promisify(execFile);
const BOARD = ".margin/board.json";

async function git(dir: string, args: string[]) {
  return (await exec("git", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" })).stdout as Buffer;
}

async function blob(dir: string, rev: string, file: string): Promise<Buffer | null> {
  return git(dir, ["show", `${rev}:${file}`]).catch(() => null);
}

export async function head(dir: string) {
  return (await git(dir, ["rev-parse", "HEAD"])).toString().trim();
}

/** 3-way text merge with `git merge-file`. Conflicts get standard markers, labelled with whose each side is. */
export async function merge3(ours: string, base: string, theirs: string, labels = { ours: "live edits", theirs: "pushed" }): Promise<{ text: string; conflicts: number }> {
  const tmp = await mkdtemp(path.join(tmpdir(), "margin-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(tmp, n));
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    try {
      const { stdout } = await exec("git", ["merge-file", "-p", "-L", labels.ours, "-L", "base", "-L", labels.theirs, o, b, t], { maxBuffer: 64 * 1024 * 1024 });
      return { text: stdout, conflicts: 0 };
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      if (typeof e.code === "number" && e.code > 0 && e.stdout !== undefined) return { text: e.stdout, conflicts: e.code };
      throw err;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

interface BoardFile { tasks?: Task[]; columns?: TaskColumn[] }

/** Board: per task, a pushed change wins over the base; otherwise keep the live version. Columns: the pushed list, if it changed. */
export function mergeBoard(fork: Y.Doc, base: BoardFile, theirs: BoardFile) {
  const tasks = fork.getMap<Task>("tasks");
  const b = new Map((base.tasks ?? []).map((t) => [t.id, JSON.stringify(t)]));
  const th = new Map((theirs.tasks ?? []).map((t) => [t.id, t]));
  fork.transact(() => {
    for (const [id, task] of th) if (b.get(id) !== JSON.stringify(task)) tasks.set(id, task);
    for (const id of b.keys()) if (!th.has(id)) tasks.delete(id);
    if (JSON.stringify(base.columns ?? null) !== JSON.stringify(theirs.columns ?? null)) {
      const board = fork.getMap<TaskColumn[]>("board");
      if (theirs.columns?.length) board.set("columns", theirs.columns);
      else board.delete("columns");
    }
  });
}

/**
 * After a push moved the branch from `oldHead` to `newHead` (without touching
 * the working tree), bring each changed file up to date: binary files take
 * the pushed version; text files are 3-way merged with whatever collaborators
 * have typed since `oldHead`, directly into the live document if it's open.
 */
export async function mergePushed(projectId: string, oldHead: string, newHead: string, pusher = "someone") {
  const dir = projectDir(projectId);
  const changed = (await git(dir, ["diff", "--name-only", "--no-renames", "-z", oldHead, newHead]))
    .toString().split("\0").filter(Boolean);
  let conflicts = 0;

  for (const rel of changed) {
    const abs = path.join(dir, rel);
    const [baseBuf, theirsBuf] = await Promise.all([blob(dir, oldHead, rel), blob(dir, newHead, rel)]);

    if (rel === BOARD) {
      const room = liveDoc(projectId, ROOM);
      const parse = (b: Buffer | null): BoardFile => { try { return JSON.parse(b?.toString() ?? "") as BoardFile; } catch { return {}; } };
      if (room) mergeIntoLive(room, Y.encodeStateAsUpdate(room), (fork) => mergeBoard(fork, parse(baseBuf), parse(theirsBuf)));
      else if (theirsBuf) await writeFile(abs, theirsBuf);
      continue;
    }

    const doc = isTextPath(rel) ? liveDoc(projectId, rel) : undefined;
    const state = doc ? Y.encodeStateAsUpdate(doc) : null;
    const oursText = doc ? doc.getText("content").toString() : await readFile(abs, "utf8").catch(() => null);

    if (!theirsBuf) {
      // Deleted by the push: delete unless someone changed it since.
      if (oursText === null || oursText === (baseBuf?.toString() ?? "")) {
        await rm(abs, { force: true });
        if (doc) await dropDoc(projectId, rel);
      }
      continue;
    }
    if (!isTextPath(rel) || oursText === null) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, theirsBuf);
      continue;
    }
    const live = editorsOf(projectId, rel);
    const merged = await merge3(oursText, baseBuf?.toString() ?? "", theirsBuf.toString(), {
      ours: `live edits${live.length ? ` (${live.join(", ")})` : ""}`, theirs: `pushed by ${pusher}`,
    });
    conflicts += merged.conflicts;
    if (merged.conflicts) await noteConflict(projectId, rel, merged.conflicts, `${pusher} (pushed from a local copy)`);
    if (doc && state) mergeIntoLive(doc, state, (fork) => applyText(fork.getText("content"), merged.text));
    else await writeFile(abs, merged.text);
  }

  // The branch moved under the working tree; make the index match it so
  // `git status` shows only uncommitted live edits.
  await git(dir, ["read-tree", newHead]);
  emit(projectId, "filesVersion", Date.now());
  return { changed, conflicts };
}
