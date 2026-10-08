import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  applyThreadEvent, threadTranscript,
  type AgentThread, type BridgeMessage, type ConnectCommand, type ConnectDevice, type ServerToBridge, type ServerToUi, type Session, type ThreadEvent, type UiMessage,
} from "@margin/shared";
import { canAccess, memberId } from "../access.ts";
import { setAgentActivity } from "../collab.ts";
import { DATA_DIR } from "../config.ts";
import { getProject, projectDir } from "../storage.ts";

/**
 * Margin Connect relay. A member's bridge (margin-connect, running on their
 * computer) and their browser tabs both connect here; the server forwards
 * commands from the browser to the bridge and streams the agent's activity
 * back, keeping a transcript of every thread.
 */

interface Bridge { ws: WebSocket; device: ConnectDevice; member: string; session: Session; threads: Set<string> }
interface Ui { ws: WebSocket; member: string; session: Session; projectId?: string }

const bridges = new Map<string, Bridge>(); // deviceKey -> bridge
const uis = new Set<Ui>();
const pending = new Map<string, { resolve(r: { ok: boolean; error?: string }): void; timer: NodeJS.Timeout }>();
const threads = new Map<string, AgentThread>(); // cache
const saveTimers = new Map<string, NodeJS.Timeout>();

const deviceKey = (member: string, deviceId: string) => `${member}::${deviceId}`;
const send = (ws: WebSocket, msg: ServerToUi | ServerToBridge) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const threadFile = (projectId: string, id: string) => path.join(DATA_DIR, "connect", path.basename(projectDir(projectId)), `${id}.json`);

async function loadThread(projectId: string, id: string): Promise<AgentThread | null> {
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
  const cached = threads.get(id);
  if (cached) return cached;
  const raw = await readFile(threadFile(projectId, id), "utf8").catch(() => null);
  if (!raw) return null;
  const t = { ...(JSON.parse(raw) as AgentThread), running: false };
  threads.set(id, t);
  return t;
}

function saveSoon(t: AgentThread) {
  clearTimeout(saveTimers.get(t.id));
  saveTimers.set(t.id, setTimeout(async () => {
    const f = threadFile(t.projectId, t.id);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(`${f}.tmp`, JSON.stringify(t));
    await rename(`${f}.tmp`, f);
  }, 500));
}

