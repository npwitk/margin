import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-updates-"));
delete process.env.ANTHROPIC_API_KEY;
const storage = await import("./storage.ts");
const versions = await import("./versions.ts");
const updates = await import("./updates.ts");

test("saved versions get a summary in the feed; notes and comments sit beside them", async () => {
  const p = await storage.createProject("Feed", "article", "Alice");
  assert.equal(await updates.summarizeNow(p.id), null); // nothing since the project was made

  await writeFile(path.join(storage.projectDir(p.id), "notes.md"), "Experiment B: accuracy 71%\n");
  versions.recordEdit(p.id, "notes.md", "Alice");
  await versions.saveVersion(p.id, { message: "Add experiment notes", by: "Alice", kind: "named" });

  // Without an API key the summary is a plain list of what changed.
  const u = await updates.summarizeNow(p.id);
  assert.ok(u);
  assert.equal(u.kind, "summary");
  assert.deepEqual(u.files, ["notes.md"]);
  assert.deepEqual(u.people, ["Alice"]);
  assert.match(u.body, /Add experiment notes/);
  assert.equal(await updates.summarizeNow(p.id), null); // already covered

  const note = await updates.postNote(p.id, { name: "Prof. Lee" }, { body: "B didn't hold up; try the ablation with C instead." });
  await updates.commentOn(p.id, { name: "Alice" }, note.id, "On it");
  const feed = await updates.listUpdates(p.id);
  assert.deepEqual(feed.map((x) => x.kind), ["note", "summary"]);
  assert.equal(feed[0].comments?.[0].body, "On it");
});
