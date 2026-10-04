import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Chat, ChatEntry, ChatEvent, ChatPart, ChatSummary, ChatToolStep, Session } from "@margin/shared";
import { setAgentActivity } from "../collab.ts";
import { DATA_DIR } from "../config.ts";
import { getProject, listFiles, projectDir } from "../storage.ts";
import { FALLBACK, MODEL, clientFor, describeApiError } from "./client.ts";
import { runTool, toolDefinitions, type ToolOutcome } from "./tools.ts";

/**
 * The project assistant: a streaming tool-use loop over the tools in
 * tools.ts. Conversation history is append-only (thinking blocks are passed
 * back unchanged) and stored per project, shared with collaborators.
 */

type StoredChat = Chat & { messages: Anthropic.Beta.BetaMessageParam[] };

const MAX_STEPS = 30;

// Frozen: anything that varies (project, member, date) goes in messages so the prompt cache holds.
const SYSTEM = `You are Claude, a research-writing collaborator inside Margin, a shared LaTeX workspace. Several human co-authors may be editing the same files live while you work; the person messaging you is named in their message.

How you change the paper:
- You cannot edit files directly. Use propose_edit to suggest a concrete change (it appears inline for the authors to accept), or add_comment for questions and concerns. Keep each suggestion to one focused change - a sentence, a paragraph, an equation - so it's easy to review.
- Read a file before suggesting edits to it, and copy \`find\` text exactly from what read_file returned (without the line-number prefix). Files change under you; if a quote no longer matches, read again.
- After LaTeX edits that could break the build, or when asked to fix errors, use compile to check.
- Never invent references. Cite only works already in the project's .bib files or ones you verified with web_search; when adding one, propose a complete BibTeX entry for the .bib file.

How you respond:
- Answer in the language the person writes in. Be concise and concrete; refer to places as path:line.
- When you've left suggestions, say briefly what you suggested and why, so the authors know what to review.
- If a request is ambiguous or needs a decision only the authors can make (claims, results, framing), ask instead of guessing.`;

const chatsDir = (projectId: string) => path.join(DATA_DIR, "chats", projectDir(projectId).split(path.sep).pop()!);
const chatFile = (projectId: string, chatId: string) => {
  if (!/^[a-z0-9-]{8,64}$/.test(chatId)) throw new Error("Chat not found");
  return path.join(chatsDir(projectId), `${chatId}.json`);
};

const running = new Map<string, AbortController>();

async function load(projectId: string, chatId: string): Promise<StoredChat> {
  const raw = await readFile(chatFile(projectId, chatId), "utf8").catch(() => null);
  if (!raw) throw new Error("Chat not found");
  return JSON.parse(raw) as StoredChat;
}

async function save(projectId: string, chat: StoredChat) {
  const file = chatFile(projectId, chat.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(chat));
  await rename(`${file}.tmp`, file);
}

const publicChat = ({ messages: _m, ...chat }: StoredChat): Chat => ({ ...chat, running: running.has(chat.id) });
const summary = ({ messages: _m, entries: _e, ...s }: StoredChat): ChatSummary => ({ ...s, running: running.has(s.id) });

export async function listChats(projectId: string): Promise<ChatSummary[]> {
  const dir = chatsDir(projectId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const chats = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => load(projectId, n.slice(0, -5)).catch(() => null)));
  return chats.filter((c): c is StoredChat => !!c).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createChat(projectId: string, by: string, title?: string): Promise<Chat> {
  const now = new Date().toISOString();
  const chat: StoredChat = { id: crypto.randomUUID(), title: title?.trim().slice(0, 80) || "New chat", createdBy: by, createdAt: now, updatedAt: now, entries: [], messages: [] };
  await save(projectId, chat);
  return publicChat(chat);
}

export const getChat = async (projectId: string, chatId: string) => publicChat(await load(projectId, chatId));

export async function deleteChat(projectId: string, chatId: string) {
  running.get(chatId)?.abort();
  await rm(chatFile(projectId, chatId), { force: true });
}

export function stopChat(chatId: string) {
  running.get(chatId)?.abort();
}

/** Project facts for the first turn; later turns rely on the conversation. */
async function projectContext(projectId: string) {
  const [project, files] = await Promise.all([getProject(projectId), listFiles(projectId)]);
  const list = files.filter((f) => f.type === "file").map((f) => `${f.path}${f.path === project.mainFile ? "  [main]" : ""}`).join("\n");
  return `<project>\nTitle: ${project.name}\nMain file: ${project.mainFile}\nEngine: ${project.engine}${project.goal ? `\nPublishing goal: ${project.goal}` : ""}\nFiles:\n${list}\n</project>`;
}

/**
 * Run one user turn: stream the model's reply to `send`, execute its tool
 * calls, and loop until it's done. Persists history as it goes.
 */
