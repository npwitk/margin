import type Anthropic from "@anthropic-ai/sdk";
import type * as Y from "yjs";
import { z } from "zod";
import { ROOM, boardColumns, columnOf, firstColumn, type Engine, type TaskColumn, assigneesOf, withAssignees, createThread, isTextPath, lineAt, listThreads, reply, setStatus, textOf as yText, threadsOf, type Session, type Task } from "@margin/shared";
import { emit, withDoc } from "../collab.ts";
import { addSection, createDocument, listDocuments, updateDocument } from "../documents.ts";
import { compileProject } from "../compile.ts";
import { addEntry, movePath, removePath } from "../entries.ts";
import { addProjectSection } from "../sections.ts";
import { getProject, listFiles, resolvePath } from "../storage.ts";
import { editorName, recordEdit, saveVersion } from "../versions.ts";
import { applyAgentChange } from "../connect/apply.ts";
import { beforeEdit, type CursorRange } from "./activity.ts";
import { textFiles, textOf } from "./paper.ts";

/**
 * Tools the project assistant and external agents (MCP) can use. They read
 * anything; how they change text depends on the project's agent mode: typed
 * straight into the live document like a co-author ("edit"), or left as
 * suggestions a person accepts ("suggest").
 */

export interface ToolContext {
  projectId: string;
  session: Session;
  /** Who's acting: "Claude" for the built-in assistant, or an external agent's name. */
  agentName: string;
  /** Identifies this agent's run, for its presence and for undoing its edits. */
  key: string;
  status(text: string, file?: string, range?: CursorRange): void;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  summary: string;
  path?: string;
  threadId?: string;
}

type Def = {
  description: string;
  schema: z.ZodObject;
  run(input: never, ctx: ToolContext): Promise<ToolOutcome>;
};

const READ_LIMIT = 1500;

const fail = (summary: string, content: string): ToolOutcome => ({ summary, content, isError: true });

function checkPath(projectId: string, rel: string) {
  resolvePath(projectId, rel); // throws on traversal / internal folders
  if (!isTextPath(rel)) throw new Error(`${rel} isn't a text file`);
}

/** The session edits are credited to: "Claude Code (for Alice)". */
const asAgent = (ctx: ToolContext): Session => (ctx.session.agent ? ctx.session : { ...ctx.session, agent: ctx.agentName });

async function agentMode(ctx: ToolContext) {
  return (await getProject(ctx.projectId)).agentMode ?? "suggest";
}

const SUGGEST_ONLY = "This project is set to \"Agents suggest\": file and folder changes need a person. Ask your user to make it, or to switch the project to \"Agents edit directly\" in Share settings.";

function columnsIn(doc: Y.Doc) {
  return boardColumns(doc.getMap<TaskColumn[]>("board").get("columns"));
}

/** A column by id or (case-insensitive) name. */
function findColumn(columns: TaskColumn[], ref: string) {
  const r = ref.trim().toLowerCase();
  return columns.find((c) => c.id === ref) ?? columns.find((c) => c.label.toLowerCase() === r);
}

export function columnId(label: string, columns: TaskColumn[]) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "column";
  let id = base, n = 2;
  while (columns.some((c) => c.id === id)) id = `${base}-${n++}`;
  return id;
}

