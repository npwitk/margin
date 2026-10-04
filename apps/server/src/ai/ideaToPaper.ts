import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ROOM, parseBibtex, plainTex, type Project, type Session, type Task } from "@margin/shared";
import { emit, releasePath, withDoc, writeThroughCollab } from "../collab.ts";
import { checkpoint, withGitLock } from "../git.ts";
import { createProject, getProject, projectDir, saveProject } from "../storage.ts";
import { FALLBACK, MODEL, clientFor, describeApiError } from "./client.ts";
import { addOwner } from "../access.ts";

/**
 * "Start from an idea": Claude turns a rough idea into a planned first draft
 * (title, research question, outline with section files, abstract, tasks
 * split across the group). Related work comes from real OpenAlex searches
 * and DOI metadata, never from the model's memory.
 */

const OPENALEX = process.env.OPENALEX_API_URL ?? "https://api.openalex.org";
const DOI_RESOLVER = process.env.DOI_RESOLVER_URL ?? "https://doi.org";

const Plan = z.strictObject({
  title: z.string().describe("A working title"),
  research_question: z.string(),
  summary: z.string().describe("2-3 sentences: the problem, the approach, why it matters"),
  contributions: z.array(z.string()).describe("The 2-4 contributions the paper would claim"),
  abstract: z.string().describe("A first-draft abstract (plain text, 120-200 words). Mark unknown results as placeholders like [X%]."),
  sections: z.array(z.strictObject({
    title: z.string(),
    file: z.string().describe("Short lowercase file name without extension, e.g. related-work"),
    purpose: z.string(),
    key_points: z.array(z.string()),
  })).describe("Sections after the abstract, in order"),
  search_queries: z.array(z.string()).describe("3-5 searches that would find the closest prior work"),
  tasks: z.array(z.strictObject({
    title: z.string(),
    section: z.string().describe("The section file this task belongs to, or empty"),
    assignee: z.string().describe("One of the listed members, or empty to leave unassigned"),
    notes: z.string(),
  })).describe("Concrete first tasks for the group, balanced across members"),
  risks: z.array(z.string()).describe("Open questions or risks the authors should resolve early"),
});
type PlanT = z.infer<typeof Plan>;

const SYSTEM = `You are an experienced research advisor helping a small group turn a rough idea into a plan for a paper. Be concrete and honest: sharpen the research question, say what would make the contribution credible at the target venue, and structure the paper as researchers in that field would. Don't invent results, numbers or citations; mark anything unknown as a placeholder for the authors. Split the initial work fairly between the listed members according to the sections, and include tasks for experiments or analyses the claims would need. Write in the language of the idea.`;

const tex = (s: string) => s.replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "section";

function mainTex(plan: PlanT, template: string, files: string[]) {
  const inputs = files.map((f) => `\\input{sections/${f}}`).join("\n");
  if (template === "ieee") {
    return `\\documentclass[conference]{IEEEtran}

\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{cite}
\\usepackage{hyperref}

\\begin{document}

\\title{${tex(plan.title)}}
\\author{\\IEEEauthorblockN{Authors}\\IEEEauthorblockA{Affiliation}}
\\maketitle

\\begin{abstract}
${tex(plan.abstract)}
\\end{abstract}

${inputs}

\\bibliographystyle{IEEEtran}
\\bibliography{refs/references}

\\end{document}
`;
  }
  return `\\documentclass[11pt]{article}

\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[numbers]{natbib}
\\usepackage{hyperref}

\\title{${tex(plan.title)}}
\\author{Authors}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
${tex(plan.abstract)}
\\end{abstract}

${inputs}

\\bibliographystyle{plainnat}
\\bibliography{refs/references}

\\end{document}
`;
}

