import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError, resolvePath } from "./storage.ts";

test("resolvePath keeps paths inside the project", () => {
  assert.match(resolvePath("p-1", "sections/intro.tex"), /projects\/p-1\/sections\/intro\.tex$/);
  assert.match(resolvePath("p-1", "/main.tex"), /projects\/p-1\/main\.tex$/);
});

test("resolvePath rejects traversal and internal folders", () => {
  for (const bad of ["../x.tex", "a/../../x", ".git/config", ".margin/project.json", "", "."]) {
    assert.throws(() => resolvePath("p-1", bad), HttpError, bad);
  }
  assert.throws(() => resolvePath("../evil", "main.tex"), HttpError);
});
