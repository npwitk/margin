import { test } from "node:test";
import assert from "node:assert/strict";
import { svgSize } from "./svg.ts";

test("svgSize reads the figure size in bp like librsvg", () => {
  assert.deepEqual(svgSize('<svg xmlns="x" width="400" height="200">'), [300, 150]);
  assert.deepEqual(svgSize('<svg width="400px" height="2in">'), [300, 144]);
  assert.deepEqual(svgSize('<svg viewBox="0 0 800 600">'), [600, 450]);
  assert.deepEqual(svgSize('<svg width="100%" height="100%" viewBox="0 0 800 600">'), [600, 450]);
  assert.deepEqual(svgSize('<svg width="210mm" viewBox="0 0 210 297">')?.map(Math.round), [595, 842]);
  assert.equal(svgSize("<html>"), null);
});