async function listThreads(projectId: string, member: string) {
  const dir = path.dirname(threadFile(projectId, "placeholder"));
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const fromDisk = await Promise.all(names.map((n) => loadThread(projectId, n.slice(0, -5))));
  // Include threads created moments ago that aren't saved yet.
  const byId = new Map<string, AgentThread>();
  for (const t of [...fromDisk, ...threads.values()]) if (t && t.projectId === projectId) byId.set(t.id, threads.get(t.id) ?? t);
  return [...byId.values()].filter((t) => t.createdBy === member)
    .map(({ entries: _e, ...t }) => t).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const devicesOf = (member: string) => [...bridges.values()].filter((b) => b.member === member).map((b) => b.device);

function toUis(member: string, projectId: string, msg: ServerToUi) {
  for (const u of uis) if (u.member === member && u.projectId === projectId) send(u.ws, msg);
}

function broadcastDevices(member: string) {
  const devices = devicesOf(member);
  for (const u of uis) if (u.member === member) send(u.ws, { type: "devices", devices });
}

/** Reviews run on a member's agent report back through this hook (set by the reviewer). */
export interface ReviewHook {
  activity(t: AgentThread, text: string): void;
  done(t: AgentThread, answer: string): void;
  failed(t: AgentThread, message: string): void;
}
let reviewHook: ReviewHook | null = null;
export const setReviewHook = (h: ReviewHook) => { reviewHook = h; };

/** The agent's text since the last user message (its final answer). */
const lastAnswer = (t: AgentThread) => {
  const i = t.entries.findLastIndex((e) => e.type === "user");
  return t.entries.slice(i + 1).filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
};

function record(t: AgentThread, event: ThreadEvent) {
  const next = applyThreadEvent(t, event);
  if (next.purpose === "review" && reviewHook) {
    if (event.kind === "tool" && event.title) reviewHook.activity(next, event.title);
    else if (event.kind === "permission") reviewHook.activity(next, `Waiting for your permission: ${event.title}`);
    else if (event.kind === "turn_end") reviewHook.done(next, lastAnswer(next));
    else if (event.kind === "error") reviewHook.failed(next, event.message);
  }
  next.updatedAt = new Date().toISOString();
  threads.set(t.id, next);
  saveSoon(next);
  toUis(t.createdBy, t.projectId, { type: "event", threadId: t.id, event });
  // Show the agent to co-authors while it works.
  const key = `connect-${t.id}`;
  const forName = bridges.get(deviceKey(t.createdBy, t.deviceId))?.session.name ?? t.createdBy;
  if (event.kind === "tool") setAgentActivity(t.projectId, key, { chatId: key, agent: t.agentName, for: forName, status: event.title.slice(0, 120), file: event.paths?.[0], at: Date.now() });
  else if (event.kind === "user") setAgentActivity(t.projectId, key, { chatId: key, agent: t.agentName, for: forName, status: "Thinking", at: Date.now() });
  else if (event.kind === "turn_end" || event.kind === "error") setAgentActivity(t.projectId, key, null);
  return next;
}

/** Send a command to a bridge and wait for its acknowledgement. */
function command(bridge: Bridge, cmd: ConnectCommand, timeoutMs = 120_000): Promise<{ ok: boolean; error?: string }> {
  const reqId = randomBytes(8).toString("hex");
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(reqId); resolve({ ok: false, error: "The agent didn't respond in time" }); }, timeoutMs);
    pending.set(reqId, { resolve, timer });
    send(bridge.ws, { type: "command", reqId, command: cmd });
  });
}

// ── Bridge connections ────────────────────────────────────────────────────

export function handleBridge(ws: WebSocket, session: Session) {
  const member = memberId(session);
  let key: string | null = null;

  ws.on("message", async (data) => {
    let msg: BridgeMessage;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type === "hello") {
      const id = String(msg.device.id).replace(/[^\w.-]/g, "").slice(0, 64) || "device";
      key = deviceKey(member, id);
      bridges.get(key)?.ws.close(4000, "replaced");
      const device: ConnectDevice = { ...msg.device, id, name: String(msg.device.name).slice(0, 60), connectedAt: new Date().toISOString() };
      bridges.set(key, { ws, device, member, session, threads: new Set(msg.threads ?? []) });
      broadcastDevices(member);
    } else if (msg.type === "response") {
      const p = pending.get(msg.reqId);
      if (p) { clearTimeout(p.timer); pending.delete(msg.reqId); p.resolve({ ok: msg.ok, error: msg.error }); }
    } else if (msg.type === "event" && key) {
      const bridge = bridges.get(key);
      const t = threads.get(msg.threadId);
      if (!bridge || !t || t.createdBy !== member) return;
      record(t, msg.event);
    }
  });

  ws.on("close", () => {
    if (!key) return;
    const b = bridges.get(key);
    if (b?.ws !== ws) return;
    bridges.delete(key);
    for (const id of b.threads) {
      const t = threads.get(id);
      if (t?.running) record(t, { kind: "error", message: `${b.device.name} disconnected` });
    }
    broadcastDevices(member);
  });
}

// ── Browser connections ───────────────────────────────────────────────────

