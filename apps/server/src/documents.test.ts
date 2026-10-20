import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { documentClassOf, documentTitleOf } from "@margin/shared";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-docs-"));
const storage = await import("./storage.ts");
const docs = await import("./documents.ts");

test("documentClassOf / documentTitleOf", () => {
  assert.equal(documentClassOf("% \\documentclass{x}\n\\documentclass[11pt]{beamer}"), "beamer");
  assert.equal(documentClassOf("\\section{Intro} % \\documentclass{x}"), null);
  assert.equal(documentTitleOf("\\title{Fast \\textbf{SSE}\\\\ for logs}"), "Fast SSE for logs");
});

test("several documents in one project", async () => {
  const p = await storage.createProject("Multi", "article", "Tester");
  const dir = storage.projectDir(p.id);
  // A fragment (no \documentclass) and build output are not documents.
  await writeFile(path.join(dir, "sections", "frag.tex"), "\\section{x}\n");
  await mkdir(path.join(dir, "_out"), { recursive: true });
  await writeFile(path.join(dir, "_out", "junk.tex"), "\\documentclass{article}\n");

  let list = await docs.listDocuments(p.id);
  assert.deepEqual(list.map((d) => d.path), ["main.tex"]);
  assert.ok(list[0].isDefault);

  const slides = await docs.createDocument(p.id, { title: "Conference talk", template: "beamer" });
  assert.equal(slides, "conference-talk.tex");
  const again = await docs.createDocument(p.id, { title: "Conference talk", template: "beamer" });
  assert.equal(again, "conference-talk-2.tex", "doesn't overwrite");
  const text = await storage.readText(p.id, slides);
  assert.match(text.content, /\\documentclass\{beamer\}/);
  assert.match(text.content, /\\bibliography\{refs\/references\}/, "reuses the project's .bib");

  list = await docs.listDocuments(p.id);
  assert.deepEqual(list.map((d) => [d.path, d.docClass, d.title]), [
    ["main.tex", "article", "Multi"], ["conference-talk-2.tex", "beamer", "Conference talk"], ["conference-talk.tex", "beamer", "Conference talk"],
  ]);

  await docs.updateDocument(p.id, slides, { engine: "xelatex" });
  assert.equal((await docs.resolveDocument(p.id, slides)).engine, "xelatex");
  assert.equal((await docs.resolveDocument(p.id)).path, "main.tex");
  await assert.rejects(docs.resolveDocument(p.id, "nope.tex"));
  await assert.rejects(docs.resolveDocument(p.id, "../x.tex"));

  await docs.renameDocuments(p.id, (x) => (x === slides ? "talk.tex" : x));
  assert.equal((await storage.getProject(p.id)).documents?.[0].path, "talk.tex");
  await docs.renameDocuments(p.id, (x) => (x === "talk.tex" ? null : x));
  assert.equal((await storage.getProject(p.id)).documents, undefined);

  await assert.rejects(docs.createDocument(p.id, { title: "x", content: "no class here" }));
  const made = await docs.createDocument(p.id, { title: "Rebuttal", path: "letters/rebuttal", content: "\\documentclass{letter}\n\\begin{document}\\end{document}" });
  assert.equal(made, "letters/rebuttal.tex");
  await assert.rejects(docs.createDocument(p.id, { title: "x", path: "letters/rebuttal.tex", content: "\\documentclass{article}" }), /already exists/);
});

test("documentFiles follows inputs, figures, bib and local classes", async () => {
  const p = await storage.createProject("Deps", "blank", "Tester");
  const dir = storage.projectDir(p.id);
  const put = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), text); };
  await put("paper/main.tex", [
    "\\documentclass{mycls}", "\\usepackage{macros}", "\\graphicspath{{figures/}}", "\\begin{document}",
    "\\input{sections/intro}", "% \\input{sections/old}", "\\includegraphics[width=3cm]{arch}", "\\includesvg{flow}",
    "\\bibliography{refs,extra}", "\\end{document}",
  ].join("\n"));
  await put("paper/mycls.cls", "");
  await put("paper/macros.sty", "");
  await put("paper/sections/intro.tex", "\\input{sections/detail}\n\\lstinputlisting{code/run.py}");
  await put("paper/sections/detail.tex", "x");
  await put("paper/sections/old.tex", "x");
  await put("paper/figures/arch.pdf", "x");
  await put("paper/figures/flow.svg", "<svg/>");
  await put("paper/refs.bib", "");
  await put("paper/code/run.py", "");
  await put("paper/notes.md", "");
  const all = new Set((await storage.listFiles(p.id)).filter((f) => f.type === "file").map((f) => f.path));
  const deps = (await docs.documentFiles(p.id, "paper/main.tex", all)).sort();
  assert.deepEqual(deps, [
    "paper/code/run.py", "paper/figures/arch.pdf", "paper/figures/flow.svg", "paper/macros.sty", "paper/main.tex",
    "paper/mycls.cls", "paper/refs.bib", "paper/sections/detail.tex", "paper/sections/intro.tex",
  ]);
});

test("documents in their own folders, copies, new sections and archiving", async () => {
  const p = await storage.createProject("Folders", "article", "Tester");
  const session = { name: "Tester" };
  // A fresh, self-contained document folder.
  const journal = await docs.createDocument(p.id, { title: "Journal version", template: "article", layout: "folder" });
  assert.equal(journal, "journal-version/main.tex");
  const main = (await storage.readText(p.id, journal)).content;
  assert.match(main, /\\input\{sections\/introduction\}/);
  assert.match(main, /\\bibliography\{refs\}/);
  for (const f of ["journal-version/sections/introduction.tex", "journal-version/refs.bib"]) assert.ok((await storage.readText(p.id, f)).content);
  // A copy of it: whole folder, unique name.
  const copy = await docs.createDocument(p.id, { title: "Journal v2", copyFrom: journal });
  assert.equal(copy, "journal-v2/main.tex");
  assert.ok((await storage.readText(p.id, "journal-v2/sections/introduction.tex")).content);
  assert.equal((await docs.resolveDocument(p.id, copy)).path, copy);
  const again = await docs.createDocument(p.id, { title: "Journal v2", copyFrom: journal });
  assert.equal(again, "journal-v2-2/main.tex");
  // Archive a document, and the default can't be archived.
  await docs.updateDocument(p.id, again, { archived: true });
  const list = await docs.listDocuments(p.id);
  assert.equal(list.find((d) => d.path === again)?.archived, true);
  assert.equal(list.find((d) => d.path === copy)?.archived, false);
  await assert.rejects(docs.updateDocument(p.id, "main.tex", { archived: true }), /default document/);
  await docs.updateDocument(p.id, again, { archived: false });
  assert.equal((await docs.listDocuments(p.id)).find((d) => d.path === again)?.archived, false);
  void session;
});
