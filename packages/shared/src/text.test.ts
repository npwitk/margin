import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRegion } from "./text.ts";

const apply = (s: string, d: ReturnType<typeof diffRegion>) =>
  d ? s.slice(0, d.start) + d.insert + s.slice(d.start + d.deleteCount) : s;

test("diffRegion reproduces the target string", () => {
  const cases: [string, string][] = [
    ["", "abc"], ["abc", ""], ["hello world", "hello brave world"],
    ["aaaa", "aa"], ["abcabc", "abc"], ["x\ny\nz", "x\nY\nz"], ["same", "same"],
  ];
  for (const [a, b] of cases) assert.equal(apply(a, diffRegion(a, b)), b, `${a} -> ${b}`);
});

test("diffRegion keeps the edit minimal", () => {
  assert.deepEqual(diffRegion("hello world", "hello brave world"), { start: 6, deleteCount: 0, insert: "brave " });
});

import { applyHunks, textHunks } from "./text.ts";

test("textHunks reproduces the target and splits separate changes", () => {
  const a = "line1\nline2\nline3\nline4\nline5";
  const cases = [
    a.replace("line2", "LINE2").replace("line5", "LINE5"),
    a.replace("line3\n", ""),
    a.replace("line1\n", "new0\nline1\n"),
    a + "\nline6",
    "line1\nline5",
    "",
    "totally different",
    a.replace("line2\nline3", "x\ny\nz"),
  ];
  for (const b of cases) assert.equal(applyHunks(a, textHunks(a, b)), b, JSON.stringify(b));
  assert.equal(textHunks(a, cases[0]).length, 2);
  assert.deepEqual(textHunks(a, a), []);
});
