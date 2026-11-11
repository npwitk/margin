import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile } from "./latex.ts";

const hasTex = (() => { try { execFileSync("latexmk", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function project(files: Record<string, string | Buffer>) {
  const dir = await mkdtemp(path.join(tmpdir(), "margin-latex-"));
  for (const [p, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), body);
  }
  return dir;
}

test("a document in a subfolder uses shared/ files by name, and its own copy wins", { skip: !hasTex && "latexmk not installed" }, async () => {
  const dir = await project({
    "shared/sharedclass.cls": "\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{sharedclass}\\LoadClass{article}\n",
    "shared/macros.tex": "\\newcommand\\who{SHARED-MACROS}\n",
    "shared/figures/logo.png": PNG,
    "shared/refs.bib": "@article{k1, title={Shared Paper Title}, author={A. Author}, journal={J}, year={2020}}\n",
    "papers/one/main.tex": [
      "\\documentclass{sharedclass}", "\\usepackage{graphicx}", "\\input{macros}",
      "\\begin{document}", "\\who{} \\includegraphics[width=1cm]{figures/logo.png} \\cite{k1}",
      "\\bibliographystyle{plain}", "\\bibliography{refs}", "\\end{document}", "",
    ].join("\n"),
    // Its own macros.tex shadows the shared one.
    "two/macros.tex": "\\newcommand\\who{LOCAL-MACROS}\n",
    "two/main.tex": "\\documentclass{article}\\input{macros}\\begin{document}\\who\\end{document}\n",
  });
  try {
    const one = await compile(dir, "papers/one/main.tex", "pdflatex");
    assert.ok(one.ok, one.diagnostics.map((d) => d.message).join("\n"));
    const text = execFileSync("pdftotext", [path.join(dir, "papers/one/_out/main.pdf"), "-"]).toString();
    assert.match(text, /SHARED-MACROS/);
    assert.match(text, /Shared paper title/i);
    assert.match(await readFile(path.join(dir, "papers/one/_out/main.log"), "utf8"), /logo\.png/);

    const two = await compile(dir, "two/main.tex", "pdflatex");
    assert.ok(two.ok);
    assert.match(execFileSync("pdftotext", [path.join(dir, "two/_out/main.pdf"), "-"]).toString(), /LOCAL-MACROS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
