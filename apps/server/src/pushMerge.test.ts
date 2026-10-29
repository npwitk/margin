import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import type { Task, TaskColumn } from "@margin/shared";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-push-"));
const { mergeBoard } = await import("./pushMerge.ts");

const task = (id: string, status: string): Task => ({ id, title: id, status, order: 1, createdBy: "A", createdAt: "t", updatedAt: "t" });
const blocked: TaskColumn = { id: "blocked", label: "Blocked", kind: "active" };

test("a pushed board brings its column changes and keeps live-only ones otherwise", () => {
  const live = new Y.Doc();
  live.getMap<Task>("tasks").set("a", task("a", "todo"));
  live.getMap<TaskColumn[]>("board").set("columns", [blocked]);
  // The push didn't touch the columns: keep the live ones.
  mergeBoard(live, { tasks: [task("a", "todo")] }, { tasks: [task("a", "blocked")] });
  assert.deepEqual(live.getMap<TaskColumn[]>("board").get("columns"), [blocked]);
  assert.equal(live.getMap<Task>("tasks").get("a")!.status, "blocked");
  // The push removed the custom columns: back to the defaults.
  mergeBoard(live, { tasks: [], columns: [blocked] }, { tasks: [] });
  assert.equal(live.getMap<TaskColumn[]>("board").get("columns"), undefined);
});

test("an overlapping push leaves both versions, labelled, and flags the file", async () => {
  const { execFileSync } = await import("node:child_process");
  const storage = await import("./storage.ts");
  const { head, mergePushed } = await import("./pushMerge.ts");
  const { withDoc } = await import("./collab.ts");
  const { recordEdit } = await import("./versions.ts");
  const { ROOM, conflictBlocks, textOf } = await import("@margin/shared");
  const p = await storage.createProject("Clash", "article", "Alice");
  const dir = storage.projectDir(p.id);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(dir, "config", "receive.denyCurrentBranch", "ignore");
  const oldHead = await head(dir);

  // Carol edits a line in her clone and pushes.
  const clone = await mkdtemp(path.join(tmpdir(), "margin-clone-"));
  git(clone, "clone", "-q", dir, ".");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const original = readFileSync(path.join(clone, "main.tex"), "utf8");
  const line = original.split("\n").find((l) => l.startsWith("\\title"))!;
  writeFileSync(path.join(clone, "main.tex"), original.replace(line, "\\title{Carol's title}"));
  git(clone, "-c", "user.name=Carol", "-c", "user.email=c@x", "commit", "-qam", "Retitle");
  git(clone, "push", "-q", "origin", "main");

  // Meanwhile Alice changed the same line live.
  await withDoc(p.id, "main.tex", { name: "Alice" }, (doc) => {
    const t = textOf(doc);
    const at = t.toString().indexOf(line);
    t.delete(at, line.length);
    t.insert(at, "\\title{Alice's title}");
  });
  recordEdit(p.id, "main.tex", "Alice");

  const r = await mergePushed(p.id, oldHead, await head(dir), "Carol");
  assert.equal(r.conflicts, 1);
  const text = await withDoc(p.id, "main.tex", { name: "Alice" }, (doc) => textOf(doc).toString());
  const [block] = conflictBlocks(text);
  assert.equal(block.oursLabel, "live edits (Alice)");
  assert.equal(block.theirsLabel, "pushed by Carol");
  assert.match(block.ours, /Alice's title/);
  assert.match(block.theirs, /Carol's title/);
  const flagged = await withDoc(p.id, ROOM, { name: "Alice" }, (doc) => doc.getMap("conflicts").get("main.tex"));
  assert.deepEqual({ ...(flagged as object), at: 0 }, { file: "main.tex", count: 1, by: "Carol (pushed from a local copy)", at: 0 });
});
