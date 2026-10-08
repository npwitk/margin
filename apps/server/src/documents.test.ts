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
