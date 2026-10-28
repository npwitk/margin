import { test } from "node:test";
import assert from "node:assert/strict";
import { numberOutline, outlineTitle, parseOutline, scanOutline } from "./outline.ts";

const brief = (text: string) => parseOutline(text, "main.tex").map((e) => [e.number ?? "", e.title, e.line]);

test("sections are numbered like the article class", () => {
  const tex = [
    "\\section{Introduction}",
    "\\subsection{Motivation}",
    "\\subsection{Contributions}",
    "\\subsubsection{Deep}",
    "\\section*{Acknowledgements}",
    "\\section{Method}",
    "\\subsection{Setup}",
    "\\paragraph{Note}",
  ].join("\n");
  assert.deepEqual(brief(tex), [
    ["1", "Introduction", 1], ["1.1", "Motivation", 2], ["1.2", "Contributions", 3], ["1.2.1", "Deep", 4],
    ["", "Acknowledgements", 5], ["2", "Method", 6], ["2.1", "Setup", 7], ["", "Note", 8],
  ]);
});

test("chapters lead the numbers; appendix counts with letters", () => {
  const tex = "\\part{Background}\n\\chapter{Intro}\n\\section{A}\n\\chapter{Two}\n\\appendix\n\\chapter{Proofs}\n\\section{Lemma}";
  assert.deepEqual(brief(tex).map((e) => e[0]), ["Part I", "1", "1.1", "2", "A", "A.1"]);
  const art = "\\section{One}\n\\appendix\n\\section{Extra}\n\\subsection{More}";
  assert.deepEqual(brief(art).map((e) => e[0]), ["1", "A", "A.1"]);
});

test("comments, definitions and short titles", () => {
  const tex = "% \\section{Hidden}\n\\renewcommand{\\section}{x}\n\\section[Short]{A \\emph{long} title\\label{sec:x}}\n100\\% done \\section{Real} % \\section{no}";
  assert.deepEqual(brief(tex), [["1", "A long title", 3], ["2", "Real", 4]]);
});

test("titles keep math, unwrap commands and span lines", () => {
  assert.equal(outlineTitle("Bounds on $\\epsilon$-DP~\\cite{x} \\textbf{for \\emph{all}}"), "Bounds on $\\epsilon$-DP for all");
  assert.equal(outlineTitle("Q\\&A \\\\ second line"), "Q&A second line");
  assert.deepEqual(brief("\\section{Two\nlines}\n\\section{Next}"), [["1", "Two lines", 1], ["2", "Next", 3]]);
});

test("beamer frames and includes", () => {
  const tex = "\\section{Intro}\n\\begin{frame}{Why}\n\\end{frame}\n\\begin{frame}[fragile]\n\\frametitle{How}\n\\end{frame}\n\\begin{frame}\\titlepage\\end{frame}\n\\input{sections/method}";
  const tokens = scanOutline(tex, "slides.tex");
  assert.deepEqual(tokens.map((t) => t.type === "heading" ? `${t.entry.kind}:${t.entry.title}@${t.entry.line}` : t.type === "include" ? `include:${t.target}` : t.type),
    ["section:Intro@1", "frame:Why@2", "frame:How@4", "include:sections/method"]);
  assert.deepEqual(numberOutline(tokens).map((e) => e.number ?? ""), ["1", "", ""]);
});