export async function runTurn(projectId: string, chatId: string, session: Session, text: string, send: (e: ChatEvent) => void) {
  if (running.has(chatId)) throw new Error("Claude is already working in this chat");
  const abort = new AbortController();
  running.set(chatId, abort);
  const chat = await load(projectId, chatId);
  const parts: ChatPart[] = [];
  const entry: ChatEntry = { role: "assistant", parts, at: new Date().toISOString() };
  let usage = { input: 0, output: 0, cacheRead: 0 };

  const status = (s: string, file?: string) => setAgentActivity(projectId, chatId, { chatId, agent: "Claude", for: session.name, status: s, file, at: Date.now() });
  const addText = (delta: string) => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += delta;
    else parts.push({ type: "text", text: delta });
  };

  try {
    const client = await clientFor(session);
    const first = chat.messages.length === 0;
    const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (first) userContent.push({ type: "text", text: await projectContext(projectId) });
    userContent.push({ type: "text", text: `${session.name} writes:\n${text}` });
    chat.messages.push({ role: "user", content: userContent });
    chat.entries.push({ role: "user", by: session.name, text, at: new Date().toISOString() }, entry);
    if (first && chat.title === "New chat") chat.title = text.replace(/\s+/g, " ").slice(0, 60);
    await save(projectId, chat);
    status("Thinking");

    const tools = toolDefinitions();
    let jsonRetries = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (abort.signal.aborted) break;
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          system: SYSTEM,
          tools,
          messages: chat.messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          cache_control: { type: "ephemeral" },
          ...FALLBACK,
        },
        { signal: abort.signal },
      );
      stream.on("text", (delta) => { addText(delta); send({ type: "text", delta }); });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // A tool input that couldn't be parsed at all: re-issue the same turn (bounded).
        if (!(err instanceof Anthropic.APIError) && !abort.signal.aborted && jsonRetries++ < 2) continue;
        throw err;
      }
      usage = {
        input: usage.input + message.usage.input_tokens,
        output: usage.output + message.usage.output_tokens,
        cacheRead: usage.cacheRead + (message.usage.cache_read_input_tokens ?? 0),
      };

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      // Show server-side web searches in the transcript.
      for (const b of message.content) {
        if (b.type === "server_tool_use" && b.name === "web_search") {
          const q = (b.input as { query?: string })?.query ?? "";
          const step: ChatPart = { type: "tool", name: "web_search", summary: `Searched the web for “${q}”`, ok: true };
          parts.push(step);
          send({ type: "tool_end", step: step as ChatToolStep });
        }
      }

      if (message.stop_reason === "refusal") {
        // Keep history valid: never leave a tool_use without its result.
        const kept = message.content.filter((b) => b.type !== "tool_use");
        if (kept.length) chat.messages.push({ role: "assistant", content: kept });
        entry.error = "Claude declined to continue with this request.";
        send({ type: "error", message: entry.error });
        break;
      }
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        const kept = message.content.filter((b) => b.type !== "tool_use");
        if (kept.length) chat.messages.push({ role: "assistant", content: kept });
        entry.error = "The reply was cut off. Try asking for a smaller change.";
        send({ type: "error", message: entry.error });
        break;
      }

      chat.messages.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn") continue; // server tool still working
      if (!toolUses.length) break;

      const results = await Promise.all(toolUses.map(async (t): Promise<[Anthropic.Beta.BetaToolUseBlock, ToolOutcome]> => {
        send({ type: "tool_start", name: t.name, summary: t.name.replace(/_/g, " ") });
        return [t, await runTool(t.name, t.input, { projectId, session, agentName: "Claude", status })];
      }));
      for (const [t, r] of results) {
        const step: ChatPart = { type: "tool", name: t.name, summary: r.summary, ok: !r.isError, path: r.path, threadId: r.threadId };
        parts.push(step);
        send({ type: "tool_end", step: step as ChatToolStep });
      }
      // All results go back in one user message.
      chat.messages.push({
        role: "user",
        content: results.map(([t, r]) => ({ type: "tool_result" as const, tool_use_id: t.id, content: r.content, is_error: r.isError || undefined })),
      });
      await save(projectId, chat);
      status("Thinking");
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      entry.error = describeApiError(err);
      send({ type: "error", message: entry.error });
      console.error("assistant:", err);
    }
  } finally {
    // An interrupted tool step must still be answered, or the next request is invalid.
    const last = chat.messages.at(-1);
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const pending = last.content.filter((b) => (b as { type: string }).type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
      if (pending.length) chat.messages.push({ role: "user", content: pending.map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, content: "Stopped by the user.", is_error: true })) });
    }
    if (abort.signal.aborted && !entry.error) entry.error = "Stopped.";
    if (!parts.length && !entry.error) entry.error = "No response.";
    chat.updatedAt = new Date().toISOString();
    await save(projectId, chat).catch(() => {});
    running.delete(chatId);
    setAgentActivity(projectId, chatId, null);
    send({ type: "done", usage });
  }
}
