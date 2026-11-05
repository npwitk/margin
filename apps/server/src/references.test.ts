import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkProxy, citeLabels, parseBibcite, summaryTldr, usageStatus, viaProxy } from "@margin/shared";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-refs-"));
// No network in tests: the open-access lookups find nothing.
process.env.OPENALEX_API_URL = "http://127.0.0.1:9";
process.env.ARXIV_URL = "http://127.0.0.1:9";
const storage = await import("./storage.ts");
const { runTool, agentToolList } = await import("./ai/tools.ts");
const { flushProject } = await import("./collab.ts");
const { refreshUsage, usageRecords, observe } = await import("./citeUsage.ts");
const { citeMap, load } = await import("./library.ts");
const { pdfPathOf } = await import("./documents.ts");
const { fieldsFromFrontMatter } = await import("./referenceImport.ts");
const { findPdf } = await import("./libraryFiles.ts");

const session = { name: "Alice", agent: "Claude Code" };
const ctx = (projectId: string) => ({ projectId, session, agentName: "Claude Code", key: "ext-alice", status() {} });

/** A one-page PDF whose text is `text`, with a correct xref table. */
function tinyPdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const MAIN = (cites: string) => `\\documentclass{article}
\\begin{document}
Logs ${cites}.
\\begin{thebibliography}{9}
\\bibitem{ref1} A. Smith, \`\`Searchable encryption for logs,'' \\textit{J. Sec.}, 2024.
\\bibitem{ref2} B. Jones and C. Lee, \`\`Homomorphic intrusion detection,'' \\textit{JISA}, 2025.
\\bibitem{ref3} D. Kim, \`\`Verifiable storage on IPFS,'' \\textit{Computing}, 2025.
\\end{thebibliography}
\\end{document}
`;

test("aux labels, printed citations and TL;DR lines", () => {
  assert.deepEqual(parseBibcite("\\relax\n\\bibcite{ref7}{4}\n\\bibcite{vaswani2017}{{1}{2017}{{Vaswani et~al.}}{{Vaswani, Shazeer}}}\n"), [
    { key: "ref7", label: "4" },
    { key: "vaswani2017", label: "1", authorYear: "Vaswani et al., 2017" },
  ]);
  assert.deepEqual(citeLabels("[3, 7]"), ["3", "7"]);
  assert.deepEqual(citeLabels("[2]–[5]"), ["2", "3", "4", "5"]);
  assert.deepEqual(citeLabels("[2-4, 9]"), ["2", "3", "4", "9"]);
  assert.deepEqual(citeLabels("(4)"), ["4"]);
  assert.equal(summaryTldr("# [7] Title\n\n> **TL;DR.** Field-level AES-GCM on logs.\n\n## Problem"), "Field-level AES-GCM on logs.");
  assert.equal(summaryTldr("# T\n\nFirst paragraph here.\n"), "First paragraph here.");
});

test("usage status: cited, formerly cited, bibliography only", () => {
  assert.equal(usageStatus({ citedNow: true, inBibliography: true }), "cited");
  assert.equal(usageStatus({ citedNow: false, inBibliography: true, lastCited: "2026-01-01" }), "formerly-cited");
  assert.equal(usageStatus({ citedNow: false, inBibliography: true }), "bibliography-only");
  assert.equal(usageStatus({ citedNow: false, inBibliography: false }), "dropped");

  const records: Parameters<typeof observe>[0] = [];
  const refs = [{ id: "a", key: "smith", type: "article", fields: { title: "X" }, projects: [], addedBy: "", addedAt: "", updatedAt: "" }];
  const scan = (cited: string[]) => [{ document: "main.tex", cited: new Set(cited), entries: [{ key: "ref1", fields: { title: "X" } }] }];
  observe(records, "p", scan(["ref1"]), refs, "2026-01-01T00:00:00.000Z", false);
  observe(records, "p", scan([]), refs, "2026-03-01T00:00:00.000Z", true);
  assert.equal(records.length, 1);
  assert.equal(records[0].firstCited, "2026-01-01T00:00:00.000Z");
  assert.equal(usageStatus(records[0]), "formerly-cited");
});

test("front matter becomes BibTeX fields", () => {
  assert.deepEqual(fieldsFromFrontMatter({ title: "Selective Encryption", authors: "J. Ji, Y. Song, G. Cho", venue: "JISA", year: 2026, doi: "10.1016/j.jisa.2026.104550" }), {
    author: "J. Ji and Y. Song and G. Cho", title: "Selective Encryption", journal: "JISA", year: "2026", doi: "10.1016/j.jisa.2026.104550",
  });
});

