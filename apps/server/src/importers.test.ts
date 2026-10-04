import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, gzipSync } from "fflate";
import { detectEngine, detectMain, fromTar, fromZip, parseArxivId, safePath } from "./importers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const doc = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";

test("safePath blocks traversal and junk", () => {
  assert.equal(safePath("a/b.tex"), "a/b.tex");
  assert.equal(safePath("./a.tex"), "a.tex");
  for (const bad of ["../x", "a/../../x", "__MACOSX/a", ".git/config", "a/.DS_Store", "dir/", "._x.tex"]) assert.equal(safePath(bad), null, bad);
});

test("zip import unwraps a single root folder and skips evil paths", () => {
  const zip = zipSync({ "paper/main.tex": enc(doc), "paper/sec/a.tex": enc("x"), "paper/../../evil.tex": enc("x"), "paper/__MACOSX/._main.tex": enc("x") });
  const files = fromZip(zip);
  assert.deepEqual(files.map((f) => f.path).sort(), ["main.tex", "sec/a.tex"]);
  assert.throws(() => fromZip(enc("not a zip")), /valid \.zip/);
});

function tar(entries: Record<string, string>) {
  const blocks: Uint8Array[] = [];
  for (const [name, body] of Object.entries(entries)) {
    const h = new Uint8Array(512);
    h.set(enc(name), 0);
    h.set(enc(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    h[156] = 48;
    h.set(enc("ustar\0"), 257);
    const data = enc(body);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(h, padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

test("tar import reads files", () => {
  const files = fromTar(tar({ "ms.tex": doc, "figs/plot.txt": "data", "../escape.tex": "x" }));
  assert.deepEqual(files.map((f) => f.path), ["ms.tex", "figs/plot.txt"]);
  assert.equal(new TextDecoder().decode(files[1].data), "data");
  void gzipSync;
});

test("detects main file and engine", () => {
  const files = [
    { path: "sections/intro.tex", data: enc("\\section{Intro}") },
    { path: "appendix/standalone.tex", data: enc(doc) },
    { path: "main.tex", data: enc("\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\\end{document}") },
  ];
  assert.equal(detectMain(files), "main.tex");
  assert.equal(detectEngine(files, "main.tex"), "xelatex");
  assert.throws(() => detectMain([{ path: "a.tex", data: enc("\\section{x}") }]), /No main/);
});

test("arXiv ids", () => {
  assert.equal(parseArxivId("1706.03762"), "1706.03762");
  assert.equal(parseArxivId("https://arxiv.org/abs/2401.12345v2"), "2401.12345v2");
  assert.equal(parseArxivId("hep-th/9901001"), "hep-th/9901001");
  assert.equal(parseArxivId("hello"), null);
});
