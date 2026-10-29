import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { ROOM, boardColumns, firstColumn, type Checkpoint, type ProjectUpdate, type Session, type Task, type TaskColumn } from "@margin/shared";
import { emit, withDoc } from "./collab.ts";
import { DATA_DIR } from "./config.ts";
import { diffBetween, headOf, rootOf, versionsBetween } from "./git.ts";
import { HttpError, getProject, projectDir } from "./storage.ts";
import { onVersionSaved } from "./versions.ts";
import { FALLBACK, MODEL, clientFor } from "./ai/client.ts";

/**
 * The Updates feed. After versions are saved, Claude writes a short,
 * plain-language summary of what changed, so an advisor (or a co-author
 * coming back after a week) can follow along without reading diffs. People
 * post notes too ("experiment B didn't work"), comment on any update, and
 * turn an update into board tasks.
 *
 * Named versions and uploads from local copies are summarized soon after;
 * automatic saves are batched so the feed gets at most one entry per
 * BATCH_MS of steady editing.
 */

const SOON_MS = Number(process.env.MARGIN_UPDATES_SOON_MS ?? 20_000);
const BATCH_MS = Number(process.env.MARGIN_UPDATES_BATCH_MS ?? 45 * 60_000);
const KEEP = 400;

const file = (projectId: string) => path.join(DATA_DIR, "updates", `${path.basename(projectDir(projectId))}.json`);

export async function listUpdates(projectId: string): Promise<ProjectUpdate[]> {
  const raw = await readFile(file(projectId), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : [];
}

// One writer at a time per project: summaries, notes and comments can land together.
const queues = new Map<string, Promise<unknown>>();
function change<T>(projectId: string, fn: (list: ProjectUpdate[]) => T | Promise<T>): Promise<T> {
  const run = (queues.get(projectId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const list = await listUpdates(projectId);
    const result = await fn(list);
    const f = file(projectId);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(`${f}.tmp`, JSON.stringify(list.slice(0, KEEP), null, 2));
    await rename(`${f}.tmp`, f);
    emit(projectId, "updatesVersion", Date.now());
    return result;
  });
  queues.set(projectId, run);
  return run;
}

// ── People's notes and comments ─────────────────────────────────────────────

export async function postNote(projectId: string, session: Session, input: { title?: string; body: string }) {
  const body = input.body.trim().slice(0, 8000);
  if (!body) throw new HttpError(400, "Write something first");
  const note: ProjectUpdate = {
    id: randomUUID(), kind: "note", at: new Date().toISOString(), author: session.agent ? `${session.agent} (for ${session.name})` : session.name,
    title: input.title?.trim().slice(0, 140) || body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80), body,
  };
  return change(projectId, (list) => { list.unshift(note); return note; });
}

export async function commentOn(projectId: string, session: Session, updateId: string, text: string) {
  const body = text.trim().slice(0, 4000);
  if (!body) throw new HttpError(400, "Write something first");
  return change(projectId, (list) => {
    const u = list.find((x) => x.id === updateId);
    if (!u) throw new HttpError(404, "No such update");
    const c = { id: randomUUID(), author: session.agent ? `${session.agent} (for ${session.name})` : session.name, body, at: new Date().toISOString() };
    u.comments = [...(u.comments ?? []), c];
    return c;
  });
}

// ── Summaries of saved versions ─────────────────────────────────────────────

const Summary = z.object({
  title: z.string().describe("At most 10 words, e.g. \"Rewrote related work; new ablation table\""),
  summary: z.string().describe("Markdown: 2-6 bullet points"),
});

const SYSTEM = `You write the progress feed of a research paper written in LaTeX by a small team, read by their advisor and by co-authors catching up. You get the version messages and the diff since the last update.

Write a short update in plain language:
- What changed in the paper's content and argument (sections, claims, results, figures, references), not which lines moved. Name sections and figures.
- Anything that looks unfinished, a TODO, or a question the authors left for others.
- Skip formatting-only and whitespace changes unless that's all there is.
Never invent results or numbers that aren't in the diff. Be brief; no preamble.`;

/** Plain list when Claude isn't available. */
function plainSummary(versions: Checkpoint[], files: string[]) {
  const named = versions.filter((v) => v.kind === "named" || v.kind === "local").map((v) => `- ${v.message}`);
  return {
    title: named.length === 1 ? named[0].slice(2, 80) : `Changes to ${files.length} file${files.length === 1 ? "" : "s"}`,
    summary: [...named, `- Files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ` and ${files.length - 12} more` : ""}`].join("\n"),
  };
}

const running = new Set<string>();