test("a project's references: import a Reference/ folder, read, summarise, track citations, hover map", async () => {
  const p = await storage.createProject("SIEM", "article", "Alice");
  const dir = storage.projectDir(p.id);
  await writeFile(path.join(dir, "main.tex"), MAIN("\\cite{ref1,ref2}"));
  const paper = path.join(dir, "Reference/papers/ref02-he-ids");
  await mkdir(path.join(paper, "source"), { recursive: true });
  await writeFile(path.join(paper, "summary.md"), "---\nid: ref02\nbibkey: ref2\ntitle: \"Homomorphic intrusion detection\"\nauthors: \"B. Jones, C. Lee\"\nyear: 2025\ntags: [he, ids]\nsummary_status: verified (Alice, 2026-10-01)\n---\n\n# [2] Homomorphic intrusion detection\n\n> **TL;DR.** CKKS over flow features.\n");
  await writeFile(path.join(paper, "paper.pdf"), tinyPdf("CKKS ciphertexts take 41 ms per flow"));
  await writeFile(path.join(paper, "source/main.tex"), "\\section{Intro}");

  // Every listed reference lands in the library on the first refresh.
  await refreshUsage(p.id, "Alice");
  assert.equal((await load()).refs.length, 3);

  const dry = await runTool("import_reference_folder", {}, ctx(p.id));
  assert.ok(!dry.isError, dry.content);
  assert.match(dry.content, /Dry run/);
  assert.ok(!(await load()).refs.some((r) => r.pdf));

  const real = await runTool("import_reference_folder", { dry_run: false }, ctx(p.id));
  assert.ok(!real.isError, real.content);
  assert.match(real.content, /Imported 1 of 1/);
  const ref2 = (await load()).refs.find((r) => r.fields.title?.includes("Homomorphic"))!;
  assert.equal(ref2.pdf?.pages, 1);
  assert.equal(ref2.summary?.status, "verified");
  assert.deepEqual(ref2.tags, ["he", "ids"]);
  assert.ok(ref2.hasSource);

  // Agents can find it by the key the paper uses.
  const read = await runTool("read_reference", { ref: "ref2" }, ctx(p.id));
  assert.match(read.content, /41 ms per flow/);
  const search = await runTool("read_reference", { ref: "ref2", search: "ciphertexts" }, ctx(p.id));
  assert.match(search.content, /p\.1:/);
  const src = await runTool("read_reference", { ref: "ref2", source_file: "main.tex" }, ctx(p.id));
  assert.equal(src.content, "\\section{Intro}");

  const sum = await runTool("update_reference_summary", { ref: "ref1", markdown: "> **TL;DR.** SSE for logs.", status: "ai-draft" }, ctx(p.id));
  assert.ok(!sum.isError, sum.content);

  // Stop citing ref2: it becomes "formerly cited"; ref3 was never cited.
  await writeFile(path.join(dir, "main.tex"), MAIN("\\cite{ref1}"));
  await flushProject(p.id);
  const report = await runTool("citation_report", {}, ctx(p.id));
  assert.match(report.content, /Cited \(1\):\n- ref1/);
  assert.match(report.content, /Formerly cited[^\n]*\n- ref2/);
  assert.match(report.content, /never cited \(1\):\n- ref3/);
  const rec = (await usageRecords({ projectIds: new Set([p.id]), projectId: p.id })).find((u) => u.key === "ref2")!;
  assert.equal(rec.status, "formerly-cited");

  const list = await runTool("list_references", { status: "formerly-cited" }, ctx(p.id));
  assert.match(list.content, /Homomorphic intrusion detection/);
  assert.doesNotMatch(list.content, /Searchable encryption/);

  // Hover cards: printed numbers from the .aux, joined to the library.
  const aux = pdfPathOf(p.id, "main.tex").replace(/\.pdf$/, ".aux");
  await mkdir(path.dirname(aux), { recursive: true });
  await writeFile(aux, "\\bibcite{ref1}{1}\n\\bibcite{ref2}{2}\n");
  const cards = await citeMap(p.id, "main.tex");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].tldr, "SSE for logs.");
  assert.equal(cards[1].title, "Homomorphic intrusion detection");
  assert.ok(cards[1].hasPdf);
});

test("the reference tools are offered to agents", () => {
  const names = agentToolList().map((t) => t.name);
  for (const n of ["list_references", "get_reference", "add_reference", "find_pdf", "read_reference", "update_reference_summary", "citation_report", "import_reference_folder"]) assert.ok(names.includes(n), n);
});

test("paywalled papers: a link through the university library's proxy comes first", async () => {
  assert.equal(viaProxy("https://ezproxy.tu.ac.th/login?url=", "https://doi.org/10.1/x"), "https://ezproxy.tu.ac.th/login?url=https://doi.org/10.1/x");
  assert.equal(viaProxy("https://go.openathens.net/redirector/tu.ac.th?url={url}", "https://doi.org/10.1/x"), "https://go.openathens.net/redirector/tu.ac.th?url=https%3A%2F%2Fdoi.org%2F10.1%2Fx");
  assert.equal(viaProxy(undefined, "https://doi.org/10.1/x"), undefined);
  assert.ok(checkProxy("ezproxy.tu.ac.th").error);
  assert.deepEqual(checkProxy(""), {});

  const ref = { fields: { title: "Verifiable storage", doi: "10.1007/s00607-025-01500-1" } };
  const plain = await findPdf(ref);
  assert.equal(plain.found, false);
  assert.equal(plain.links[0].label, "Publisher (via DOI)");
  assert.match(plain.note!, /university's access/);
  assert.doesNotMatch(plain.note!, /sign in to the publisher/);

  const proxied = await findPdf(ref, "https://ezproxy.tu.ac.th/login?url=");
  assert.deepEqual(proxied.links[0], { label: "Through your university library", url: "https://ezproxy.tu.ac.th/login?url=https://doi.org/10.1007/s00607-025-01500-1" });
  assert.match(proxied.note!, /through your university library/);
});
