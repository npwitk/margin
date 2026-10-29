import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  DOCUMENT_TEMPLATES, documentClassOf, documentTitleOf, isTextPath,
  type DocumentInfo, type DocumentSettings, type DocumentTemplate, type Engine, type Project, type Session,
  templateById,
} from "@margin/shared";
import { textFiles, textOf } from "./ai/paper.ts";
import { withDoc } from "./collab.ts";
import { HttpError, copyTemplate, getProject, listFiles, resolvePath, saveProject, workDir, writeBinary, writeText } from "./storage.ts";

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

const GRAPHIC_EXTS = ["", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".gif"];

/** Remove LaTeX comments (an unescaped % to the end of the line). */
const stripComments = (tex: string) => tex.replace(/(^|[^\\])%.*$/gm, "$1");

/**
 * Every project file a document uses: the \input/\include tree, figures
 * (honouring \graphicspath and \svgpath), .bib files, local classes, styles and
 * bibliography styles, and listings. Paths resolve the way TeX does: from the
 * document's folder first, then from the including file's folder.
 */
export async function documentFiles(projectId: string, doc: string, all: Set<string>): Promise<string[]> {
  const mainDir = path.posix.dirname(doc);
  const found = new Set<string>([doc]);
  const queue = [doc];
  const graphicDirs = new Set<string>([""]);
  const norm = (p: string) => path.posix.normalize(p).replace(/^\.\//, "");
  const resolve = (from: string, name: string, exts: string[]) => {
    const n = name.trim().replace(/^"|"$/g, "");
    if (!n || n.startsWith("/") || /[{}\\#]/.test(n)) return null;
    for (const base of [mainDir, path.posix.dirname(from), "."]) {
      for (const ext of exts) {
        const cand = norm(path.posix.join(base, n + (n.toLowerCase().endsWith(ext) ? "" : ext)));
        if (!cand.startsWith("..") && all.has(cand)) return cand;
      }
    }
    return null;
  };
  const add = (p: string | null) => {
    if (!p || found.has(p)) return;
    found.add(p);
    if (p.endsWith(".tex")) queue.push(p);
  };
  for (let guard = 0; queue.length && guard < 500; guard++) {
    const file = queue.shift()!;
    const tex = stripComments((await textOf(projectId, file)) ?? "");
    for (const m of tex.matchAll(/\\(?:graphicspath|svgpath)\s*\{((?:\{[^{}]*\}\s*)+)\}/g)) {
      for (const d of m[1].matchAll(/\{([^{}]*)\}/g)) graphicDirs.add(d[1].replace(/\/+$/, "") ? `${d[1].replace(/\/+$/, "")}/` : "");
    }
    const cmd = (names: string, body = "[^}]+") => new RegExp(`\\\\(?:${names})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*\\{(${body})\\}`, "g");
    for (const m of tex.matchAll(cmd("input|include|subfile|InputIfFileExists|includeonly"))) add(resolve(file, m[1], [".tex", ""]));
    for (const m of tex.matchAll(cmd("includegraphics|includesvg|includepdf|includestandalone"))) {
      const exts = /\\includesvg/.test(m[0]) ? [".svg"] : GRAPHIC_EXTS;
      for (const dir of graphicDirs) { const hit = resolve(file, dir + m[1], exts); if (hit) { add(hit); break; } }
    }
    for (const m of tex.matchAll(cmd("bibliography|addbibresource|addglobalbib"))) for (const b of m[1].split(",")) add(resolve(file, b, [".bib"]));
    for (const m of tex.matchAll(cmd("usepackage|RequirePackage"))) for (const p of m[1].split(",")) add(resolve(file, p, [".sty"]));
    for (const m of tex.matchAll(cmd("documentclass|LoadClass"))) add(resolve(file, m[1], [".cls"]));
    for (const m of tex.matchAll(cmd("bibliographystyle"))) add(resolve(file, m[1], [".bst"]));
    for (const m of tex.matchAll(cmd("lstinputlisting|verbatiminput|VerbatimInput"))) add(resolve(file, m[1], [""]));
    for (const m of tex.matchAll(/\\inputminted\s*(?:\[[^\]]*\]\s*)?\{[^}]*\}\s*\{([^}]+)\}/g)) add(resolve(file, m[1], [""]));
  }
  return [...found];
}