export function handleUi(ws: WebSocket, session: Session) {
  const ui: Ui = { ws, member: memberId(session), session };
  uis.add(ui);
  send(ws, { type: "devices", devices: devicesOf(ui.member) });
  const reply = (reqId: string, ok: boolean, error?: string, threadId?: string) => send(ws, { type: "response", reqId, ok, error, threadId });

  ws.on("message", async (data) => {
    let msg: UiMessage;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try {
      if (msg.type === "subscribe") {
        await getProject(msg.projectId);
        if (!(await canAccess(msg.projectId, session))) throw new Error("Project not found");
        ui.projectId = msg.projectId;
        send(ws, { type: "threads", threads: await listThreads(msg.projectId, ui.member) });
        return;
      }
      if (msg.type === "open") {
        if (!ui.projectId) return;
        const t = await loadThread(ui.projectId, msg.threadId);
        if (t && t.createdBy === ui.member && t.projectId === ui.projectId) send(ws, { type: "thread", thread: t });
        return;
      }
      if (msg.type !== "command") return;
      const projectId = ui.projectId;
      if (!projectId) return reply(msg.reqId, false, "Not subscribed to a project");
      const bridge = bridges.get(deviceKey(ui.member, msg.deviceId));
      if (!bridge) return reply(msg.reqId, false, "That computer isn't connected. Run margin-connect on it.");
      const cmd = msg.command;

      if (cmd.kind === "new_thread") {
        const agent = bridge.device.agents.find((a) => a.id === cmd.agentId);
        if (!agent?.available) return reply(msg.reqId, false, `${agent?.name ?? cmd.agentId} isn't available on ${bridge.device.name}`);
        let handoff: string | undefined;
        let from: AgentThread | null = null;
        if (cmd.handoffFrom) {
          from = await loadThread(projectId, cmd.handoffFrom);
          if (from && from.createdBy === ui.member) handoff = threadTranscript(from);
        }
        const now = new Date().toISOString();
        const t: AgentThread = {
          id: crypto.randomUUID(), projectId, agentId: agent.id, agentName: agent.name, deviceId: bridge.device.id, deviceName: bridge.device.name,
          title: from ? `${from.title} (→ ${agent.name})` : `New ${agent.name} thread`, createdBy: ui.member, createdAt: now, updatedAt: now,
          mode: cmd.mode, running: false, entries: from ? [...from.entries, { type: "handoff", from: from.agentName, to: agent.name }] : [],
        };
        threads.set(t.id, t);
        saveSoon(t);
        const r = await command(bridge, { kind: "start", threadId: t.id, projectId, agentId: agent.id, mode: cmd.mode, handoff });
        if (r.ok) bridge.threads.add(t.id);
        else record(t, { kind: "error", message: r.error ?? "Couldn't start the agent" });
        send(ws, { type: "thread", thread: threads.get(t.id)! });
        send(ws, { type: "threads", threads: await listThreads(projectId, ui.member) });
        return reply(msg.reqId, r.ok, r.error, t.id);
      }

      const t = await loadThread(projectId, cmd.threadId);
      if (!t || t.createdBy !== ui.member || t.projectId !== projectId) return reply(msg.reqId, false, "Thread not found");
      if (t.deviceId !== bridge.device.id) return reply(msg.reqId, false, `This thread runs on ${t.deviceName}`);

      if (cmd.kind === "prompt") {
        const text = cmd.text.trim().slice(0, 20_000);
        if (!text) return reply(msg.reqId, false, "Message is empty");
        // After a bridge restart the agent session is gone: start a new one with the transcript.
        if (!bridge.threads.has(t.id)) {
          const r = await command(bridge, { kind: "start", threadId: t.id, projectId, agentId: t.agentId, mode: t.mode, handoff: t.entries.length ? threadTranscript(t) : undefined });
          if (!r.ok) return reply(msg.reqId, false, r.error);
          bridge.threads.add(t.id);
        }
        record(t, { kind: "user", by: ui.session.name, text });
        if (t.title.startsWith("New ")) threads.set(t.id, { ...threads.get(t.id)!, title: text.replace(/\s+/g, " ").slice(0, 60) });
        // Tell the agent which document the person is looking at (not shown in the transcript).
        const doc = typeof cmd.doc === "string" && /^[^\0]{1,300}\.tex$/.test(cmd.doc) ? cmd.doc : undefined;
        const sent = doc ? `(${ui.session.name} is viewing the document ${doc}.)\n${text}` : text;
        const r = await command(bridge, { kind: "prompt", threadId: t.id, text: sent, by: ui.session.name }, 15_000);
        if (!r.ok) record(threads.get(t.id)!, { kind: "error", message: r.error ?? "The agent didn't accept the message" });
        return reply(msg.reqId, r.ok, r.error);
      }

      if (cmd.kind === "set_apply_mode") {
        threads.set(t.id, { ...t, mode: cmd.mode });
        saveSoon(threads.get(t.id)!);
      }
      const r = await command(bridge, cmd, 15_000);
      if (cmd.kind === "permission" && r.ok) record(t, { kind: "permission_done", requestId: cmd.requestId, optionId: cmd.optionId ?? undefined });
      return reply(msg.reqId, r.ok, r.error);
    } catch (err) {
      if (msg.type === "command") reply(msg.reqId, false, (err as Error).message);
    }
  });

  ws.on("close", () => uis.delete(ui));
}

