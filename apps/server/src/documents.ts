import { stat } from "node:fs/promises";
import path from "node:path";
import {
  DOCUMENT_TEMPLATES, documentClassOf, documentTitleOf,
  type DocumentInfo, type DocumentSettings, type DocumentTemplate, type Engine, type Project,
} from "@margin/shared";
import { textFiles, textOf } from "./ai/paper.ts";
import { HttpError, getProject, resolvePath, saveProject, workDir, writeText } from "./storage.ts";

/**
 * A project can hold several LaTeX documents: the paper, slides, a cover
 * letter, a poster… A document is any .tex file with a \documentclass (found
 * by scanning, so files that agents or git pushes add show up by themselves).
 * Project.mainFile is the default; Project.documents keeps per-document
 * settings such as the engine.
 */

const SKIP = /(^|\/)(_out|reviews|node_modules)(\/|$)/;
const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];

export const pdfPathOf = (id: string, doc: string) =>
  path.join(workDir(id), path.posix.dirname(doc), "_out", `${path.posix.basename(doc, ".tex")}.pdf`);

const settingsOf = (p: Project, doc: string): DocumentSettings | undefined => p.documents?.find((d) => d.path === doc);

export async function listDocuments(projectId: string): Promise<DocumentInfo[]> {
  const project = await getProject(projectId);
  const files = (await textFiles(projectId)).filter((f) => f.path.endsWith(".tex") && !SKIP.test(f.path));
  const docs: DocumentInfo[] = [];
  for (const f of files) {
    const text = (await textOf(projectId, f.path)) ?? "";
    const cls = documentClassOf(text);
    if (!cls && f.path !== project.mainFile) continue;
    const s = settingsOf(project, f.path);
    docs.push({
      path: f.path,
      title: s?.title || documentTitleOf(text) || path.posix.basename(f.path, ".tex"),
      engine: s?.engine ?? project.engine,
      isDefault: f.path === project.mainFile,
      hasPdf: await stat(pdfPathOf(projectId, f.path)).then(() => true, () => false),
      docClass: cls ?? undefined,
    });
  }
  // Default first, then by folder and name.
  return docs.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.path.localeCompare(b.path));
}

/** Which document to compile/show, and with which engine. Falls back to the default document. */
export async function resolveDocument(projectId: string, doc?: string | null): Promise<{ path: string; engine: Engine }> {
  const project = await getProject(projectId);
  const target = doc?.trim() || project.mainFile;
  if (!target.endsWith(".tex")) throw new HttpError(400, "A document must be a .tex file");
  resolvePath(projectId, target); // refuses escapes and hidden folders
  if (target !== project.mainFile) {
    const text = await textOf(projectId, target);
    if (text === null) throw new HttpError(404, `No such document: ${target}`);
  }
  return { path: target, engine: settingsOf(project, target)?.engine ?? project.engine };
}

/** Change a document's engine or title, or make it the default. */
export async function updateDocument(projectId: string, doc: string, patch: { engine?: Engine; title?: string; makeDefault?: boolean }) {
  const { path: target } = await resolveDocument(projectId, doc);
  const p = await getProject(projectId);
  const list = (p.documents ?? []).filter((d) => d.path !== target);
  const cur = { ...settingsOf(p, target), path: target };
  if (patch.engine !== undefined) {
    if (!ENGINES.includes(patch.engine)) throw new HttpError(400, "Unknown engine");
    cur.engine = patch.engine;
  }
  if (patch.title !== undefined) cur.title = patch.title.trim().slice(0, 120) || undefined;
  if (patch.makeDefault) {
    // The project-wide engine follows the default document, for older clients.
    if (cur.engine) p.engine = cur.engine;
    p.mainFile = target;
  }
  if (cur.engine || cur.title) list.push(cur);
  p.documents = list.length ? list : undefined;
  p.updatedAt = new Date().toISOString();
  await saveProject(p);
  return p;
}

/** Keep per-document settings in step when files are renamed or deleted. */
export async function renameDocuments(projectId: string, moved: (p: string) => string | null) {
  const p = await getProject(projectId);
  if (!p.documents?.length) return;
  const next = p.documents.flatMap((d) => { const to = moved(d.path); return to ? [{ ...d, path: to }] : []; });
  if (JSON.stringify(next) === JSON.stringify(p.documents)) return;
  p.documents = next.length ? next : undefined;
  await saveProject(p);
}

// ── New documents ───────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[\\{}$&#^_%~]/g, (ch) => `\\${ch}`);

/** Project resources a new document next to `dir` can use (LaTeX can't read ../ paths in the sandbox). */
async function resources(projectId: string, dir: string) {
  const files = (await textFiles(projectId)).map((f) => f.path).filter((f) => !SKIP.test(f));
  const inDir = (f: string) => dir === "." || f.startsWith(`${dir}/`);
  const rel = (f: string) => path.posix.relative(dir, f);
  const bibs = files.filter((f) => f.endsWith(".bib") && inDir(f)).map((f) => rel(f).replace(/\.bib$/, ""));
  const macros = files.filter((f) => inDir(f) && /(^|\/)(macros|preamble|defs|commands|shortcuts)\.(tex|sty)$/i.test(f)).map(rel);
  return { bibs, macros };
}