export async function listDocuments(projectId: string): Promise<DocumentInfo[]> {
  const project = await getProject(projectId);
  const everything = await listFiles(projectId);
  const all = new Set(everything.filter((f) => f.type === "file").map((f) => f.path));
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
      customTitle: !!s?.title,
      archived: !!s?.archived && f.path !== project.mainFile,
      files: await documentFiles(projectId, f.path, all),
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
export async function updateDocument(projectId: string, doc: string, patch: { engine?: Engine; title?: string; makeDefault?: boolean; archived?: boolean }) {
  const { path: target } = await resolveDocument(projectId, doc);
  const p = await getProject(projectId);
  const list = (p.documents ?? []).filter((d) => d.path !== target);
  const cur = { ...settingsOf(p, target), path: target };
  if (patch.engine !== undefined) {
    if (!ENGINES.includes(patch.engine)) throw new HttpError(400, "Unknown engine");
    cur.engine = patch.engine;
  }
  if (patch.title !== undefined) cur.title = patch.title.trim().slice(0, 120) || undefined;
  if (patch.archived !== undefined) {
    if (patch.archived && target === p.mainFile) throw new HttpError(400, "That's the default document. Make another document the default first, then archive this one.");
    cur.archived = patch.archived || undefined;
  }
  if (patch.makeDefault) {
    if (cur.archived) cur.archived = undefined; // the default can't be archived
    // The project-wide engine follows the default document, for older clients.
    if (cur.engine) p.engine = cur.engine;
    p.mainFile = target;
  }
  if (cur.engine || cur.title || cur.archived) list.push(cur);
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

function templateText(template: DocumentTemplate, title: string, r: { bibs: string[]; macros: string[]; intro?: string }) {
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

${r.intro ? `\\input{${r.intro}}` : "\\section{Introduction}"}
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

${r.intro ? `\\input{${r.intro}}` : "\\section{Introduction}"}
${bib}
\\end{document}
`;
  }
}

export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "document";

const COPY_SKIP = /(^|\/)(_out|reviews|svg-inkscape)(\/|$)/;

export async function unusedFolder(projectId: string, base: string) {
  const taken = new Set((await listFiles(projectId)).map((f) => f.path));
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

/**
 * Create a new document.
 * - layout "folder" (what people pick in the UI): a self-contained folder of
 *   its own (main.tex, sections/, figures/, refs.bib), like a separate paper.
 * - layout "beside" (the default for agents): one .tex next to the default
 *   document, reusing its .bib, macros and figures (the sandbox can't read ../).
 * - copyFrom: start from a copy of an existing document's folder, e.g. a
 *   journal version of a conference paper.
 * `content` (from an agent) replaces the template.
 */
export async function createDocument(projectId: string, input: {
  title?: string; template?: string; path?: string; content?: string; engine?: Engine; layout?: "folder" | "beside"; copyFrom?: string;
}) {
  const project = await getProject(projectId);
  // A gallery template (ACM, NeurIPS, Metropolis…) in its own folder, or one of the generated ones.
  const gallery = DOCUMENT_TEMPLATES.some((t) => t.id === input.template) ? undefined : templateById(input.template ?? "");
  const template = (DOCUMENT_TEMPLATES.some((t) => t.id === input.template) ? input.template : gallery?.beside ?? "article") as DocumentTemplate;
  const title = (input.title ?? "").trim().slice(0, 120) || (input.copyFrom ? `Copy of ${path.posix.basename(path.posix.dirname(input.copyFrom)) || "document"}` : DOCUMENT_TEMPLATES.find((t) => t.id === template)!.label);
  let target: string;

  if (input.copyFrom || input.layout === "folder") {
    const folder = await unusedFolder(projectId, input.path?.trim().replace(/^\/+|\/+$/g, "").replace(/\.tex$/, "") || slug(title));
    resolvePath(projectId, folder);
    if (input.copyFrom) {
      // A copy of another document: its whole folder, or (for a document at the top level) just the files it uses.
      const src = (await resolveDocument(projectId, input.copyFrom)).path;
      const srcDir = path.posix.dirname(src);
      const all = await listFiles(projectId);
      const files = srcDir === "."
        ? await documentFiles(projectId, src, new Set(all.filter((f) => f.type === "file").map((f) => f.path)))
        : all.filter((f) => f.type === "file" && f.path.startsWith(`${srcDir}/`) && !COPY_SKIP.test(f.path)).map((f) => f.path);
      for (const f of files) {
        const rel = srcDir === "." ? f : f.slice(srcDir.length + 1);
        const live = isTextPath(f) ? await textOf(projectId, f) : null; // includes edits not saved to disk yet
        const data = live ?? (await readFile(resolvePath(projectId, f)));
        await writeBinary(projectId, `${folder}/${rel}`, Buffer.from(data));
      }
      for (const d of all.filter((f) => f.type === "dir" && srcDir !== "." && f.path.startsWith(`${srcDir}/`) && !COPY_SKIP.test(f.path))) {
        await mkdir(resolvePath(projectId, `${folder}/${d.path.slice(srcDir.length + 1)}`), { recursive: true });
      }
      target = `${folder}/${path.posix.basename(src)}`;
      if (input.title?.trim()) await updateDocument(projectId, target, { title: input.title });
      return target;
    }
    target = `${folder}/main.tex`;
    if (gallery && !input.content?.trim()) {
      await copyTemplate(gallery.id, resolvePath(projectId, folder), title);
      const engine = input.engine ?? gallery.engine;
      if (engine && engine !== project.engine) await updateDocument(projectId, target, { engine });
      if (input.title?.trim() && !documentTitleOf((await textOf(projectId, target)) ?? "")) await updateDocument(projectId, target, { title: input.title });
      return target;
    }
    // A fresh, self-contained document folder.
    const withSections = template === "article" || template === "ieee";
    const withBib = template !== "blank";
    if (withSections) await writeText(projectId, `${folder}/sections/introduction.tex`, "\\section{Introduction}\n\nStart writing here.\n");
    if (withBib) await writeText(projectId, `${folder}/refs.bib`, "% References for this document. Add entries here, or insert them from the Library with \\cite{.\n");
    await mkdir(resolvePath(projectId, `${folder}/figures`), { recursive: true });
    const content = input.content?.trim() ? `${input.content.replace(/\s*$/, "")}\n`
      : templateText(template, title, { bibs: withBib ? ["refs"] : [], macros: [], intro: withSections ? "sections/introduction" : undefined });
    await writeText(projectId, target, content);
  } else {
    const baseDir = path.posix.dirname(project.mainFile);
    target = input.path?.trim().replace(/^\/+/, "") || path.posix.join(baseDir, `${slug(title)}.tex`);
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
  }
  if (input.engine && input.engine !== project.engine) await updateDocument(projectId, target, { engine: input.engine });
  // Letters and other classes without \title: remember the name the person or agent gave it.
  const written = (await textOf(projectId, target)) ?? "";
  if (input.title?.trim() && !documentTitleOf(written)) await updateDocument(projectId, target, { title: input.title });
  return target;
}

/**
 * Add a section to a document: sections/<name>.tex in the document's folder,
 * \\input from the main file (before the bibliography, or \\end{document}),
 * through the live document so everyone's editor updates.
 */
export async function addSection(projectId: string, docPath: string, title: string, session: Session) {
  const doc = (await resolveDocument(projectId, docPath)).path;
  const name = title.trim().slice(0, 80);
  if (!name) throw new HttpError(400, "Give the section a name");
  const dir = path.posix.dirname(doc);
  const stem = slug(name);
  let rel = `sections/${stem}`, n = 2;
  while ((await textOf(projectId, path.posix.join(dir, `${rel}.tex`))) !== null) rel = `sections/${stem}-${n++}`;
  const file = path.posix.join(dir, `${rel}.tex`).replace(/^\.\//, "");
  await writeText(projectId, file, `\\section{${esc(name)}}\n\\label{sec:${stem}}\n\n`);
  const line = `\\input{${rel}}`;
  await withDoc(projectId, doc, session, (y) => {
    const t = y.getText("content");
    const src = t.toString();
    // After the last \\input/\\include, else before the bibliography or \\end{document}.
    // Body sections only: not the references, appendix or acknowledgements, which stay last.
    const all = [...src.matchAll(/^[ \t]*\\(?:input|include)\{([^}]*)\}[^\n]*$/gm)];
    const isBack = (m: RegExpMatchArray) => /(ref|bib|appendi|acknowledg|supplement)/i.test(m[1]);
    const firstBackInput = all.find(isBack)?.index ?? -1;
    const inputs = all.filter((m) => !isBack(m) && (firstBackInput < 0 || m.index! < firstBackInput));
    const backMatter = src.search(/^[ \t]*\\(?:appendix(?![a-zA-Z])|bibliographystyle|bibliography|printbibliography|begin\{thebibliography\}|end\{document\})/m);
    const last = inputs.filter((m) => backMatter < 0 || m.index! < backMatter).at(-1);
    let at: number;
    let text: string;
    if (last) { at = last.index! + last[0].length; text = `\n${line}`; }
    else {
      const stop = src.search(/^[ \t]*\\(?:bibliographystyle|bibliography|printbibliography|end\{document\})/m);
      at = stop >= 0 ? stop : src.length;
      text = `${line}\n\n`;
    }
    t.insert(at, text);
  });
  return file;
}
