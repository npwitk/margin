#!/usr/bin/env node
import { hostname, platform } from "node:os";
import WebSocket from "ws";
import type { BridgeMessage, ConnectCommand, ServerToBridge, ThreadEvent } from "./protocol.js";
import { detectAgents } from "./agents.js";
import { loadConfig } from "./config.js";
import { AgentRun } from "./thread.js";
import { Workspace } from "./workspace.js";

/**
 * margin-connect: run Claude Code, Codex and other ACP agents on this
 * computer, driven from Margin in the browser. Your agents keep their own
 * sign-in, MCP servers and skills; their file changes flow into the shared
 * paper.
 */

const config = (() => {
  try { return loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
})();
const agents = detectAgents();
const runs = new Map<string, AgentRun>();
const workspaces = new Map<string, Workspace>();
const readonlyWorkspaces = new Map<string, Workspace>();
let socket: WebSocket | null = null;
let backoff = 1000;

const log = (...a: unknown[]) => console.error(new Date().toLocaleTimeString(), ...a);
const send = (msg: BridgeMessage) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); };

function workspaceFor(projectId: string, readonly = false) {
  const map = readonly ? readonlyWorkspaces : workspaces;
  let ws = map.get(projectId);
  if (!ws) { ws = new Workspace(config, projectId, readonly); map.set(projectId, ws); }
  return ws;
}

async function handle(cmd: ConnectCommand) {
  if (cmd.kind === "start") {
    const spec = agents.find((a) => a.id === cmd.agentId && a.available);
    if (!spec) throw new Error(`${cmd.agentId} isn't installed here`);
    runs.get(cmd.threadId)?.close();
    const ws = workspaceFor(cmd.projectId, !!cmd.readonly);
    const emit = (event: ThreadEvent) => send({ type: "event", threadId: cmd.threadId, event });
    ws.onEvent = emit;
    ws.mode = cmd.mode;
    ws.agentName = spec.name;
    await ws.pull();
    ws.start();
    ws.refs++;
    const run = new AgentRun(cmd.threadId, spec, ws, config, emit, cmd.handoff);
    runs.set(cmd.threadId, run);
    try {
      await run.start();
    } catch (err) {
      runs.delete(cmd.threadId);
      run.close();
      throw err;
    }
    log(`started ${spec.name} for project ${cmd.projectId} in ${ws.root}`);
    return;
  }
  const run = runs.get(cmd.threadId);
  if (!run) throw new Error("This thread isn't running on this computer");
  switch (cmd.kind) {
    case "prompt": return run.prompt(cmd.text, cmd.by);
    case "cancel": return run.cancel();
    case "permission": return run.answer(cmd.requestId, cmd.optionId);
    case "set_session_mode": return run.setSessionMode(cmd.modeId);
    case "set_apply_mode": run.workspace.mode = cmd.mode; return;
    case "close": run.close(); runs.delete(cmd.threadId); return;
  }
}

function connect() {
  const url = `${config.url.replace(/^http/, "ws")}/api/connect/bridge`;
  socket = new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` } });
  socket.on("open", () => {
    backoff = 1000;
    send({
      type: "hello",
      device: { id: config.deviceId, name: hostname().replace(/\.local$/, ""), platform: platform(), agents: agents.map(({ id, name, available, note }) => ({ id, name, available, note })) },
      threads: [...runs.keys()],
    });
    log(`connected to ${config.url} with ${agents.filter((a) => a.available).map((a) => a.name).join(", ") || "no agents"}. Open a project in Margin → Assistant to use them.`);
  });
  socket.on("message", async (data) => {
    let msg: ServerToBridge;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.type !== "command") return;
    try {
      await handle(msg.command);
      send({ type: "response", reqId: msg.reqId, ok: true });
    } catch (err) {
      send({ type: "response", reqId: msg.reqId, ok: false, error: (err as Error).message });
    }
  });
  socket.on("unexpected-response", (_req, res) => {
    if (res.statusCode === 401) { log("Margin rejected the token. Create a new one in Margin → Local and run again with --token."); process.exit(1); }
  });
  socket.on("close", () => {
    socket = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  socket.on("error", (err) => log("connection problem:", err.message));
}

const shutdown = () => {
  for (const r of runs.values()) r.close();
  for (const w of workspaces.values()) w.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
connect();
