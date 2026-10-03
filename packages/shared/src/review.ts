import * as Y from "yjs";

/**
 * Review threads (comments and suggested edits) live in each file's Yjs
 * document, in a Y.Map named "threads". Anchors are Yjs relative positions,
 * so a comment stays attached to its text while people type around it.
 */

export type ThreadKind = "comment" | "suggestion";
export type ThreadStatus = "open" | "resolved" | "accepted" | "rejected";

export interface ThreadMessage {
  id: string;
  author: string;
  text: string;
  at: string;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  status: ThreadStatus;
  author: string;
  createdAt: string;
  /** Y.RelativePosition JSON for the start (inclusive) and end (exclusive) of the range. */
  start: unknown;
  end: unknown;
  /** The text that was selected when the thread was created. */
  quote: string;
  /** For suggestions: what the range should be replaced with. */
  replacement?: string;
  messages: ThreadMessage[];
  closedBy?: string;
  closedAt?: string;
}

export interface ResolvedThread extends Thread {
  /** Current absolute range, or null if the anchored text was deleted. */
  from: number | null;
  to: number | null;
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) as string;
const now = () => new Date().toISOString();

export const threadsOf = (doc: Y.Doc) => doc.getMap<Thread>("threads");
export const textOf = (doc: Y.Doc) => doc.getText("content");

function absolute(doc: Y.Doc, rel: unknown): number | null {
  try {
    const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc);
    return pos ? pos.index : null;
  } catch {
    return null;
  }
}

export function resolveThread(doc: Y.Doc, t: Thread): ResolvedThread {
  const from = absolute(doc, t.start), to = absolute(doc, t.end);
  if (from === null || to === null || to < from) return { ...t, from: null, to: null };
  return { ...t, from, to };
}

export function listThreads(doc: Y.Doc): ResolvedThread[] {
  return [...threadsOf(doc).values()]
    .map((t) => resolveThread(doc, t))
    .sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
}

export function createThread(doc: Y.Doc, opts: {
  from: number;
  to: number;
  author: string;
  kind?: ThreadKind;
  message?: string;
  replacement?: string;
}): Thread {
  const text = textOf(doc);
  const from = Math.max(0, Math.min(opts.from, text.length));
  const to = Math.max(from, Math.min(opts.to, text.length));
  const thread: Thread = {
    id: uid(),
    kind: opts.kind ?? "comment",
    status: "open",
    author: opts.author,
    createdAt: now(),
    // Start sticks to the first selected character, end to the last one, so
    // typing just outside the range doesn't grow it.
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
    quote: text.toString().slice(from, to),
    replacement: opts.kind === "suggestion" ? opts.replacement ?? "" : undefined,
    messages: opts.message ? [{ id: uid(), author: opts.author, text: opts.message, at: now() }] : [],
  };
  threadsOf(doc).set(thread.id, thread);
  return thread;
}

function patch(doc: Y.Doc, id: string, fn: (t: Thread) => Thread) {
  const map = threadsOf(doc);
  const t = map.get(id);
  if (!t) throw new Error("Thread not found");
  const next = fn(t);
  map.set(id, next);
  return next;
}

export const reply = (doc: Y.Doc, id: string, author: string, text: string) =>
  patch(doc, id, (t) => ({ ...t, messages: [...t.messages, { id: uid(), author, text, at: now() }] }));

export const setStatus = (doc: Y.Doc, id: string, status: ThreadStatus, by: string) =>
  patch(doc, id, (t) => ({ ...t, status, closedBy: status === "open" ? undefined : by, closedAt: status === "open" ? undefined : now() }));

export const deleteThread = (doc: Y.Doc, id: string) => threadsOf(doc).delete(id);

/** Apply a suggestion's replacement to the text and mark it accepted. */
export function acceptSuggestion(doc: Y.Doc, id: string, by: string): boolean {
  const t = threadsOf(doc).get(id);
  if (!t || t.kind !== "suggestion" || t.status !== "open") return false;
  const r = resolveThread(doc, t);
  if (r.from === null || r.to === null) return false;
  const text = textOf(doc);
  doc.transact(() => {
    if (r.to! > r.from!) text.delete(r.from!, r.to! - r.from!);
    if (t.replacement) text.insert(r.from!, t.replacement);
    setStatus(doc, id, "accepted", by);
  });
  return true;
}

/** 1-based line number of an offset (for API listings). */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
