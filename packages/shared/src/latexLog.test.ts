import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatexLog, toProjectPath } from "./latexLog.ts";

const LOG = String.raw`This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024) (preloaded format=pdflatex)
(./main.tex
LaTeX2e <2023-11-01>
(/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
)
(./sections/intro.tex
./sections/intro.tex:7: Undefined control sequence.
l.7 This is \foo
                 bar.
LaTeX Warning: Citation ` + "`smith2020'" + String.raw` on page 1 undefined on input line 9.

Overfull \hbox (12.3pt too wide) in paragraph at lines 11--13
)
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing ` + "`math shift'" + String.raw` on input line 20.

)`;

test("parses file-line errors with context", () => {
  const d = parseLatexLog(LOG);
  const err = d.find((x) => x.severity === "error");
  assert.deepEqual(err, { severity: "error", file: "sections/intro.tex", line: 7, message: "Undefined control sequence. — This is \\foo" });
});

test("attributes warnings to the currently open file", () => {
  const d = parseLatexLog(LOG);
  const cite = d.find((x) => x.message.includes("smith2020"));
  assert.equal(cite?.file, "sections/intro.tex");
  assert.equal(cite?.line, 9);
  const box = d.find((x) => x.severity === "info");
  assert.equal(box?.line, 11);
  assert.equal(box?.file, "sections/intro.tex");
});

test("joins multi-line package warnings and pops back to main.tex", () => {
  const d = parseLatexLog(LOG);
  const hy = d.find((x) => x.message.startsWith("[hyperref]"));
  assert.equal(hy?.file, "main.tex");
  assert.equal(hy?.line, 20);
  assert.match(hy!.message, /removing `math shift'/);
});

test("toProjectPath strips work dir and rejects system files", () => {
  assert.equal(toProjectPath("/data/work/./a/b.tex", "/data/work"), "a/b.tex");
  assert.equal(toProjectPath("/usr/share/texmf/article.cls", "/data/work"), undefined);
});
