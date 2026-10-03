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