/** Summarize everything since the last summary. Returns null when there's nothing new. */
export async function summarizeNow(projectId: string, session?: Session): Promise<ProjectUpdate | null> {
  if (running.has(projectId)) return null;
  running.add(projectId);
  try {
    const dir = projectDir(projectId);
    const last = (await listUpdates(projectId)).find((u) => u.kind === "summary");
    const head = await headOf(dir);
    if (last?.to === head) return null;
    // The first update starts after the project was created (its template isn't news).
    const from = last?.to ?? await rootOf(dir);
    const versions = await versionsBetween(dir, from, head);
    const changes = versions.filter((v) => v.files?.length);
    if (!changes.length) return null;
    const files = [...new Set(changes.flatMap((v) => v.files!.map((f) => f.path)))].filter((f) => !f.startsWith(".margin/"));
    const people = [...new Set(changes.flatMap((v) => v.people ?? [v.author]))].filter((p) => p !== "Margin");
    if (!files.length) return null;

    let result = plainSummary(changes, files);
    try {
      const project = await getProject(projectId);
      const diff = await diffBetween(dir, from, head);
      const client = await clientFor(session ?? { name: people[0] ?? "Margin" });
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: "low", format: betaZodOutputFormat(Summary) },
        ...FALLBACK,
        messages: [{
          role: "user",
          content: `<paper>${project.name}${project.goal ? ` (aiming for ${project.goal})` : ""}</paper>
<versions>
${changes.map((v) => `- ${v.date.slice(0, 16)} ${v.kind === "local" ? "uploaded from a local copy" : v.kind} by ${(v.people ?? [v.author]).join(", ")}: ${v.message}`).join("\n")}
</versions>
<files_changed>
${diff.stat}
</files_changed>
<diff${diff.truncated ? ' truncated="true"' : ""}>
${diff.patch}
</diff>

Write the update.`,
        }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason !== "refusal" && message.stop_reason !== "max_tokens") {
        const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
        result = Summary.parse(JSON.parse(text));
      }
    } catch (err) {
      // No API key, or the API failed: keep the plain list rather than nothing.
      console.error(`update summary ${projectId}:`, (err as Error).message);
    }

    const update: ProjectUpdate = {
      id: randomUUID(), kind: "summary", at: new Date().toISOString(), author: "Claude",
      title: result.title.slice(0, 140), body: result.summary, from, to: head, people, files,
    };
    return await change(projectId, (list) => { list.unshift(update); return update; });
  } finally {
    running.delete(projectId);
  }
}

const timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();

/** Summarize soon (named versions, uploads) or at the next batch time (automatic saves). */
export async function scheduleSummary(projectId: string, soon: boolean) {
  const last = (await listUpdates(projectId)).find((u) => u.kind === "summary");
  const at = soon ? Date.now() + SOON_MS : Math.max(Date.now() + SOON_MS, (last ? Date.parse(last.at) : 0) + BATCH_MS);
  const pending = timers.get(projectId);
  if (pending && pending.at <= at) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    timers.delete(projectId);
    void summarizeNow(projectId).catch((err) => console.error(`summarize ${projectId}:`, err));
  }, at - Date.now());
  timer.unref();
  timers.set(projectId, { at, timer });
}

/** Write the feed as versions are saved (call once at startup). */
export function startUpdates() {
  onVersionSaved((projectId, cp) => {
    if (cp.kind === "restore" || cp.kind === "other" || !cp.files?.length) return;
    void scheduleSummary(projectId, cp.kind === "named").catch(() => {});
  });
}

// ── Turning an update into board tasks ─────────────────────────────────────

const Tasks = z.object({
  tasks: z.array(z.object({
    title: z.string().describe("Imperative, at most 12 words"),
    notes: z.string().describe("One or two sentences of context, or empty"),
    assignee: z.string().describe("A member's exact name if the text says who should do it, else empty"),
  })).describe("0-8 concrete next steps"),
});

export async function tasksFromUpdate(projectId: string, session: Session, updateId: string) {
  const update = (await listUpdates(projectId)).find((u) => u.id === updateId);
  if (!update) throw new HttpError(404, "No such update");
  const board = await withDoc(projectId, ROOM, session, (doc) => ({
    tasks: [...doc.getMap<Task>("tasks").values()].map((t) => t.title),
    columns: boardColumns(doc.getMap<TaskColumn[]>("board").get("columns")),
    members: [...doc.getMap("members").keys()],
  }));
  const client = await clientFor(session);
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: "You turn notes about a research paper's progress into concrete tasks for the team's board. Only include work the text asks for or clearly implies; skip anything already on the board. If nothing needs doing, return no tasks.",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(Tasks) },
    ...FALLBACK,
    messages: [{
      role: "user",
      content: `<update author="${update.author}" title="${update.title}">
${update.body}
${(update.comments ?? []).map((c) => `\n${c.author}: ${c.body}`).join("")}
</update>
<board>
${board.tasks.map((t) => `- ${t}`).join("\n") || "(empty)"}
</board>
<members>${board.members.join(", ")}</members>`,
    }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(400, "Claude declined to make tasks from this update.");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Claude's answer was cut off. Try again.");
  const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const { tasks } = Tasks.parse(JSON.parse(text));

  const created = await withDoc(projectId, ROOM, session, (doc) => {
    const map = doc.getMap<Task>("tasks");
    const column = firstColumn(boardColumns(doc.getMap<TaskColumn[]>("board").get("columns")));
    let order = Math.max(0, ...[...map.values()].filter((t) => t.status === column.id).map((t) => t.order));
    let number = Math.max(0, ...[...map.values()].map((t) => t.number ?? 0));
    const now = new Date().toISOString();
    return tasks.map((t) => {
      const task: Task = {
        id: randomUUID(), title: t.title.slice(0, 200), status: column.id, order: ++order, number: ++number,
        notes: [t.notes.trim(), `From the update “${update.title}” (${update.author}, ${update.at.slice(0, 10)}).`].filter(Boolean).join("\n\n"),
        ...(t.assignee && board.members.includes(t.assignee) ? { assignee: t.assignee, assignees: [t.assignee] } : {}),
        createdBy: `Claude (for ${session.name})`, createdAt: now, updatedAt: now,
      };
      map.set(task.id, task);
      return task;
    });
  });
  if (created.length) {
    await change(projectId, (list) => {
      const u = list.find((x) => x.id === updateId);
      if (u) u.tasks = [...(u.tasks ?? []), ...created.map((t) => t.id)];
    });
  }
  return created;
}
