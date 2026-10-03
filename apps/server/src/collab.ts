import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { Hocuspocus, type Document } from "@hocuspocus/server";
import { parseSigned } from "hono/utils/cookie";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { ROOM, diffRegion, docName, isTextPath, parseDocName, type RoomEvents, type Session, type Task } from "@margin/shared";
import { DATA_DIR, SECRET } from "./config.ts";
import { HttpError, projectDir, resolvePath } from "./storage.ts";

/**
 * Live collaboration. Every text file is a Yjs document (`<projectId>/<path>`)
 * holding a Y.Text named "content"; each project also has a room document
 * (`<projectId>/.margin`) with the task board, members and live events.
 *
 * Files on disk stay the source of truth for compile and git. Yjs state is
 * cached under DATA_DIR/ystate so reconnecting clients merge instead of
 * duplicating text, and any change made on disk while a document was closed
 * is diffed back in on load.
 */

const YSTATE_DIR = path.join(DATA_DIR, "ystate");
const BOARD_FILE = path.join(".margin", "board.json");

export interface CollabContext { session: Session }

function ystatePath(name: string) {
  const parsed = parseDocName(name)!;
  return path.join(YSTATE_DIR, parsed.projectId, `${parsed.path}.yjs`);
}

async function exists(p: string) {
  return !!(await stat(p).catch(() => null));
}

async function writeAtomic(file: string, data: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Replace a Y.Text's content with `next`, touching only the changed region. */
export function applyText(text: Y.Text, next: string) {
  const d = diffRegion(text.toString(), next);
  if (!d) return;
  text.doc!.transact(() => {
    if (d.deleteCount) text.delete(d.start, d.deleteCount);
    if (d.insert) text.insert(d.start, d.insert);
  });
}

function boardFromDoc(doc: Y.Doc): Task[] {
  return [...doc.getMap<Task>("tasks").values()].sort((a, b) => a.status.localeCompare(b.status) || a.order - b.order);
}

/** Resolve a document name to its file, or throw if it isn't something clients may open. */
function target(name: string): { projectId: string; path: string; file: string; room: boolean } {
  const parsed = parseDocName(name);
  if (!parsed) throw new HttpError(400, "Bad document name");
  if (parsed.path === ROOM) return { ...parsed, file: path.join(projectDir(parsed.projectId), BOARD_FILE), room: true };
  if (!isTextPath(parsed.path)) throw new HttpError(400, "Not a text file");
  return { ...parsed, file: resolvePath(parsed.projectId, parsed.path), room: false };
}

/** Projects whose working tree git is updating right now; disk writes wait. */
const paused = new Set<string>();

async function persist(name: string, doc: Y.Doc, { withState = true } = {}) {
  const t = target(name);
  if (paused.has(t.projectId)) return;
  if (t.room) {
    const json = JSON.stringify({ tasks: boardFromDoc(doc) }, null, 2) + "\n";
    if ((await readFile(t.file, "utf8").catch(() => "")) !== json) await writeAtomic(t.file, json);
  } else {
    // Renamed/deleted while open: don't resurrect it.
    if (!(await exists(t.file))) return;
    const text = doc.getText("content").toString();
    if ((await readFile(t.file, "utf8").catch(() => null)) !== text) await writeAtomic(t.file, text);
  }
  if (withState) await writeAtomic(ystatePath(name), Y.encodeStateAsUpdate(doc));
}

async function sessionFromHeaders(headers: Headers): Promise<Session | null> {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  const parsed = await parseSigned(cookie, SECRET, "margin_session");
  const raw = parsed.margin_session;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s?.name ? s : null;
  } catch {
    return null;
  }
}

export const hocuspocus = new Hocuspocus<CollabContext>({
  name: "margin",
  quiet: true,
  debounce: 1500,
  maxDebounce: 8000,
  timeout: 30_000,

  async onAuthenticate({ requestHeaders, documentName }) {
    const session = await sessionFromHeaders(requestHeaders);
    if (!session) throw new Error("unauthorized");
    const t = target(documentName);
    if (!(await exists(path.join(projectDir(t.projectId), ".margin", "project.json")))) throw new Error("no such project");
    if (!t.room && !(await exists(t.file))) throw new Error("no such file");
    return { session };
  },

  async onLoadDocument({ document, documentName }) {
    const t = target(documentName);
    const state = await readFile(ystatePath(documentName)).catch(() => null);
    if (state) Y.applyUpdate(document, new Uint8Array(state));

    if (t.room) {
      const tasks = document.getMap<Task>("tasks");
      if (!state && tasks.size === 0) {
        const board = await readFile(t.file, "utf8").then((s) => JSON.parse(s) as { tasks: Task[] }).catch(() => null);
        document.transact(() => board?.tasks?.forEach((task) => tasks.set(task.id, task)));
      }
    } else {
      // Bring in anything that changed on disk while nobody had this file open.
      applyText(document.getText("content"), await readFile(t.file, "utf8"));
    }
    return document;
  },

  async onStoreDocument({ document, documentName }) {
    await persist(documentName, document).catch((err) => console.error(`store ${documentName}:`, err));
  },
});