function sectionTex(s: PlanT["sections"][number], file: string) {
  return `\\section{${tex(s.title)}}
\\label{sec:${file}}

% Purpose: ${s.purpose.replace(/\n/g, " ")}
% Replace the plan below with your text.
\\paragraph{Plan.}
\\begin{itemize}
${s.key_points.map((k) => `  \\item ${tex(k)}`).join("\n")}
\\end{itemize}
`;
}

interface Work { title: string; doi: string; year?: number; authors: string[]; query: string }

/** Real related work: OpenAlex search results that have a DOI. */
async function findRelatedWork(queries: string[]): Promise<Work[]> {
  const seen = new Set<string>();
  const out: Work[] = [];
  for (const query of queries.slice(0, 5)) {
    const url = `${OPENALEX}/works?${new URLSearchParams({ search: query, "per-page": "6", filter: "has_doi:true" })}`;
    const res = await fetch(url, { headers: { "user-agent": "Margin/0.1" }, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
      { results?: { display_name?: string; doi?: string; publication_year?: number; authorships?: { author?: { display_name?: string } }[] }[] } | null;
    let taken = 0;
    for (const w of res?.results ?? []) {
      const doi = w.doi?.replace(/^https?:\/\/doi\.org\//, "");
      if (!doi || !w.display_name || seen.has(doi.toLowerCase())) continue;
      seen.add(doi.toLowerCase());
      out.push({ title: w.display_name, doi, year: w.publication_year, authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean), query });
      if (++taken >= 2) break;
    }
  }
  return out.slice(0, 10);
}

async function bibtexFor(work: Work, used: Set<string>): Promise<string | null> {
  const res = await fetch(`${DOI_RESOLVER}/${work.doi}`, { headers: { accept: "application/x-bibtex", "user-agent": "Margin/0.1" }, redirect: "follow", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  const bib = (await res.text()).trim();
  const [entry] = parseBibtex(bib);
  if (!entry) return null;
  const last = (work.authors[0] ?? "ref").split(" ").pop()!.toLowerCase().replace(/[^a-z]/g, "") || "ref";
  const word = plainTex(entry.fields.title ?? work.title).toLowerCase().split(/\s+/).find((w) => w.length > 3)?.replace(/[^a-z0-9]/g, "") ?? "";
  let key = `${last}${work.year ?? ""}${word}`, n = 2;
  while (used.has(key)) key = `${last}${work.year ?? ""}${word}${n++}`;
  used.add(key);
  return bib.replace(/^(@\w+\s*\{)\s*[^,]+,/, `$1${key},`).replace(/,\s*(\w+\s*=)/g, ",\n  $1").replace(/\s*\}\s*$/, "\n}");
}

export async function startFromIdea(session: Session, input: { idea: string; goal?: string; template?: string; members?: string[] }): Promise<Project> {
  const idea = input.idea.trim();
  if (idea.length < 20) throw new Error("Describe the idea in a few sentences so Claude has something to work with.");
  const client = await clientFor(session); // fail fast without a key
  const template = input.template === "ieee" ? "ieee" : "article";
  const members = [...new Set([session.name, ...(input.members ?? []).map((m) => m.trim()).filter(Boolean)])].slice(0, 12);
  const project = await createProject(idea.split(/[.\n]/)[0].slice(0, 80) || "New paper", template, session.name);
  await addOwner(project.id, session);
  project.goal = input.goal?.trim() || undefined;
  project.setup = { status: "planning" };
  await saveProject(project);

  void (async () => {
    const id = project.id;
    const dir = projectDir(id);
    // Someone may already have these files open: write existing ones through the
    // live document (so editors merge the change) and only create new ones on disk.
    const put = async (rel: string, content: string) => {
      const abs = path.join(dir, rel);
      if (await stat(abs).then(() => true, () => false)) return writeThroughCollab(id, rel, content, session);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    };
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: betaZodOutputFormat(Plan) },
        ...FALLBACK,
        messages: [{ role: "user", content: `<idea>\n${idea}\n</idea>\n<goal>${project.goal ?? "Not decided yet - suggest a fitting venue type in the plan."}</goal>\n<members>${members.join(", ")}</members>\n<template>${template === "ieee" ? "IEEE conference (two-column)" : "Article"}</template>\n\nPlan the paper.` }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") throw new Error("Claude declined to plan this paper.");
      if (message.stop_reason === "max_tokens") throw new Error("The plan was cut off. Try again with a shorter idea.");
      const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
      const plan = Plan.parse(JSON.parse(text));

      // Section files.
      const used = new Set<string>();
      const files = plan.sections.map((s) => {
        let f = fileSlug(s.file || s.title), n = 2;
        while (used.has(f)) f = `${fileSlug(s.file || s.title)}-${n++}`;
        used.add(f);
        return f;
      });
      // Remove template sections the plan doesn't use.
      for (const name of await readdir(path.join(dir, "sections")).catch(() => [] as string[])) {
        if (name.endsWith(".tex") && !files.includes(name.slice(0, -4))) {
          await releasePath(id, `sections/${name}`);
          await rm(path.join(dir, "sections", name), { force: true });
        }
      }
      for (const [i, s] of plan.sections.entries()) await put(`sections/${files[i]}.tex`, sectionTex(s, files[i]));
      await put("main.tex", mainTex(plan, template, files));

      // Related work from OpenAlex + DOI metadata.
      const works = await findRelatedWork(plan.search_queries);
      const keys = new Set<string>();
      const bibs = (await Promise.all(works.map((w) => bibtexFor(w, keys)))).filter((b): b is string => !!b);
      await put("refs/references.bib", bibs.length ? bibs.join("\n\n") + "\n" : "% Add references here (Citations → Add by DOI).\n");
      const related = works.map((w) => `- ${w.title} (${w.authors.slice(0, 3).join(", ")}${w.authors.length > 3 ? " et al." : ""}${w.year ? `, ${w.year}` : ""}) - https://doi.org/${w.doi}  \n  _found for: ${w.query}_`).join("\n");

      await put("notes/idea.md", `# ${plan.title}

## Research question
${plan.research_question}

## Summary
${plan.summary}

## Contributions
${plan.contributions.map((c) => `- ${c}`).join("\n")}

## Open questions and risks
${plan.risks.map((r) => `- ${r}`).join("\n")}

## Related work found (OpenAlex)
${related || "_Nothing found automatically. Use Citations → Add by DOI._"}

These entries are in refs/references.bib. Check they are the right papers before citing them.

## Original idea
${idea}
`);

      // Board.
      await withDoc(id, ROOM, session, (doc) => {
        const tasks = doc.getMap<Task>("tasks");
        const now = new Date().toISOString();
        plan.tasks.forEach((t, i) => {
          const sectionIndex = plan.sections.findIndex((s) => fileSlug(s.file || s.title) === fileSlug(t.section) || s.title === t.section);
          const assignee = members.find((m) => m.toLowerCase() === t.assignee.trim().toLowerCase());
          const task: Task = {
            id: crypto.randomUUID(), title: t.title.slice(0, 200), status: "todo", order: i + 1,
            assignee, files: sectionIndex >= 0 ? [`sections/${files[sectionIndex]}.tex`] : undefined,
            notes: t.notes || undefined, createdBy: `Claude (for ${session.name})`, createdAt: now, updatedAt: now,
          };
          tasks.set(task.id, task);
        });
      });

      const p = await getProject(id);
      p.name = plan.title.slice(0, 120);
      p.setup = { status: "done" };
      await saveProject(p);
      await withGitLock(id, () => checkpoint(dir, "Plan the paper from an idea (Claude)", session.name));
      emit(id, "filesVersion", Date.now());
    } catch (err) {
      console.error("idea to paper:", err);
      const p = await getProject(id).catch(() => null);
      if (p) { p.setup = { status: "error", error: describeApiError(err) }; await saveProject(p); }
      emit(id, "filesVersion", Date.now());
    }
  })();
  return project;
}
