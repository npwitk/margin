import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listThreads } from "@margin/shared";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-tools-"));
const storage = await import("./storage.ts");
const { runTool } = await import("./ai/tools.ts");
const { agentRun, revertRun } = await import("./ai/activity.ts");
const { flushProject, withDoc } = await import("./collab.ts");

const session = { name: "Alice", agent: "Claude Code" };
const ctx = (projectId: string) => ({ projectId, session, agentName: "Claude Code", key: "ext-alice-claude-code", status() {} });

test("edit_file types into the paper when agents edit directly, and the run can be undone", async () => {
  const p = await storage.createProject("Direct", "article", "Alice");
  assert.equal(p.agentMode, "edit");
  const before = await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8");
  const line = before.split("\n").find((l) => l.includes("\\begin{document}"))!;

  const r = await runTool("edit_file", { path: "main.tex", find: line, replace: `${line}\n% checked by agent`, reason: "Mark it" }, ctx(p.id));
  assert.ok(!r.isError, r.content);
  await flushProject(p.id);
  assert.match(await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8"), /% checked by agent/);

  const made = await runTool("write_file", { path: "notes/todo.tex", content: "hello\n" }, ctx(p.id));
  assert.ok(!made.isError, made.content);
  assert.deepEqual([...agentRun(p.id, "ext-alice-claude-code")!.files].sort(), ["main.tex", "notes/todo.tex"]);

  await revertRun(p.id, "ext-alice-claude-code", { name: "Alice" });
  await flushProject(p.id);
  assert.equal(await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8"), before);
  assert.equal(await stat(path.join(storage.projectDir(p.id), "notes/todo.tex")).catch(() => null), null);
});

test("edit_file leaves a suggestion when the project is set to suggest", async () => {
  const p = await storage.createProject("Suggest", "article", "Alice");
  await storage.updateProject(p.id, { agentMode: "suggest" });
  const text = await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8");
  const line = text.split("\n").find((l) => l.includes("\\begin{document}"))!;

  const r = await runTool("edit_file", { path: "main.tex", find: line, replace: `${line} %x`, reason: "Try" }, ctx(p.id));
  assert.ok(!r.isError, r.content);
  assert.ok(r.threadId);
  const threads = await withDoc(p.id, "main.tex", session, (doc) => listThreads(doc));
  assert.equal(threads.length, 1);
  await flushProject(p.id);
  assert.equal(await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8"), text);

  const folder = await runTool("create_folder", { path: "slides" }, ctx(p.id));
  assert.ok(folder.isError);
});

test("agents can add sections and folders", async () => {
  const p = await storage.createProject("Sections", "article", "Alice");
  const f = await runTool("create_folder", { path: "figures/plots" }, ctx(p.id));
  assert.ok(!f.isError, f.content);
  const s = await runTool("add_section", { title: "Limitations" }, ctx(p.id));
  assert.ok(!s.isError, s.content);
  await flushProject(p.id);
  const main = await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8");
  assert.match(main, /\\input\{sections\/limitations\}/);
});
