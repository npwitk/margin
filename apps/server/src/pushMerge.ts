import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Y from "yjs";
import { ROOM, isTextPath, type Task } from "@margin/shared";
import { applyText, dropDoc, emit, liveDoc, mergeIntoLive } from "./collab.ts";
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

/** 3-way text merge with `git merge-file`. Conflicts get standard markers. */
async function merge3(ours: string, base: string, theirs: string): Promise<{ text: string; conflicts: number }> {
  const tmp = await mkdtemp(path.join(tmpdir(), "margin-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => path.join(tmp, n));
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    try {
      const { stdout } = await exec("git", ["merge-file", "-p", "-L", "live edits", "-L", "base", "-L", "pushed", o, b, t], { maxBuffer: 64 * 1024 * 1024 });
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

/** Board: per task, a pushed change wins over the base; otherwise keep the live version. */
function mergeBoard(fork: Y.Doc, base: Task[], theirs: Task[]) {
  const tasks = fork.getMap<Task>("tasks");
  const b = new Map(base.map((t) => [t.id, JSON.stringify(t)]));
  const th = new Map(theirs.map((t) => [t.id, t]));
  fork.transact(() => {
    for (const [id, task] of th) if (b.get(id) !== JSON.stringify(task)) tasks.set(id, task);
    for (const id of b.keys()) if (!th.has(id)) tasks.delete(id);
  });
}

/**
 * After a push moved the branch from `oldHead` to `newHead` (without touching
 * the working tree), bring each changed file up to date: binary files take
 * the pushed version; text files are 3-way merged with whatever collaborators
 * have typed since `oldHead`, directly into the live document if it's open.
 */
export async function mergePushed(projectId: string, oldHead: string, newHead: string) {
  const dir = projectDir(projectId);
  const changed = (await git(dir, ["diff", "--name-only", "--no-renames", "-z", oldHead, newHead]))
    .toString().split("\0").filter(Boolean);
  let conflicts = 0;

  for (const rel of changed) {
    const abs = path.join(dir, rel);
    const [baseBuf, theirsBuf] = await Promise.all([blob(dir, oldHead, rel), blob(dir, newHead, rel)]);

    if (rel === BOARD) {
      const room = liveDoc(projectId, ROOM);
      const parse = (b: Buffer | null) => { try { return (JSON.parse(b?.toString() ?? "") as { tasks: Task[] }).tasks ?? []; } catch { return []; } };
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
    const merged = await merge3(oursText, baseBuf?.toString() ?? "", theirsBuf.toString());
    conflicts += merged.conflicts;
    if (doc && state) mergeIntoLive(doc, state, (fork) => applyText(fork.getText("content"), merged.text));
    else await writeFile(abs, merged.text);
  }

  // The branch moved under the working tree; make the index match it so
  // `git status` shows only uncommitted live edits.
  await git(dir, ["read-tree", newHead]);
  emit(projectId, "filesVersion", Date.now());
  return { changed, conflicts };
}
