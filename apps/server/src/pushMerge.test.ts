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