function templateText(template: DocumentTemplate, title: string, r: { bibs: string[]; macros: string[] }) {
  const t = esc(title);
  const macros = r.macros.map((m) => (m.endsWith(".sty") ? `\\usepackage{${m.replace(/\.sty$/, "")}}` : `\\input{${m.replace(/\.tex$/, "")}}`)).join("\n");
  const bib = r.bibs.length ? `\n\\bibliographystyle{plainnat}\n\\bibliography{${r.bibs.join(",")}}\n` : "";
  const shared = macros ? `\n% Shared with the rest of the project\n${macros}\n` : "";
  switch (template) {
    case "beamer":
      return `\\documentclass{beamer}
\\usetheme{Madrid}
\\usepackage{graphicx}
\\usepackage[numbers]{natbib}
${shared}
\\title{${t}}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{frame}{Motivation}
  \\begin{itemize}
    \\item The problem, in one line
    \\item Why it matters
  \\end{itemize}
\\end{frame}

\\begin{frame}{Approach}
  What we did.
\\end{frame}

\\begin{frame}{Results}
  What we found.
\\end{frame}
${r.bibs.length ? `
\\begin{frame}[allowframebreaks]{References}
  \\bibliographystyle{plainnat}
  \\bibliography{${r.bibs.join(",")}}
\\end{frame}
` : ""}
\\end{document}
`;
    case "letter":
      return `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}
\\usepackage[numbers]{natbib}
${shared}
\\signature{Your Name}
\\address{Department \\\\ University}

\\begin{document}

\\begin{letter}{Editor \\\\ Venue}

% ${t}
\\opening{Dear Editor,}

Thank you for considering our manuscript. We summarise its contributions and respond to the reviewers' comments below.

\\closing{Sincerely,}

\\end{letter}
${bib}
\\end{document}
`;
    case "poster":
      return `\\documentclass[25pt, a0paper, portrait]{tikzposter}
\\usepackage{graphicx}
\\usepackage[numbers]{natbib}
${shared}
\\title{${t}}
\\author{Your Name}
\\institute{University}
\\usetheme{Simple}

\\begin{document}
\\maketitle

\\begin{columns}
  \\column{0.5}
  \\block{Motivation}{The problem and why it matters.}
  \\block{Method}{What we did.}
  \\column{0.5}
  \\block{Results}{What we found.}
  \\block{Conclusion}{The takeaway.}
\\end{columns}

\\end{document}
`;
    case "ieee":
      return `\\documentclass[conference]{IEEEtran}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{cite}
${shared}
\\title{${t}}
\\author{\\IEEEauthorblockN{Your Name}\\IEEEauthorblockA{University}}

\\begin{document}
\\maketitle

\\begin{abstract}
One paragraph: the problem, what you did, what you found, and why it matters.
\\end{abstract}

\\section{Introduction}
${r.bibs.length ? `\n\\bibliographystyle{IEEEtran}\n\\bibliography{${r.bibs.join(",")}}\n` : ""}
\\end{document}
`;
    case "blank":
      return `\\documentclass{article}
${shared}
\\begin{document}

\\end{document}
`;
    default:
      return `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage[numbers]{natbib}
\\usepackage{hyperref}
${shared}
\\title{${t}}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
${bib}
\\end{document}
`;
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "document";

/**
 * Create a new document. By default it goes next to the default document, so
 * it can use the same .bib, macros and figures (the sandbox doesn't allow ../).
 * `content` (from an agent) replaces the template.
 */
export async function createDocument(projectId: string, input: { title?: string; template?: string; path?: string; content?: string; engine?: Engine }) {
  const project = await getProject(projectId);
  const template = (DOCUMENT_TEMPLATES.some((t) => t.id === input.template) ? input.template : "article") as DocumentTemplate;
  const title = (input.title ?? "").trim().slice(0, 120) || DOCUMENT_TEMPLATES.find((t) => t.id === template)!.label;
  const baseDir = path.posix.dirname(project.mainFile);
  let target = input.path?.trim().replace(/^\/+/, "");
  if (!target) target = path.posix.join(baseDir, `${slug(title)}.tex`);
  if (!target.endsWith(".tex")) target += ".tex";
  target = path.posix.normalize(target);
  resolvePath(projectId, target);
  if ((await textOf(projectId, target)) !== null) {
    if (input.path) throw new HttpError(409, `${target} already exists`);
    const stem = target.replace(/\.tex$/, "");
    let n = 2;
    while ((await textOf(projectId, `${stem}-${n}.tex`)) !== null) n++;
    target = `${stem}-${n}.tex`;
  }
  const dir = path.posix.dirname(target);
  const content = input.content?.trim() ? `${input.content.replace(/\s*$/, "")}\n` : templateText(template, title, await resources(projectId, dir));
  if (!documentClassOf(content)) throw new HttpError(400, "A document needs a \\documentclass line");
  await writeText(projectId, target, content);
  if (input.engine && input.engine !== project.engine) await updateDocument(projectId, target, { engine: input.engine });
  // Letters and other classes without \title: remember the name the person or agent gave it.
  if (input.title?.trim() && !documentTitleOf(content)) await updateDocument(projectId, target, { title: input.title });
  return target;
}