function occurrences(text: string, needle: string) {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0 && out.length < 50; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const DEFS: Record<string, Def> = {
  list_files: {
    description: "List every file in the project with its size. Marks document roots (.tex files with \\documentclass) and the default document.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      const [files, project, docs] = await Promise.all([listFiles(ctx.projectId), getProject(ctx.projectId), listDocuments(ctx.projectId)]);
      const roots = new Set(docs.map((d) => d.path));
      const sections = new Map((project.sections ?? []).map((x) => [x.path, x.title]));
      const lines = files.map((f) => (f.type === "dir" ? `${f.path}/${sections.has(f.path) ? ` [section “${sections.get(f.path)}”]` : ""}` : `${f.path} (${f.size} B)${f.path === project.mainFile ? " [default document]" : roots.has(f.path) ? " [document]" : ""}`));
      return { summary: "Listed project files", content: lines.join("\n") || "(empty project)" };
    },
  },

  read_file: {
    description: "Read a text file (LaTeX, BibTeX, notes) with line numbers, as collaborators currently see it. Optionally a line range.",
    schema: z.object({
      path: z.string().describe("Project-relative path, e.g. sections/method.tex"),
      start_line: z.number().int().optional().describe("First line to return (1-based)"),
      end_line: z.number().int().optional().describe("Last line to return (inclusive)"),
    }),
    async run(input: { path: string; start_line?: number; end_line?: number }, ctx) {
      checkPath(ctx.projectId, input.path);
      const text = await textOf(ctx.projectId, input.path);
      if (text === null) return fail(`Couldn't read ${input.path}`, `No such file: ${input.path}`);
      const lines = text.split("\n");
      const start = Math.max(1, input.start_line ?? 1);
      const at = lines.slice(0, start - 1).reduce((n, l) => n + l.length + 1, 0);
      ctx.status(`Reading ${input.path}`, input.path, { from: at, to: at });
      const end = Math.min(lines.length, input.end_line ?? start + READ_LIMIT - 1, start + READ_LIMIT - 1);
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = end < lines.length ? `\n… ${lines.length - end} more lines (read with start_line=${end + 1})` : "";
      return { summary: `Read ${input.path}`, path: input.path, content: `${input.path} (${lines.length} lines)\n${body}${more}` };
    },
  },

  search: {
    description: "Search all text files for a phrase (case-insensitive) or a regular expression. Returns path:line: text for each match.",
    schema: z.object({
      query: z.string(),
      regex: z.boolean().optional().describe("Treat query as a JavaScript regular expression"),
    }),
    async run(input: { query: string; regex?: boolean }, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      } catch (e) {
        return fail("Search failed", `Invalid regular expression: ${(e as Error).message}`);
      }
      ctx.status(`Searching for “${input.query}”`);
      const hits: string[] = [];
      for (const f of await textFiles(ctx.projectId)) {
        const text = (await textOf(ctx.projectId, f.path)) ?? "";
        text.split("\n").forEach((line, i) => { if (hits.length < 80 && re.test(line)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`); });
      }
      return { summary: `Searched for “${input.query}” (${hits.length} match${hits.length === 1 ? "" : "es"})`, content: hits.join("\n") || "No matches." };
    },
  },

  propose_edit: {
    description:
      "Suggest replacing an exact passage of a file. The suggestion appears inline for the authors to accept or reject; it doesn't change the file by itself. " +
      "`find` must match the current file text exactly (copy it from read_file without line numbers) and appear only once — include more surrounding text if needed. " +
      "To insert, use a nearby passage as `find` and repeat it in `replace` with the new text added.",
    schema: z.object({
      path: z.string(),
      find: z.string().describe("Exact existing text to replace"),
      replace: z.string().describe("Replacement text"),
      reason: z.string().describe("One sentence the authors will see explaining the change"),
    }),
    async run(input: { path: string; find: string; replace: string; reason: string }, ctx) {
      checkPath(ctx.projectId, input.path);
      if (!input.find) return fail("Edit not suggested", "`find` is empty.");
      if (input.find === input.replace) return fail("Edit not suggested", "`replace` is identical to `find`.");
      ctx.status(`Suggesting an edit in ${input.path}`, input.path);
      const result = await withDoc(ctx.projectId, input.path, ctx.session, (doc) => {
        const hits = occurrences(yText(doc).toString(), input.find);
        if (hits.length !== 1) return { hits: hits.length };
        const t = createThread(doc, {
          from: hits[0], to: hits[0] + input.find.length, author: ctx.agentName, kind: "suggestion",
          replacement: input.replace, message: `${input.reason.trim()} (for ${ctx.session.name})`,
        });
        return { hits: 1, id: t.id };
      });
      if (!result.id) {
        return fail(`Couldn't place an edit in ${input.path}`, result.hits === 0
          ? "The `find` text isn't in the file (it may have changed). Read the file again and copy the passage exactly."
          : `The \`find\` text appears ${result.hits} times. Include more surrounding text so it matches once.`);
      }
      return { summary: `Suggested an edit in ${input.path}`, path: input.path, threadId: result.id, content: `Suggestion created (id ${result.id}). The authors will review it.` };
    },
  },

  edit_file: {
    description:
      "Change an exact passage of a file: replace `find` with `replace`. In projects where agents edit directly (the usual setting) the change is typed into the live document at once, " +
      "so co-authors watch it happen and history credits you; otherwise it becomes a suggestion for the authors to accept. " +
      "`find` must match the current file text exactly (copy it from read_file without line numbers) and appear only once - include more surrounding text if needed. " +
      "To insert, use a nearby passage as `find` and repeat it in `replace` with the new text added. Keep each call to one focused change.",
    schema: z.object({
      path: z.string(),
      find: z.string().describe("Exact existing text to replace"),
      replace: z.string().describe("Replacement text"),
      reason: z.string().describe("One sentence saying what the change does (shown to the authors)"),
    }),
    async run(input: { path: string; find: string; replace: string; reason: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return DEFS.propose_edit.run(input as never, ctx);
      checkPath(ctx.projectId, input.path);
      if (!input.find) return fail("No edit made", "`find` is empty.");
      if (input.find === input.replace) return fail("No edit made", "`replace` is identical to `find`.");
      await beforeEdit(ctx.projectId, ctx.key, input.path, asAgent(ctx));
      const result = await withDoc(ctx.projectId, input.path, asAgent(ctx), (doc) => {
        const text = yText(doc);
        const current = text.toString();
        const hits = occurrences(current, input.find);
        if (hits.length !== 1) return { hits: hits.length };
        doc.transact(() => {
          text.delete(hits[0], input.find.length);
          if (input.replace) text.insert(hits[0], input.replace);
        });
        return { hits: 1, from: hits[0], line: lineAt(current, hits[0]) };
      });
      if (result.from === undefined) {
        return fail(`Couldn't edit ${input.path}`, result.hits === 0
          ? "The `find` text isn't in the file (it may have changed). Read the file again and copy the passage exactly."
          : `The \`find\` text appears ${result.hits} times. Include more surrounding text so it matches once.`);
      }
      ctx.status(`Edited ${input.path}: ${input.reason.trim()}`, input.path, { from: result.from, to: result.from + input.replace.length, edited: true });
      return { summary: `Edited ${input.path}:${result.line}`, path: input.path, content: `Done: ${input.path} changed at line ${result.line}. Co-authors see it now.` };
    },
  },

  write_file: {
    description:
      "Create a text file (.tex, .bib, .sty, notes…) with the given content, or replace a whole existing file. For small changes to an existing file use edit_file instead. " +
      "Replacing merges with anything co-authors typed since `based_on` (the text you read), so pass it when you rewrite a file you read earlier. " +
      "When agents only suggest in this project, a replacement becomes suggestions; new files are created either way.",
    schema: z.object({
      path: z.string().describe("Project-relative path, e.g. sections/limitations.tex"),
      content: z.string(),
      based_on: z.string().optional().describe("The file's text as you read it, if you're replacing a file"),
    }),
    async run(input: { path: string; content: string; based_on?: string }, ctx) {
      checkPath(ctx.projectId, input.path);
      const mode = await agentMode(ctx);
      const exists = (await textOf(ctx.projectId, input.path)) !== null;
      if (mode === "edit" || !exists) await beforeEdit(ctx.projectId, ctx.key, input.path, asAgent(ctx));
      ctx.status(`${exists ? "Rewriting" : "Creating"} ${input.path}`, input.path);
      const r = await applyAgentChange(ctx.projectId, asAgent(ctx), input.path, input.based_on ?? null, input.content, mode);
      if (r.mode === "created") {
        recordEdit(ctx.projectId, input.path, editorName(asAgent(ctx)));
        return { summary: `Created ${input.path}`, path: input.path, content: `Created ${input.path}.` };
      }
      const conflicts = r.conflicts ? ` ${r.conflicts} passage${r.conflicts === 1 ? "" : "s"} clashed with co-authors' edits and now hold both versions between <<<<<<< and >>>>>>> markers; read the file and resolve them.` : "";
      if (r.mode === "suggest") return { summary: `Suggested ${r.suggestions ?? 0} edit${r.suggestions === 1 ? "" : "s"} to ${input.path}`, path: input.path, content: `Left ${r.suggestions ?? 0} suggestions for the authors.${conflicts}` };
      return { summary: `Rewrote ${input.path}`, path: input.path, content: `Replaced ${input.path}.${conflicts}` };
    },
  },

  create_folder: {
    description: "Create a folder (e.g. figures/ or a folder for a new document). Does nothing if it already exists.",
    schema: z.object({ path: z.string() }),
    async run(input: { path: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Folder not created", SUGGEST_ONLY);
      ctx.status(`Creating folder ${input.path}`);
      const { existed } = await addEntry(ctx.projectId, input.path.replace(/\/+$/, ""), "dir", asAgent(ctx));
      return { summary: existed ? `${input.path} already exists` : `Created folder ${input.path}`, content: existed ? "That folder already exists." : "Folder created." };
    },
  },

  move_path: {
    description: "Rename or move a file or folder. LaTeX \\input paths aren't rewritten: update them with edit_file afterwards.",
    schema: z.object({ from: z.string(), to: z.string() }),
    async run(input: { from: string; to: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Not moved", SUGGEST_ONLY);
      await beforeEdit(ctx.projectId, ctx.key, input.from, asAgent(ctx));
      ctx.status(`Moving ${input.from} to ${input.to}`);
      await movePath(ctx.projectId, input.from, input.to, asAgent(ctx));
      return { summary: `Moved ${input.from} to ${input.to}`, path: input.to, content: "Moved. Check \\input/\\include/\\includegraphics paths that pointed to the old location." };
    },
  },

  delete_path: {
    description: "Delete a file or folder. Only when the user asked for it; it stays in version history.",
    schema: z.object({ path: z.string() }),
    async run(input: { path: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Not deleted", SUGGEST_ONLY);
      await beforeEdit(ctx.projectId, ctx.key, input.path, asAgent(ctx));
      ctx.status(`Deleting ${input.path}`);
      await removePath(ctx.projectId, input.path, asAgent(ctx));
      return { summary: `Deleted ${input.path}`, content: "Deleted (recoverable from history)." };
    },
  },

  add_section: {
    description: "Add a section file to a LaTeX document: creates sections/<name>.tex next to it and \\input's it before the bibliography. Then write its text with edit_file.",
    schema: z.object({ title: z.string().describe("Section name, e.g. \"Limitations\""), document: z.string().optional().describe("Document path; default: the default document") }),
    async run(input: { title: string; document?: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Section not added", SUGGEST_ONLY);
      const docPath = input.document ?? (await getProject(ctx.projectId)).mainFile;
      await beforeEdit(ctx.projectId, ctx.key, docPath, asAgent(ctx));
      ctx.status(`Adding section “${input.title}”`, docPath);
      const file = await addSection(ctx.projectId, docPath, input.title, asAgent(ctx));
      await beforeEdit(ctx.projectId, ctx.key, file, asAgent(ctx));
      recordEdit(ctx.projectId, file, editorName(asAgent(ctx)));
      emit(ctx.projectId, "filesVersion", Date.now());
      return { summary: `Added section ${file}`, path: file, content: `Created ${file} and \\input it from ${docPath}.` };
    },
  },

  create_project_section: {
    description: "Create a section of the project: a named folder (e.g. \"Slides\", \"Experiments\", \"Meeting notes\") shown as its own group in everyone's file list, to put new documents and files in. This is not a LaTeX \\section (use add_section for that). Pass `path` to give an existing folder a section name instead.",
    schema: z.object({ title: z.string(), path: z.string().optional().describe("An existing folder to turn into a section") }),
    async run(input: { title: string; path?: string }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Section not created", SUGGEST_ONLY);
      ctx.status(`Creating section “${input.title}”`);
      const section = await addProjectSection(ctx.projectId, input, asAgent(ctx));
      return { summary: `Created section “${section.title}”`, path: section.path, content: `Section “${section.title}” is the folder ${section.path}/. Put files there, e.g. create_document with path "${section.path}/<name>.tex".` };
    },
  },

  update_document: {
    description: "Change a document's settings: rename it in Margin, make it the default, archive or restore it, or set its engine.",
    schema: z.object({
      path: z.string(),
      title: z.string().optional(),
      make_default: z.boolean().optional(),
      archived: z.boolean().optional(),
      engine: z.enum(["pdflatex", "xelatex", "lualatex"]).optional(),
    }),
    async run(input: { path: string; title?: string; make_default?: boolean; archived?: boolean; engine?: Engine }, ctx) {
      if ((await agentMode(ctx)) === "suggest") return fail("Document unchanged", SUGGEST_ONLY);
      ctx.status(`Updating ${input.path}`, input.path);
      await updateDocument(ctx.projectId, input.path, { title: input.title, makeDefault: input.make_default, archived: input.archived, engine: input.engine });
      emit(ctx.projectId, "filesVersion", Date.now());
      return { summary: `Updated ${input.path}`, path: input.path, content: "Document updated." };
    },
  },

  save_version: {
    description: "Save a named version of the project (a checkpoint in its history), e.g. after finishing a piece of work. The message says what changed, for co-authors and advisors.",
    schema: z.object({ message: z.string().describe("Short summary, e.g. \"Rewrote related work around retrieval methods\"") }),
    async run(input: { message: string }, ctx) {
      ctx.status("Saving a version");
      const cp = await saveVersion(ctx.projectId, { message: input.message.slice(0, 200), by: editorName(asAgent(ctx)), kind: "named" });
      return { summary: cp ? `Saved version “${input.message}”` : "Nothing new to save", content: cp ? `Saved version ${cp.hash.slice(0, 8)}.` : "No changes since the last version." };
    },
  },

  add_comment: {
    description: "Leave a comment on an exact passage of a file (for questions, concerns or notes that aren't a concrete edit).",
    schema: z.object({ path: z.string(), quote: z.string().describe("Exact existing text to attach the comment to"), message: z.string() }),
    async run(input: { path: string; quote: string; message: string }, ctx) {
      checkPath(ctx.projectId, input.path);
      ctx.status(`Commenting on ${input.path}`, input.path);
      const result = await withDoc(ctx.projectId, input.path, ctx.session, (doc) => {
        const hits = occurrences(yText(doc).toString(), input.quote);
        if (hits.length !== 1) return { hits: hits.length };
        const t = createThread(doc, { from: hits[0], to: hits[0] + input.quote.length, author: ctx.agentName, message: `${input.message.trim()} (for ${ctx.session.name})` });
        return { hits: 1, id: t.id };
      });
      if (!result.id) return fail(`Couldn't place a comment in ${input.path}`, result.hits === 0 ? "Quote not found in the file." : `Quote appears ${result.hits} times; use a longer quote.`);
      return { summary: `Commented on ${input.path}`, path: input.path, threadId: result.id, content: `Comment added (id ${result.id}).` };
    },
  },

  list_documents: {
    description: "List the LaTeX documents in this project (paper, slides, letters…): each root .tex file with its title, document class and engine, and which one is the default.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      const docs = await listDocuments(ctx.projectId);
      const lines = docs.map((d) => `${d.path}: "${d.title}" (${d.docClass ?? "?"}, ${d.engine})${d.isDefault ? " [default]" : ""}${d.archived ? " [archived]" : ""}${d.hasPdf ? "" : " (not compiled yet)"}`);
      return { summary: `Listed ${docs.length} document${docs.length === 1 ? "" : "s"}`, content: lines.join("\n") || "(no documents)" };
    },
  },

  create_document: {
    description: "Create a new LaTeX document in the project (slides, a cover letter, a rebuttal, a poster, a supplement…). Either pick a template or pass the full source as content. It goes next to the default document unless you give a path, so it can use the project's .bib, macros and figures (LaTeX here can't read ../ paths). Compile it afterwards to check it builds.",
    schema: z.object({
      title: z.string().describe("Human title, e.g. \"Rebuttal for NeurIPS\""),
      template: z.enum(["article", "beamer", "letter", "poster", "ieee", "blank"]).optional().describe("Starting point when no content is given"),
      path: z.string().optional().describe("Where to create it, e.g. \"slides.tex\" or \"LaTeX/rebuttal.tex\". Defaults to a file named after the title next to the default document."),
      content: z.string().optional().describe("Complete LaTeX source including \\documentclass; replaces the template"),
    }),
    async run(input: { title: string; template?: string; path?: string; content?: string }, ctx) {
      ctx.status("Creating a document", input.path);
      try {
        const path = await createDocument(ctx.projectId, input);
        emit(ctx.projectId, "filesVersion", Date.now());
        return { summary: `Created ${path}`, path, content: `Created ${path}. Use compile with document "${path}" to build it.` };
      } catch (err) {
        return fail("Couldn't create the document", (err as Error).message);
      }
    },
  },

  compile: {
    description: "Compile a LaTeX document (including everyone's latest edits) and return errors and warnings. Compiles the default document unless you name one.",
    schema: z.object({ document: z.string().optional().describe("Path of the document to compile, e.g. \"slides.tex\"; see list_documents") }),
    async run(input: { document?: string }, ctx) {
      ctx.status("Compiling", input.document);
      const r = await compileProject(ctx.projectId, `${ctx.agentName} (for ${ctx.session.name})`, input.document);
      const errors = r.diagnostics.filter((d) => d.severity === "error");
      const warnings = r.diagnostics.filter((d) => d.severity === "warning");
      const fmt = (d: (typeof r.diagnostics)[number]) => `${d.file ?? "?"}${d.line ? `:${d.line}` : ""}: ${d.message}`;
      const content = [
        r.ok ? "Compiled successfully." : `Compile failed${r.hasPdf ? " (an older PDF exists)" : ""}.`,
        errors.length ? `Errors:\n${errors.slice(0, 15).map(fmt).join("\n")}` : "",
        warnings.length ? `Warnings (${warnings.length}):\n${warnings.slice(0, 15).map(fmt).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      return { summary: r.ok ? `Compiled ${r.doc} (${warnings.length} warnings)` : `Compiled ${r.doc}: ${errors.length} error${errors.length === 1 ? "" : "s"}`, content };
    },
  },

  list_tasks: {
    description: "Show the project board: its columns, and the tasks in each with status, assignees and linked files.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      const { tasks, columns } = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => ({ tasks: [...doc.getMap<Task>("tasks").values()], columns: columnsIn(doc) }));
      const content = columns.map((c) => {
        const items = tasks.filter((t) => columnOf(columns, t.status).id === c.id).sort((a, b) => a.order - b.order);
        return `${c.label} [status "${c.id}", ${c.kind === "active" ? "in progress" : c.kind === "done" ? "finished" : "not started"}]:\n${items.map((t) => `- [${t.id.slice(0, 8)}] ${t.title}${assigneesOf(t).length ? ` (${assigneesOf(t).map((a) => `@${a}`).join(", ")})` : ""}${t.files?.length ? ` files: ${t.files.join(", ")}` : ""}`).join("\n") || "- (none)"}`;
      }).join("\n\n");
      return { summary: "Checked the board", content };
    },
  },

  create_task: {
    description: "Add a task to the project board (its first not-started column unless you name one), e.g. follow-ups you can't do yourself, like running an experiment.",
    schema: z.object({
      title: z.string(),
      assignee: z.string().optional().describe("Member name, if the user asked to assign it"),
      files: z.array(z.string()).optional(),
      notes: z.string().optional(),
      status: z.string().optional().describe("Column id or name from list_tasks"),
    }),
    async run(input: { title: string; assignee?: string; files?: string[]; notes?: string; status?: string }, ctx) {
      const result = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => {
        const tasks = doc.getMap<Task>("tasks");
        const columns = columnsIn(doc);
        const column = input.status ? findColumn(columns, input.status) : firstColumn(columns);
        if (!column) return { error: `No column “${input.status}”. Columns: ${columns.map((c) => c.label).join(", ")}.` };
        const order = Math.max(0, ...[...tasks.values()].filter((t) => t.status === column.id).map((t) => t.order)) + 1;
        const number = Math.max(0, ...[...tasks.values()].map((t) => t.number ?? 0)) + 1;
        const now = new Date().toISOString();
        const t: Task = {
          id: crypto.randomUUID(), title: input.title.slice(0, 200), status: column.id, order, number,
          ...(input.assignee ? withAssignees([input.assignee]) : {}), files: input.files?.filter((f) => isTextPath(f) || f.includes(".")), notes: input.notes,
          createdBy: `${ctx.agentName} (for ${ctx.session.name})`, createdAt: now, updatedAt: now,
        };
        tasks.set(t.id, t);
        return { task: t, column };
      });
      if (!result.task) return fail("Couldn't add the task", result.error!);
      return { summary: `Added task “${result.task.title}” to ${result.column.label}`, content: `Task created (id ${result.task.id.slice(0, 8)}).` };
    },
  },

  update_task: {
    description: "Update a board task: claim it (assign it and move it to an in-progress column), move it between columns, or add a note. Use the id shown by list_tasks (a prefix is enough).",
    schema: z.object({
      id: z.string(),
      status: z.string().optional().describe("Column id or name from list_tasks, e.g. \"doing\" or \"In progress\""),
      assignee: z.string().optional().describe("Member name to add as an assignee; use your user's name to claim it"),
      note: z.string().optional().describe("Appended to the task's notes"),
    }),
    async run(input: { id: string; status?: string; assignee?: string; note?: string }, ctx) {
      const result = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => {
        const tasks = doc.getMap<Task>("tasks");
        const columns = columnsIn(doc);
        const matches = [...tasks.values()].filter((t) => t.id.startsWith(input.id));
        if (matches.length !== 1) return { error: matches.length ? "That id matches several tasks; use more characters." : "No task with that id." };
        const column = input.status ? findColumn(columns, input.status) : undefined;
        if (input.status && !column) return { error: `No column “${input.status}”. Columns: ${columns.map((c) => `${c.label} (${c.id})`).join(", ")}.` };
        const t = matches[0];
        const stamp = new Date().toISOString();
        const notes = input.note ? `${t.notes ? `${t.notes}\n\n` : ""}${input.note.trim()} (${ctx.agentName} for ${ctx.session.name}, ${stamp.slice(0, 10)})` : t.notes;
        const people = assigneesOf(t);
        const next: Task = { ...t, status: column?.id ?? t.status, ...(input.assignee && !people.includes(input.assignee) ? withAssignees([...people, input.assignee]) : {}), notes, updatedAt: stamp };
        tasks.set(t.id, next);
        return { task: next, label: columnOf(columns, next.status).label };
      });
      if (!result.task) return fail("Couldn't update the task", result.error!);
      return { summary: `Updated task “${result.task.title}” (${result.label}${assigneesOf(result.task).length ? `, ${assigneesOf(result.task).map((a) => `@${a}`).join(" ")}` : ""})`, content: "Task updated." };
    },
  },

  add_board_column: {
    description: "Add a column to the project board, e.g. \"Blocked\" or \"Waiting for advisor\". Only when the user asks for it.",
    schema: z.object({
      label: z.string(),
      kind: z.enum(["todo", "active", "done"]).optional().describe("not started, in progress (default) or finished"),
      after: z.string().optional().describe("Put it after this column (id or name); default: before the finished columns"),
    }),
    async run(input: { label: string; kind?: TaskColumn["kind"]; after?: string }, ctx) {
      const label = input.label.trim().slice(0, 40);
      if (!label) return fail("No column added", "Give the column a name.");
      const columns = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => {
        const current = columnsIn(doc);
        if (findColumn(current, label)) return null;
        const column: TaskColumn = { id: columnId(label, current), label, kind: input.kind ?? "active" };
        const after = input.after ? current.findIndex((c) => c === findColumn(current, input.after!)) : -1;
        const doneAt = current.findIndex((c) => c.kind === "done");
        const at = after >= 0 ? after + 1 : doneAt >= 0 ? doneAt : current.length;
        const next = [...current.slice(0, at), column, ...current.slice(at)];
        doc.getMap<TaskColumn[]>("board").set("columns", next);
        return next;
      });
      if (!columns) return fail("No column added", `There's already a column called “${label}”.`);
      return { summary: `Added board column “${label}”`, content: `Columns now: ${columns.map((c) => c.label).join(" → ")}.` };
    },
  },

  list_comments: {
    description: "List review threads (comments and suggested edits) with their status, location and replies. Use this to find feedback to address.",
    schema: z.object({
      path: z.string().optional().describe("Only this file; default: every .tex/.bib file"),
      include_closed: z.boolean().optional().describe("Also show resolved, accepted and rejected threads"),
    }),
    async run(input: { path?: string; include_closed?: boolean }, ctx) {
      const files = input.path ? [input.path] : (await textFiles(ctx.projectId)).map((f) => f.path).filter((p) => /\.(tex|bib)$/.test(p));
      const out: string[] = [];
      for (const path of files) {
        checkPath(ctx.projectId, path);
        const threads = await withDoc(ctx.projectId, path, ctx.session, (doc) => {
          const text = yText(doc).toString();
          return listThreads(doc).map((t) => ({ ...t, line: t.from === null ? null : lineAt(text, t.from) }));
        });
        for (const t of threads) {
          if (!input.include_closed && t.status !== "open") continue;
          const where = t.line ? `${path}:${t.line}` : `${path} (text removed)`;
          const head = `[${t.id.slice(0, 8)}] ${t.kind}${t.status !== "open" ? ` (${t.status})` : ""} at ${where} by ${t.author}`;
          const body = t.kind === "suggestion" ? `  replace: ${JSON.stringify(t.quote)}\n  with: ${JSON.stringify(t.replacement ?? "")}` : `  on: ${JSON.stringify(t.quote.slice(0, 200))}`;
          const msgs = t.messages.map((m) => `  ${m.author}: ${m.text}`).join("\n");
          out.push([head, body, msgs].filter(Boolean).join("\n"));
        }
      }
      return { summary: `Checked comments${input.path ? ` in ${input.path}` : ""} (${out.length} open)`, content: out.join("\n\n") || "No open comments." };
    },
  },

  reply_to_comment: {
    description: "Reply to a review thread, optionally marking it resolved (e.g. after addressing the feedback). Use the id from list_comments (a prefix is enough).",
    schema: z.object({ path: z.string(), thread_id: z.string(), message: z.string(), resolve: z.boolean().optional() }),
    async run(input: { path: string; thread_id: string; message: string; resolve?: boolean }, ctx) {
      checkPath(ctx.projectId, input.path);
      const result = await withDoc(ctx.projectId, input.path, ctx.session, (doc) => {
        const matches = [...threadsOf(doc).keys()].filter((id) => id.startsWith(input.thread_id));
        if (matches.length !== 1) return { error: matches.length ? "Ambiguous thread id." : "No such thread in that file." };
        reply(doc, matches[0], `${ctx.agentName} (for ${ctx.session.name})`, input.message.trim());
        if (input.resolve) setStatus(doc, matches[0], "resolved", `${ctx.agentName} (for ${ctx.session.name})`);
        return { id: matches[0] };
      });
      if (!result.id) return fail("Couldn't reply", result.error!);
      return { summary: `${input.resolve ? "Resolved" : "Replied to"} a comment in ${input.path}`, path: input.path, threadId: result.id, content: input.resolve ? "Replied and resolved." : "Replied." };
    },
  },
};

export const TOOL_NAMES = Object.keys(DEFS);

/** Tools for external agents (MCP): the same set, minus Anthropic server tools. */
export function agentToolList() {
  return Object.entries(DEFS).sort(([a], [b]) => a.localeCompare(b)).map(([name, d]) => ({ name, description: d.description, input_schema: jsonSchema(d.schema) }));
}

function jsonSchema(schema: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}

/** Tool definitions for the API, in a stable order so the prompt cache holds. */
export function toolDefinitions(): Anthropic.Beta.BetaToolUnion[] {
  const custom = Object.entries(DEFS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, d]): Anthropic.Beta.BetaTool => ({
      name,
      description: d.description,
      input_schema: jsonSchema(d.schema),
      eager_input_streaming: true,
    }));
  // Literature lookups. Runs on Anthropic's servers.
  return [...custom, { type: "web_search_20260209", name: "web_search", max_uses: 5 }];
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const def = DEFS[name];
  if (!def) return fail(`Unknown tool ${name}`, `Unknown tool: ${name}`);
  // With eager input streaming the API doesn't validate inputs, and a
  // tolerant parse can hand us a truncated object; validate before running.
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) {
    return fail(`Bad input for ${name}`, `INVALID_INPUT: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  }
  try {
    return await def.run(parsed.data as never, ctx);
  } catch (err) {
    return fail(`${name} failed`, (err as Error).message || "Tool failed");
  }
}
