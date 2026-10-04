import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { ApplyMode, ThreadEvent } from "./protocol.js";
import { marginMcpPath, spawnAgent, type AgentSpec } from "./agents.js";
import type { Config } from "./config.js";
import type { Workspace } from "./workspace.js";

/**
 * One conversation with a local agent over ACP. The agent runs in the
 * project's local copy; its updates are translated into Margin thread events.
 */
export class AgentRun {
  private proc: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private permissions = new Map<string, (outcome: acp.RequestPermissionResponse) => void>();
  private first = true;
  private busy = false;
  private stderr = "";

  constructor(
    readonly threadId: string,
    private spec: AgentSpec,
    private ws: Workspace,
    private config: Config,
    private emit: (e: ThreadEvent) => void,
    private handoff?: string,
  ) {}

  private rel(abs: string) {
    const r = abs.startsWith(this.ws.root + "/") ? abs.slice(this.ws.root.length + 1) : abs;
    return r.startsWith("/") ? undefined : r;
  }

  private onUpdate(n: acp.SessionNotification) {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.emit({ kind: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.emit({ kind: "thought", text: u.content.text });
        break;
      case "tool_call":
      case "tool_call_update":
        this.emit({
          kind: "tool", id: u.toolCallId, title: u.title ?? "", status: u.status ?? (u.sessionUpdate === "tool_call" ? "pending" : ""),
          toolKind: u.kind ?? undefined, paths: (u.locations ?? []).map((l) => this.rel(l.path)).filter((p): p is string => !!p),
        });
        break;
      case "plan":
        this.emit({ kind: "plan", items: u.entries.map((e) => ({ content: e.content, status: e.status as "pending" | "in_progress" | "completed", priority: e.priority })) });
        break;
      case "current_mode_update":
        this.emit({ kind: "mode", mode: u.currentModeId });
        break;
    }
  }

  async start() {
    this.proc = spawnAgent(this.spec, this.ws.root);
    this.proc.stderr?.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      if (this.conn) this.emit({ kind: "error", message: `${this.spec.name} exited${code ? ` (code ${code})` : ""}${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}` });
      this.conn = null;
    });
    const stream = acp.ndJsonStream(Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>);
    this.conn = new acp.ClientSideConnection(() => ({
      sessionUpdate: async (n) => this.onUpdate(n),
      requestPermission: (p) => new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        this.permissions.set(requestId, resolve);
        this.emit({ kind: "permission", requestId, title: p.toolCall.title ?? "Allow this action?", options: p.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })) });
      }),
    }), stream);

    const init = await this.withTimeout(this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "margin-connect", version: "0.1.0" },
    }), 60_000, "start");
    void init;

    const mcp = marginMcpPath();
    const mcpServers: acp.McpServer[] = mcp ? [{
      name: "margin", command: process.execPath, args: [mcp],
      env: [
        { name: "MARGIN_URL", value: this.config.url },
        { name: "MARGIN_PROJECT", value: this.ws.projectId },
        { name: "MARGIN_TOKEN", value: this.config.token },
        { name: "MARGIN_AGENT_NAME", value: this.spec.name },
      ],
    }] : [];
    try {
      const session = await this.withTimeout(this.conn.newSession({ cwd: this.ws.root, mcpServers }), 120_000, "open a session");
      this.sessionId = session.sessionId;
      this.emit({
        kind: "started", agentName: this.spec.name,
        modes: session.modes?.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description })),
        currentMode: session.modes?.currentModeId,
      });
    } catch (err) {
      throw new Error(friendly(this.spec, err));
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${this.spec.name} didn't ${what} in time${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`)), ms))]);
  }

  /** Runs in the background; progress arrives as events. */
  get workspace() { return this.ws; }

  prompt(text: string, by: string) {
    if (!this.conn || !this.sessionId) throw new Error(`${this.spec.name} isn't running`);
    if (this.busy) throw new Error(`${this.spec.name} is still working on the last message`);
    this.busy = true;
    void (async () => {
      try {
        const mode = this.ws.mode;
        this.ws.agentName = this.spec.name;
        this.ws.onEvent = this.emit;
        await this.ws.pull();
        let full = `${by}: ${text}`;
        if (this.first) {
          full = `${context(this.ws.title, this.spec.name, mode)}${this.handoff ? `\n\nYou're taking over this conversation from another agent. Transcript so far:\n<transcript>\n${this.handoff}\n</transcript>\n` : ""}\n\n${full}`;
          this.first = false;
        }
        const res = await this.conn!.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: full }] });
        await this.ws.flush();
        this.emit({ kind: "turn_end", stopReason: res.stopReason });
      } catch (err) {
        await this.ws.flush().catch(() => {});
        this.emit({ kind: "error", message: friendly(this.spec, err) });
      } finally {
        this.busy = false;
      }
    })();
  }

  async cancel() {
    for (const [id, resolve] of this.permissions) { resolve({ outcome: { outcome: "cancelled" } }); this.permissions.delete(id); }
    if (this.conn && this.sessionId) await this.conn.cancel({ sessionId: this.sessionId });
  }

  answer(requestId: string, optionId: string | null) {
    const resolve = this.permissions.get(requestId);
    if (!resolve) throw new Error("That request is no longer waiting");
    this.permissions.delete(requestId);
    resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
  }

  async setSessionMode(modeId: string) {
    if (!this.conn || !this.sessionId) throw new Error(`${this.spec.name} isn't running`);
    await this.conn.setSessionMode({ sessionId: this.sessionId, modeId });
    this.emit({ kind: "mode", mode: modeId });
  }

  close() {
    this.conn = null;
    this.proc?.kill();
  }
}

function context(title: string, agent: string, mode: ApplyMode) {
  return `[Margin] You're working in a local copy of the Margin project "${title}", a LaTeX paper that co-authors edit live in their browsers. ` +
    `Files you change here are synced into the shared paper ${mode === "edit" ? "as direct edits everyone sees immediately" : "as suggestions the authors review and accept"}, merged with their latest edits. ` +
    `Keep changes focused, don't push with git, and use the "margin" MCP tools for the board, review comments and compiling the shared paper. You are ${agent}.`;
}

function friendly(spec: AgentSpec, err: unknown) {
  const e = err as { message?: string; code?: number; data?: unknown };
  const msg = e?.message ?? String(err);
  if (/auth|login|sign in|credential|api key|unauthorized/i.test(msg) || e?.code === -32000) {
    return spec.id === "codex"
      ? "Codex needs you to sign in: run `codex login` in a terminal (or set OPENAI_API_KEY), then try again."
      : `${spec.name} needs you to sign in: run \`claude\` in a terminal once and log in, then try again.`;
  }
  return `${spec.name}: ${msg}`;
}