/** Connected computers of a member, with their agents. */
export const devicesFor = (session: Session) => devicesOf(memberId(session));

/**
 * Start a read-only thread on one of the member's computers and send it a
 * prompt (used to run reviews on Claude Code / Codex with their own subscription).
 */
export async function startAgentThread(session: Session, projectId: string, deviceId: string, agentId: string, label: string, prompt: string, reviewId: string): Promise<AgentThread> {
  const member = memberId(session);
  const bridge = bridges.get(deviceKey(member, deviceId));
  if (!bridge) throw new Error("That computer isn't connected. Run margin-connect on it.");
  const agent = bridge.device.agents.find((a) => a.id === agentId && a.available);
  if (!agent) throw new Error(`${agentId} isn't available on ${bridge.device.name}`);
  const now = new Date().toISOString();
  const t: AgentThread = {
    id: crypto.randomUUID(), projectId, agentId: agent.id, agentName: agent.name, deviceId: bridge.device.id, deviceName: bridge.device.name,
    title: label, createdBy: member, createdAt: now, updatedAt: now, mode: "suggest", purpose: "review", reviewId, running: false, entries: [],
  };
  threads.set(t.id, t);
  saveSoon(t);
  const started = await command(bridge, { kind: "start", threadId: t.id, projectId, agentId: agent.id, mode: "suggest", readonly: true });
  if (!started.ok) throw new Error(started.error ?? `Couldn't start ${agent.name}`);
  bridge.threads.add(t.id);
  record(t, { kind: "user", by: session.name, text: label });
  const sent = await command(bridge, { kind: "prompt", threadId: t.id, text: prompt, by: session.name }, 15_000);
  if (!sent.ok) throw new Error(sent.error ?? `${agent.name} didn't accept the review`);
  return threads.get(t.id)!;
}

/** Answer a permission request on a member's thread (from the Review view). */
export async function answerPermission(session: Session, threadId: string, requestId: string, optionId: string | null) {
  const t = threads.get(threadId);
  if (!t || t.createdBy !== memberId(session)) throw new Error("Thread not found");
  const bridge = bridges.get(deviceKey(t.createdBy, t.deviceId));
  if (!bridge) throw new Error(`${t.deviceName} isn't connected`);
  const r = await command(bridge, { kind: "permission", threadId, requestId, optionId }, 15_000);
  if (!r.ok) throw new Error(r.error ?? "Couldn't answer");
  record(t, { kind: "permission_done", requestId, optionId: optionId ?? undefined });
}

export async function cancelThread(session: Session, threadId: string) {
  const t = threads.get(threadId);
  if (!t || t.createdBy !== memberId(session)) return;
  const bridge = bridges.get(deviceKey(t.createdBy, t.deviceId));
  if (bridge) await command(bridge, { kind: "cancel", threadId }, 15_000);
}

export async function getThread(projectId: string, session: Session, id: string) {
  const t = await loadThread(projectId, id);
  return t && t.createdBy === memberId(session) ? t : null;
}
