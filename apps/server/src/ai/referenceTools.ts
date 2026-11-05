import { z } from "zod";
import { byline, normDoi, parseBibtex, refTitle, refVenue, toBibtex, USAGE_LABEL, usageStatus, type LibraryRef, type UsageRecord } from "@margin/shared";
import { refreshUsage, scanProject, usageRecords } from "../citeUsage.ts";
import { listDocuments } from "../documents.ts";
import { addRefs, assertVisible, fetchPdfFor, insertIntoProject, libraryScope, load, resolveRef as resolveAny, setSummary, visibleProjects } from "../library.ts";
import { readPages, readSource, sourceFiles } from "../libraryFiles.ts";
import { importReferenceFolder } from "../referenceImport.ts";
import { getProject } from "../storage.ts";
import { fetchDoiBibtex, findByTitle } from "./citations.ts";
import type { Def, ToolContext, ToolOutcome } from "./tools.ts";

/**
 * The workspace reference library, for agents: find papers, fetch or point to
 * their PDFs, read them, keep notes, and see what each document cites.
 */

/** A reference the person behind the agent may see (guests: only their papers' references). */
const resolveRef = async (q: string, projectId: string, ctx: ToolContext) => assertVisible(await resolveAny(q, projectId), ctx.session);

const fail = (summary: string, content: string): ToolOutcome => ({ summary, content, isError: true });
const by = (ctx: ToolContext) => ctx.session.agent ? `${ctx.session.agent} (for ${ctx.session.name})` : `${ctx.agentName} (for ${ctx.session.name})`;
const REF = z.string().describe("The reference: its library key, the key this paper cites it by (e.g. ref7), a DOI, or a distinctive part of its title");

function oneLine(r: LibraryRef) {
  const marks = [r.pdf ? `PDF ${r.pdf.pages}p` : "no PDF", r.summary ? `summary: ${r.summary.status}` : "no summary"].join(", ");
  return `${r.key}: ${refTitle(r.fields)}. ${byline(r.fields)}${refVenue(r.fields) ? `, ${refVenue(r.fields)}` : ""}${r.fields.doi ? ` doi:${normDoi(r.fields.doi)}` : ""} [${marks}]`;
}

function pdfAdvice(r: LibraryRef, lookup: { found: boolean; from?: string; links: { label: string; url: string }[]; note?: string }) {
  if (lookup.found) return `Found a free copy (${lookup.from}) and attached it: ${r.pdf?.pages ?? "?"} pages. Read it with read_reference.`;
  return [
    `No free copy of “${refTitle(r.fields)}” (${r.key}).`,
    lookup.note ?? "",
    "Get it from:",
    ...lookup.links.map((l) => `- ${l.label}: ${l.url}`),
    `Then attach it: the attach_pdf tool with the downloaded file's path (e.g. ~/Downloads/paper.pdf) and ref "${r.key}", or drop the PDF on the reference in Margin's Library.`,
  ].filter(Boolean).join("\n");
}

const dateOf = (iso?: string) => iso?.slice(0, 10) ?? "?";

function usageLine(u: UsageRecord & { projectName?: string; documentTitle?: string }) {
  const status = USAGE_LABEL[usageStatus(u)];
  const when = u.citedNow ? `since ${dateOf(u.firstCited)}` : u.lastCited ? `last cited ${dateOf(u.lastCited)}` : `listed since ${dateOf(u.firstSeen)}`;
  return `${u.projectName ? `${u.projectName} › ` : ""}${u.documentTitle ?? u.document} as \\cite{${u.key}}: ${status} (${when})`;
}

