import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ROOM, TASK_COLUMNS, assigneesOf, withAssignees, createThread, isTextPath, lineAt, listThreads, reply, setStatus, textOf as yText, threadsOf, type Session, type Task } from "@margin/shared";
import { withDoc } from "../collab.ts";
import { compileProject } from "../compile.ts";
import { getProject, listFiles, resolvePath } from "../storage.ts";
import { textFiles, textOf } from "./paper.ts";

/**
 * Tools the project assistant can use. It can read anything, but it changes
 * text only by leaving suggestions and comments that a person accepts.
 */

export interface ToolContext {
  projectId: string;
  session: Session;
  /** Who's acting: "Claude" for the built-in assistant, or an external agent's name. */
  agentName: string;
  status(text: string, file?: string): void;
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

function occurrences(text: string, needle: string) {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0 && out.length < 50; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const DEFS: Record<string, Def> = {
  list_files: {
    description: "List every file in the project with its size. Marks the main .tex file.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      const [files, project] = await Promise.all([listFiles(ctx.projectId), getProject(ctx.projectId)]);
      const lines = files.map((f) => (f.type === "dir" ? `${f.path}/` : `${f.path} (${f.size} B)${f.path === project.mainFile ? " [main]" : ""}`));
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
      ctx.status(`Reading ${input.path}`, input.path);
      const text = await textOf(ctx.projectId, input.path);
      if (text === null) return fail(`Couldn't read ${input.path}`, `No such file: ${input.path}`);
      const lines = text.split("\n");
      const start = Math.max(1, input.start_line ?? 1);
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

  compile: {
    description: "Compile the paper with LaTeX (including everyone's latest edits) and return errors and warnings.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      ctx.status("Compiling");
      const r = await compileProject(ctx.projectId, `${ctx.agentName} (for ${ctx.session.name})`);
      const errors = r.diagnostics.filter((d) => d.severity === "error");
      const warnings = r.diagnostics.filter((d) => d.severity === "warning");
      const fmt = (d: (typeof r.diagnostics)[number]) => `${d.file ?? "?"}${d.line ? `:${d.line}` : ""}: ${d.message}`;
      const content = [
        r.ok ? "Compiled successfully." : `Compile failed${r.hasPdf ? " (an older PDF exists)" : ""}.`,
        errors.length ? `Errors:\n${errors.slice(0, 15).map(fmt).join("\n")}` : "",
        warnings.length ? `Warnings (${warnings.length}):\n${warnings.slice(0, 15).map(fmt).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      return { summary: r.ok ? `Compiled (${warnings.length} warnings)` : `Compiled: ${errors.length} error${errors.length === 1 ? "" : "s"}`, content };
    },
  },

  list_tasks: {
    description: "Show the project board: tasks, their status, assignee and linked files.",
    schema: z.object({}),
    async run(_input: Record<string, never>, ctx) {
      const tasks = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => [...doc.getMap<Task>("tasks").values()]);
      const content = TASK_COLUMNS.map((c) => {
        const items = tasks.filter((t) => t.status === c.id).sort((a, b) => a.order - b.order);
        return `${c.label}:\n${items.map((t) => `- [${t.id.slice(0, 8)}] ${t.title}${assigneesOf(t).length ? ` (${assigneesOf(t).map((a) => `@${a}`).join(", ")})` : ""}${t.files?.length ? ` files: ${t.files.join(", ")}` : ""}`).join("\n") || "- (none)"}`;
      }).join("\n\n");
      return { summary: "Checked the board", content };
    },
  },

  create_task: {
    description: "Add a task to the project board's To do column (e.g. follow-ups you can't do yourself, like running an experiment).",
    schema: z.object({
      title: z.string(),
      assignee: z.string().optional().describe("Member name, if the user asked to assign it"),
      files: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
    async run(input: { title: string; assignee?: string; files?: string[]; notes?: string }, ctx) {
      const task = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => {
        const tasks = doc.getMap<Task>("tasks");
        const order = Math.max(0, ...[...tasks.values()].filter((t) => t.status === "todo").map((t) => t.order)) + 1;
        const now = new Date().toISOString();
        const t: Task = {
          id: crypto.randomUUID(), title: input.title.slice(0, 200), status: "todo", order,
          ...(input.assignee ? withAssignees([input.assignee]) : {}), files: input.files?.filter((f) => isTextPath(f) || f.includes(".")), notes: input.notes,
          createdBy: `${ctx.agentName} (for ${ctx.session.name})`, createdAt: now, updatedAt: now,
        };
        tasks.set(t.id, t);
        return t;
      });
      return { summary: `Added task “${task.title}”`, content: `Task created (id ${task.id.slice(0, 8)}).` };
    },
  },

  update_task: {
    description: "Update a board task: claim it (assign it and move it to In progress), move it between columns, or add a note. Use the id shown by list_tasks (a prefix is enough).",
    schema: z.object({
      id: z.string(),
      status: z.enum(["todo", "doing", "review", "done"]).optional(),
      assignee: z.string().optional().describe("Member name to add as an assignee; use your user's name to claim it"),
      note: z.string().optional().describe("Appended to the task's notes"),
    }),
    async run(input: { id: string; status?: Task["status"]; assignee?: string; note?: string }, ctx) {
      const result = await withDoc(ctx.projectId, ROOM, ctx.session, (doc) => {
        const tasks = doc.getMap<Task>("tasks");
        const matches = [...tasks.values()].filter((t) => t.id.startsWith(input.id));
        if (matches.length !== 1) return { error: matches.length ? "That id matches several tasks; use more characters." : "No task with that id." };
        const t = matches[0];
        const stamp = new Date().toISOString();
        const notes = input.note ? `${t.notes ? `${t.notes}\n\n` : ""}${input.note.trim()} (${ctx.agentName} for ${ctx.session.name}, ${stamp.slice(0, 10)})` : t.notes;
        const people = assigneesOf(t);
        const next: Task = { ...t, status: input.status ?? t.status, ...(input.assignee && !people.includes(input.assignee) ? withAssignees([...people, input.assignee]) : {}), notes, updatedAt: stamp };
        tasks.set(t.id, next);
        return { task: next };
      });
      if (!result.task) return fail("Couldn't update the task", result.error!);
      const col = TASK_COLUMNS.find((c) => c.id === result.task.status)?.label;
      return { summary: `Updated task “${result.task.title}” (${col}${assigneesOf(result.task).length ? `, ${assigneesOf(result.task).map((a) => `@${a}`).join(" ")}` : ""})`, content: "Task updated." };
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
