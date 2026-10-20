import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { changesIn, checkpoint, fileAt, filesAt, history, initRepo } from "./git.ts";

test("versions credit everyone, record their kind, and show their changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "margin-versions-"));
  await writeFile(path.join(dir, "main.tex"), "a\nb\n");
  await initRepo(dir, "Alice");
  await writeFile(path.join(dir, "main.tex"), "a\nB\nc\n");
  await writeFile(path.join(dir, "fig.png"), Buffer.from([0, 1, 2, 3]));
  const auto = await checkpoint(dir, "Edited main.tex", "Bob", { coAuthors: ["Bob", "Alice", "Claude Code (for Alice)"], kind: "auto" });
  assert.ok(auto);
  assert.equal(await checkpoint(dir, "", "Bob", { kind: "auto" }), null, "nothing changed");
  const named = await checkpoint(dir, "Sent to advisor", "Alice", { kind: "named" });
  assert.ok(named, "named versions mark the current state even without changes");

  const [n, a, first] = await history(dir);
  assert.deepEqual([n.kind, n.message, n.people], ["named", "Sent to advisor", ["Alice"]]);
  assert.deepEqual([a.kind, a.people], ["auto", ["Bob", "Alice", "Claude Code (for Alice)"]]);
  assert.deepEqual(a.files?.find((f) => f.path === "main.tex"), { path: "main.tex", additions: 2, deletions: 1 });
  assert.equal(first.kind, "other");

  const diff = await changesIn(dir, a.hash);
  const tex = diff.find((d) => d.path === "main.tex")!;
  assert.equal(tex.status, "modified");
  assert.match(tex.patch, /^-b$/m);
  assert.match(tex.patch, /^\+B$/m);
  assert.equal(diff.find((d) => d.path === "fig.png")?.binary, true);
  assert.deepEqual((await filesAt(dir, first.hash)).sort(), ["main.tex"]);
  assert.equal((await fileAt(dir, first.hash, "main.tex"))?.toString(), "a\nb\n");
});