// ── Hooks for the REST API ────────────────────────────────────────────────

/** Write every open document of a project (files and board) to disk now, before compile/checkpoint. */
export async function flushProject(projectId: string) {
  const open = [...hocuspocus.documents.entries()].filter(([name]) => name.startsWith(`${projectId}/`));
  await Promise.all(open.map(([name, doc]) => persist(name, doc, { withState: false })));
}

/** Current text of a file: the live document if someone has it open, otherwise null (read the disk). */
export function liveText(projectId: string, rel: string): string | null {
  const doc = hocuspocus.documents.get(docName(projectId, rel));
  return doc ? doc.getText("content").toString() : null;
}

/** Replace a text file's content through its live document, so every editor sees the change. */
export async function writeThroughCollab(projectId: string, rel: string, content: string, session: Session) {
  const conn = await hocuspocus.openDirectConnection(docName(projectId, rel), { session });
  try {
    await conn.transact((doc) => applyText(doc.getText("content"), content));
  } finally {
    await conn.disconnect();
  }
}

/** Run a function against a file's live document (loading it if needed); changes reach every editor. */
export async function withDoc<T>(projectId: string, rel: string, session: Session, fn: (doc: Y.Doc) => T): Promise<T> {
  const conn = await hocuspocus.openDirectConnection(docName(projectId, rel), { session });
  let result!: T;
  try {
    await conn.transact((doc) => { result = fn(doc); });
  } finally {
    await conn.disconnect();
  }
  return result;
}

// ── Git push integration ──────────────────────────────────────────────────

/** Stop writing a project's documents to disk (while git rewrites its working tree). */
export async function pauseProject(projectId: string) {
  await flushProject(projectId);
  paused.add(projectId);
}

export async function resumeProject(projectId: string) {
  paused.delete(projectId);
  await flushProject(projectId);
}

/** The live document for a project path (a text file, or ROOM for the board), if open. */
export function liveDoc(projectId: string, rel: string): Y.Doc | undefined {
  return hocuspocus.documents.get(docName(projectId, rel));
}

/**
 * Change a live document as of a snapshot: take `state`, apply `fn` on a fork,
 * and merge the result in. Edits made after the snapshot are preserved by Yjs.
 */
export function mergeIntoLive(doc: Y.Doc, state: Uint8Array, fn: (fork: Y.Doc) => void) {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, state);
  fn(fork);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVectorFromUpdate(state)));
}

/** Close a document whose file is gone and drop its cached state. */
export async function dropDoc(projectId: string, rel: string) {
  hocuspocus.closeConnections(docName(projectId, rel));
  await rm(ystatePath(docName(projectId, rel)), { force: true });
}

/** Before a file or folder is renamed/deleted: save, disconnect editors and drop cached CRDT state. */
export async function releasePath(projectId: string, rel: string) {
  const affected = [...hocuspocus.documents.entries()].filter(([name]) => {
    const p = parseDocName(name)?.path;
    return name.startsWith(`${projectId}/`) && (p === rel || p?.startsWith(`${rel}/`));
  });
  for (const [name, doc] of affected) {
    await persist(name, doc, { withState: false });
    hocuspocus.closeConnections(name);
  }
  await rm(path.join(YSTATE_DIR, projectId, `${rel}.yjs`), { force: true });
  await rm(path.join(YSTATE_DIR, projectId, rel), { recursive: true, force: true });
}

/** Push a live event to everyone in the project (no-op when nobody is connected). */
export function emit<K extends keyof RoomEvents>(projectId: string, key: K, value: RoomEvents[K]) {
  const room = hocuspocus.documents.get(docName(projectId, ROOM)) as Document | undefined;
  room?.transact(() => room.getMap("events").set(key, value));
}

// ── WebSocket wiring ──────────────────────────────────────────────────────

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { headers });
}

/** Accept WebSocket upgrades on /api/collab and hand them to Hocuspocus. */
export function attachCollab(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith("/api/collab")) return socket.destroy();
    // Refuse cross-site WebSocket hijacking: the page must come from our own host.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host && !process.env.MARGIN_ALLOW_ORIGIN?.split(",").includes(origin)) {
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = hocuspocus.handleConnection(ws, toRequest(req));
      ws.on("message", (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
      ws.on("close", (code, reason) => conn.handleClose({ code, reason: reason.toString() }));
      ws.on("error", () => ws.close());
    });
  });
}

/** Save everything on shutdown. */
export async function shutdownCollab() {
  hocuspocus.flushPendingStores();
  await Promise.all([...hocuspocus.documents.entries()].map(([name, doc]) => persist(name, doc)));
}
