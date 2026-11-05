import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { LibraryView, Session } from "@margin/shared";

// An invite-only workspace, where an advisor joins one paper as a guest.
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-libguests-"));
process.env.MARGIN_ADMINS = "alice";
const storage = await import("./storage.ts");
const access = await import("./access.ts");
const workspace = await import("./workspace.ts");
const { libraryRoutes } = await import("./library.ts");
const { refreshUsage } = await import("./citeUsage.ts");
const { runTool } = await import("./ai/tools.ts");
type AppEnv = import("./auth.ts").AppEnv;

const alice = { name: "Alice", github: "alice" };
const lee = { name: "Prof. Lee", github: "lee" };

const as = (s: Session) => new Hono<AppEnv>().use("*", async (c, next) => { c.set("session", s); await next(); }).route("/", libraryRoutes);

const MAIN = (title: string) => `\\documentclass{article}
\\begin{document}
Text \\cite{a}.
\\begin{thebibliography}{9}
\\bibitem{a} A. Author, \`\`${title} cited,'' \\textit{J.}, 2024.
\\bibitem{b} B. Author, \`\`${title} listed only,'' \\textit{J.}, 2025.
\\end{thebibliography}
\\end{document}
`;

test("an advisor invited to one paper sees all of that paper's references, and only those", async () => {
  const paper = await storage.createProject("Paper", "article", "Alice");
  const other = await storage.createProject("Other", "article", "Alice");
  await access.addOwner(paper.id, alice);
  await access.addOwner(other.id, alice);
  await writeFile(path.join(storage.projectDir(paper.id), "main.tex"), MAIN("Paper"));
  await writeFile(path.join(storage.projectDir(other.id), "main.tex"), MAIN("Other"));
  await refreshUsage(paper.id);
  await refreshUsage(other.id);

  const link = await access.createInvite(paper.id, alice, "advisor", true);
  const admitting = await access.admittingInvite(paper.id, link.token);
  await workspace.admitGuest({ login: "lee", name: "Prof. Lee" }, admitting!.createdBy);
  await access.joinWithInvite(paper.id, lee, link.token);

  const titles = async (s: Session) => ((await (await as(s).request("/")).json()) as LibraryView).refs.map((r) => r.fields.title).sort();
  assert.equal((await titles(alice)).length, 4);
  // Both the cited reference and the one only in the bibliography.
  assert.deepEqual(await titles(lee), ["Paper cited", "Paper listed only"]);

  const usage = await (await as(lee).request(`/usage?project=${paper.id}`)).json() as { records: { status: string }[] };
  assert.deepEqual(usage.records.map((r) => r.status).sort(), ["bibliography-only", "cited"]);
  assert.equal((await as(lee).request(`/usage?project=${other.id}`)).status, 404);

  // Read-only for guests.
  const lib = ((await (await as(alice).request("/")).json()) as LibraryView).refs;
  const mine = lib.find((r) => r.fields.title === "Paper cited")!;
  const theirs = lib.find((r) => r.fields.title === "Other cited")!;
  assert.equal((await as(lee).request(`/${mine.id}`, { method: "DELETE" })).status, 403);
  assert.equal((await as(lee).request(`/${theirs.id}/pdf`)).status, 404);
  assert.equal((await as(lee).request(`/${mine.id}/pdf`)).status, 404); // visible, just no PDF yet

  // Their agent (Claude for an advisor) gets the same view.
  const ctx = { projectId: paper.id, session: { ...lee, agent: "Claude Code" }, agentName: "Claude Code", key: "k", status() {} };
  const listed = await runTool("list_references", { scope: "library" }, ctx);
  assert.match(listed.content, /Paper listed only/);
  assert.doesNotMatch(listed.content, /Other/);
  const report = await runTool("citation_report", {}, ctx);
  assert.ok(!report.isError, report.content);
  const peek = await runTool("get_reference", { ref: theirs.key }, ctx);
  assert.ok(peek.isError);
});