export const REFERENCE_DEFS: Record<string, Def> = {
  list_references: {
    description:
      "The references this project uses, from the workspace library: each one's key in the paper, title, PDF and summary status, and per document whether it's cited, formerly cited, or only in the bibliography. " +
      "Use query to search, or scope \"library\" to search every paper the workspace has (other projects too).",
    schema: z.object({
      query: z.string().optional().describe("Words from the title, author, key, venue, tag or DOI"),
      scope: z.enum(["project", "library"]).optional().describe("project (default): references in this project. library: the whole workspace library"),
      status: z.enum(["cited", "formerly-cited", "bibliography-only", "dropped"]).optional(),
      document: z.string().optional().describe("Only this document (its .tex path, from list_documents)"),
    }),
    async run(input: { query?: string; scope?: "project" | "library"; status?: string; document?: string }, ctx) {
      ctx.status("Looking through references");
      const q = input.query?.toLowerCase().trim();
      const match = (r: LibraryRef) => !q || [r.key, refTitle(r.fields), r.fields.author, r.fields.year, refVenue(r.fields), r.fields.doi, ...(r.tags ?? [])].some((v) => v?.toLowerCase().includes(q));
      const refs = (await load()).refs;
      if (input.scope === "library") {
        const { refIds } = await libraryScope(ctx.session);
        const hits = refs.filter((r) => !refIds || refIds.has(r.id)).filter(match);
        return { summary: `Found ${hits.length} reference${hits.length === 1 ? "" : "s"} in the library`, content: hits.slice(0, 200).map(oneLine).join("\n") || "(nothing matches)" };
      }
      await refreshUsage(ctx.projectId, ctx.session.name);
      const records = (await usageRecords({ projectIds: new Set([ctx.projectId]), projectId: ctx.projectId, document: input.document }))
        .filter((u) => !input.status || u.status === input.status);
      const docs = new Map((await listDocuments(ctx.projectId)).map((d) => [d.path, d.title]));
      const lines: string[] = [];
      for (const r of refs.filter(match)) {
        const mine = records.filter((u) => u.refId === r.id);
        if (!mine.length) continue;
        lines.push(`${oneLine(r)}\n${mine.map((u) => `    ${usageLine({ ...u, documentTitle: docs.get(u.document) })}`).join("\n")}`);
      }
      return { summary: `Listed ${lines.length} reference${lines.length === 1 ? "" : "s"}`, content: lines.join("\n") || "(none match)" };
    },
  },

  get_reference: {
    description: "One reference in full: BibTeX, its summary notes, tags, whether a PDF and author source are stored, and every document (in projects you can see) that cites or cited it.",
    schema: z.object({ ref: REF }),
    async run(input: { ref: string }, ctx) {
      const r = await resolveRef(input.ref, ctx.projectId, ctx);
      const projects = await visibleProjects(ctx.session);
      const names = new Map(projects.map((p) => [p.id, p.name]));
      const usage = await usageRecords({ projectIds: new Set(names.keys()), refId: r.id });
      const source = r.hasSource ? await sourceFiles(r.id) : [];
      const parts = [
        toBibtex(r),
        `PDF: ${r.pdf ? `${r.pdf.pages} pages, added ${dateOf(r.pdf.addedAt)} by ${r.pdf.addedBy}` : "not attached (find_pdf)"}`,
        source.length ? `Author source: ${source.join(", ")}` : "",
        r.tags?.length ? `Tags: ${r.tags.join(", ")}` : "",
        r.note ? `Note: ${r.note}` : "",
        `Used in:\n${usage.map((u) => `- ${usageLine({ ...u, projectName: names.get(u.projectId) })}`).join("\n") || "- (no document yet)"}`,
        r.summary ? `Summary (${r.summary.status}${r.summary.status === "ai-draft" ? ": check the paper before quoting numbers" : ""}, ${r.summary.updatedBy}, ${dateOf(r.summary.updatedAt)}):\n${r.summary.markdown}` : "Summary: none yet (update_reference_summary)",
      ];
      return { summary: `Read ${r.key}`, content: parts.filter(Boolean).join("\n\n") };
    },
  },

  add_reference: {
    description:
      "Add a paper to the workspace library by DOI, BibTeX or title, tagged with this project, and look for a free PDF. With insert, also add it to this paper's bibliography (.bib, or the hand-written thebibliography) and get the key to \\cite. " +
      "If the paper is already in the library it is reused, not duplicated.",
    schema: z.object({
      doi: z.string().optional(),
      bibtex: z.string().optional().describe("A BibTeX entry"),
      title: z.string().optional().describe("The paper's title, when you have no DOI"),
      insert: z.boolean().optional().describe("Also add it to this paper's bibliography"),
      find_pdf: z.boolean().optional().describe("Look for a free PDF (default true)"),
    }),
    async run(input: { doi?: string; bibtex?: string; title?: string; insert?: boolean; find_pdf?: boolean }, ctx) {
      ctx.status("Adding a reference");
      let item: { key?: string; type: string; fields: Record<string, string> } | undefined;
      if (input.bibtex) {
        const [e] = parseBibtex(input.bibtex);
        if (!e) return fail("No BibTeX entry", "Couldn't read a BibTeX entry in bibtex.");
        item = { key: e.key, type: e.type, fields: e.fields };
      }
      let doi = input.doi ?? item?.fields.doi;
      if (!item && !doi && input.title) {
        const hit = await findByTitle(input.title);
        if (!hit?.doi) return fail("Not found", `No published work closely matches “${input.title}”. Check the title, or pass a DOI or BibTeX.`);
        doi = hit.doi;
      }
      if (!item && doi) {
        const { entry } = await fetchDoiBibtex(doi);
        item = { type: entry.type, fields: entry.fields };
      }
      if (!item) return fail("Nothing to add", "Pass a doi, bibtex or title.");
      const res = await addRefs([item], ctx.session, ctx.projectId);
      let ref = res.added[0] ?? res.merged[0];
      if (!ref) return fail("Not added", "The entry needs at least a title or DOI.");
      const out = [`${res.added.length ? "Added" : "Already in the library"}: ${oneLine(ref)}`];

      if (input.insert) {
        if (((await getProject(ctx.projectId)).agentMode ?? "suggest") === "suggest") {
          out.push(`Not inserted: this project is set to "Agents suggest". Propose this entry for the bibliography with propose_edit:\n${toBibtex(ref)}`);
        } else {
          const ins = await insertIntoProject(ctx.projectId, ref.id, { ...ctx.session, agent: ctx.session.agent ?? ctx.agentName });
          out.push(ins.added ? `Inserted into ${ins.file}. Cite it as \\cite{${ins.key}}.` : `Already in ${ins.file} as \\cite{${ins.key}}.`);
          if ("note" in ins && ins.note) out.push(ins.note);
        }
      }
      if (!ref.pdf && input.find_pdf !== false) {
        const lookup = await fetchPdfFor(ref, by(ctx));
        ref = lookup.ref;
        out.push(pdfAdvice(ref, lookup));
      }
      return { summary: `${res.added.length ? "Added" : "Found"} ${ref.key}`, content: out.join("\n\n") };
    },
  },

  find_pdf: {
    description: "Get a reference's PDF into the library. Tries free, legal copies (open-access locations, arXiv) and attaches one if found; otherwise says where to download it (publisher, DOI, Scholar) so the user can get it through their institution and attach it.",
    schema: z.object({ ref: REF }),
    async run(input: { ref: string }, ctx) {
      const r = await resolveRef(input.ref, ctx.projectId, ctx);
      if (r.pdf) return { summary: `${r.key} already has its PDF`, content: `${r.key} already has a ${r.pdf.pages}-page PDF. Read it with read_reference.` };
      ctx.status(`Looking for the PDF of ${r.key}`);
      const lookup = await fetchPdfFor(r, by(ctx));
      return { summary: lookup.found ? `Attached the PDF of ${r.key}` : `No free PDF for ${r.key}`, content: pdfAdvice(lookup.ref, lookup) };
    },
  },

  read_reference: {
    description:
      "Read a reference's full text (extracted from its PDF), by page range, or search inside it. Use this to check exact claims, numbers and parameters before citing them. " +
      "With source_file, read a file of the author's LaTeX source instead (get_reference lists them).",
    schema: z.object({
      ref: REF,
      pages: z.string().optional().describe("e.g. \"1-3\" or \"7\". Default: the first pages"),
      search: z.string().optional().describe("Find this phrase (case-insensitive); returns the matching passages with page numbers"),
      source_file: z.string().optional(),
    }),
    async run(input: { ref: string; pages?: string; search?: string; source_file?: string }, ctx) {
      const r = await resolveRef(input.ref, ctx.projectId, ctx);
      ctx.status(`Reading ${r.key}`);
      if (input.source_file) {
        const text = await readSource(r.id, input.source_file);
        if (text === null) return fail("No such source file", `${r.key} has no source file ${input.source_file}.`);
        return { summary: `Read ${r.key} source ${input.source_file}`, content: text.slice(0, 60_000) };
      }
      const pages = await readPages(r.id);
      if (!pages) return fail(`No PDF for ${r.key}`, `${r.key} (“${refTitle(r.fields)}”) has no PDF yet. Run find_pdf to fetch it or get download links.`);
      if (input.search) {
        const needle = input.search.toLowerCase();
        const hits: string[] = [];
        pages.forEach((text, i) => {
          const lower = text.toLowerCase();
          for (let at = lower.indexOf(needle); at >= 0 && hits.length < 30; at = lower.indexOf(needle, at + needle.length)) {
            hits.push(`p.${i + 1}: …${text.slice(Math.max(0, at - 300), at + needle.length + 300).replace(/\s+/g, " ")}…`);
          }
        });
        return { summary: `Searched ${r.key} for “${input.search}”: ${hits.length} hit${hits.length === 1 ? "" : "s"}`, content: hits.join("\n\n") || `“${input.search}” isn't in the text of ${r.key}.` };
      }
      const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(input.pages ?? "");
      let from = m ? Number(m[1]) : 1, to = m ? Number(m[2] ?? m[1]) : Math.min(pages.length, 3);
      from = Math.max(1, Math.min(from, pages.length)); to = Math.max(from, Math.min(to, pages.length));
      let out = "";
      let last = from - 1;
      for (let p = from; p <= to && out.length < 60_000; p++) { out += `\n\n=== page ${p} of ${pages.length} ===\n${pages[p - 1]}`; last = p; }
      const more = last < pages.length ? `\n\n(${pages.length - last} more page${pages.length - last === 1 ? "" : "s"}; ask for pages "${last + 1}-${Math.min(pages.length, last + 3)}")` : "";
      return { summary: `Read ${r.key} pages ${from}–${last}`, content: `${oneLine(r)}${out}${more}` };
    },
  },

  update_reference_summary: {
    description:
      "Write or replace a reference's summary notes (markdown): start with a line \"> **TL;DR.** …\", then problem, method, key results with numbers, and how it relates to this paper. " +
      "Mark it ai-draft when written from the abstract, verified when checked against the full text. The TL;DR shows when people hover the citation in the PDF.",
    schema: z.object({ ref: REF, markdown: z.string(), status: z.enum(["ai-draft", "verified"]), tags: z.array(z.string()).optional() }),
    async run(input: { ref: string; markdown: string; status: "ai-draft" | "verified"; tags?: string[] }, ctx) {
      const r = await resolveRef(input.ref, ctx.projectId, ctx);
      ctx.status(`Writing notes on ${r.key}`);
      await setSummary(r.id, input.markdown, input.status, by(ctx), input.tags);
      return { summary: `Updated the summary of ${r.key}`, content: `Saved the ${input.status} summary of ${r.key}.` };
    },
  },

  citation_report: {
    description: "What each document cites: references cited now, formerly cited (and when last), listed in the bibliography but never cited, and \\cite keys with no bibliography entry. Use before cutting or adding references.",
    schema: z.object({ document: z.string().optional().describe("Only this document (its .tex path)") }),
    async run(input: { document?: string }, ctx) {
      ctx.status("Checking citations");
      await refreshUsage(ctx.projectId, ctx.session.name);
      const [docs, scans, records, refs] = await Promise.all([
        listDocuments(ctx.projectId), scanProject(ctx.projectId),
        usageRecords({ projectIds: new Set([ctx.projectId]), projectId: ctx.projectId, document: input.document }), load().then((s) => s.refs),
      ]);
      const blocks: string[] = [];
      for (const d of docs.filter((x) => !input.document || x.path === input.document)) {
        const mine = records.filter((u) => u.document === d.path);
        const scan = scans.find((s) => s.document === d.path);
        if (!mine.length && !scan?.cited.size) continue;
        const title = (id: string) => { const r = refs.find((x) => x.id === id); return r ? `${refTitle(r.fields)} (${byline(r.fields)})` : id; };
        const group = (status: string, label: string) => {
          const list = mine.filter((u) => u.status === status).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
          return list.length ? `${label} (${list.length}):\n${list.map((u) => `- ${u.key}: ${title(u.refId)}${u.status === "formerly-cited" ? `, last cited ${dateOf(u.lastCited)}` : ""}`).join("\n")}` : "";
        };
        const known = new Set(scan?.entries.map((e) => e.key));
        const missing = [...(scan?.cited ?? [])].filter((k) => !known.has(k));
        blocks.push([
          `## ${d.title} (${d.path})`,
          group("cited", "Cited"), group("formerly-cited", "Formerly cited, still listed or removed"),
          group("bibliography-only", "In the bibliography, never cited"),
          missing.length ? `Cited but missing from the bibliography: ${missing.join(", ")}` : "",
        ].filter(Boolean).join("\n\n"));
      }
      return { summary: "Checked citations", content: blocks.join("\n\n") || "No citations in this project yet." };
    },
  },

  import_reference_folder: {
    description:
      "Move a hand-kept reference folder (e.g. Reference/papers/refNN-*/ with summary.md, paper.pdf, source/) into the workspace library, matching each paper to its bibliography entry. " +
      "Run with dry_run first and show the user the report; after a clean real run, the folder can be deleted from the project.",
    schema: z.object({ folder: z.string().optional().describe("Default: Reference"), dry_run: z.boolean().optional().describe("Default true: report only, change nothing") }),
    async run(input: { folder?: string; dry_run?: boolean }, ctx) {
      const dryRun = input.dry_run !== false;
      ctx.status(dryRun ? "Checking the reference folder" : "Importing the reference folder");
      const res = await importReferenceFolder(ctx.projectId, input.folder ?? "Reference", { ...ctx.session, agent: ctx.session.agent ?? ctx.agentName }, dryRun);
      const lines = res.items.map((i) => `- ${i.folder}${i.bibkey ? ` (\\bibitem{${i.bibkey}})` : ""}: ${i.action === "skipped" ? "SKIPPED" : i.action === "matched" ? `matches library ${i.refKey}` : dryRun ? "new to the library" : `added as ${i.refKey}`}; ${i.pdf ? "PDF" : "no PDF"}, ${i.sourceFiles} source file${i.sourceFiles === 1 ? "" : "s"}, ${i.summary ? "summary" : "no summary"}${i.notes.length ? `. ${i.notes.join("; ")}` : ""}`);
      const skipped = res.items.filter((i) => i.action === "skipped").length;
      const head = dryRun
        ? `Dry run of ${res.folder}/: ${res.items.length} papers, ${skipped} would be skipped. Nothing changed. Run again with dry_run false to import.`
        : `Imported ${res.items.length - skipped} of ${res.items.length} papers from ${res.folder}/.${skipped ? "" : ` Everything is in the library now; ${res.folder}/ can be deleted from the project (delete_path), and any notes that tell agents to maintain it should point to the library tools instead.`}`;
      return { summary: dryRun ? `Checked ${res.items.length} papers in ${res.folder}/` : `Imported ${res.items.length - skipped} papers`, content: `${head}\n\n${lines.join("\n")}` };
    },
  },
};
