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

test("board tools follow the project's own columns", async () => {
  const p = await storage.createProject("Board", "article", "Alice");
  const added = await runTool("add_board_column", { label: "Blocked", kind: "active" }, ctx(p.id));
  assert.ok(!added.isError, added.content);
  assert.match(added.content, /To do → In progress → In review → Blocked → Done/);
  const made = await runTool("create_task", { title: "Run ablation" }, ctx(p.id));
  const id = made.content.match(/id ([0-9a-f]{8})/)![1];
  const moved = await runTool("update_task", { id, status: "blocked" }, ctx(p.id));
  assert.ok(!moved.isError, moved.content);
  assert.match(moved.summary, /Blocked/);
  const bad = await runTool("update_task", { id, status: "Nope" }, ctx(p.id));
  assert.ok(bad.isError);
  const list = await runTool("list_tasks", {}, ctx(p.id));
  assert.match(list.content, /Blocked \[status "blocked", in progress\]:\n- \[[0-9a-f]{8}\] Run ablation/);
  await flushProject(p.id);
  const board = JSON.parse(await readFile(path.join(storage.projectDir(p.id), ".margin/board.json"), "utf8"));
  assert.deepEqual(board.columns.map((c: { id: string }) => c.id), ["todo", "doing", "review", "blocked", "done"]);
});

test("an advisor's agent can comment and use the board but not change files", async () => {
  const access = await import("./access.ts");
  const p = await storage.createProject("Advised", "article", "Alice");
  await access.addOwner(p.id, { name: "Alice" });
  // Bob joins with an advisor invite.
  const invite = await access.createInvite(p.id, { name: "Alice" }, "advisor");
  await access.joinWithInvite(p.id, { name: "Bob" }, invite.token);
  assert.equal(await access.roleOf(p.id, { name: "Bob" }), "advisor");
  const bob = { projectId: p.id, session: { name: "Bob", agent: "Claude Code" }, agentName: "Claude Code", key: "ext-bob", status() {} };
  const text = await readFile(path.join(storage.projectDir(p.id), "main.tex"), "utf8");
  const line = text.split("\n").find((l) => l.includes("\\begin{document}"))!;
  const edit = await runTool("edit_file", { path: "main.tex", find: line, replace: `${line}%`, reason: "x" }, bob);
  assert.ok(edit.isError);
  assert.match(edit.content, /advisor/);
  const comment = await runTool("add_comment", { path: "main.tex", quote: line, message: "Is this right?" }, bob);
  assert.ok(!comment.isError, comment.content);
  const task = await runTool("create_task", { title: "Rerun experiment B" }, bob);
  assert.ok(!task.isError, task.content);
});

test("list_documents names sections, so an agent can find “SAC 2027 (Submission Version)”", async () => {
  const sections = await import("./sections.ts");
  const docs = await import("./documents.ts");
  const p = await storage.createProject("Venues", "article", "Alice");
  await sections.addProjectSection(p.id, { title: "SAC 2027 (Submission Version)" }, { name: "Alice" });
  const sac = await docs.createDocument(p.id, { title: "Federated SIEM", template: "article", path: "sac-2027-submission-version/main.tex", layout: "beside" });
  await docs.updateDocument(p.id, sac, { title: "SAC submission" });
  const r = await runTool("list_documents", {}, ctx(p.id));
  assert.match(r.content, /Section “SAC 2027 \(Submission Version\)” \(folder sac-2027-submission-version\/\):\n- sac-2027-submission-version\/main\.tex: “SAC submission” \(its \\title: “Federated SIEM”\)/);
  assert.match(r.content, /Not in a section:\n- main\.tex: .*\[default\]/);
});
