// ── Margin Connect: local agents (Claude Code, Codex…) over ACP ──────────────

export type AgentId = "claude" | "codex" | (string & {});

export interface ConnectAgent {
  id: AgentId;
  name: string;
  /** Installed and runnable on that device. */
  available: boolean;
  note?: string;
}

export interface ConnectDevice {
  id: string;
  /** e.g. the computer's hostname */
  name: string;
  platform: string;
  agents: ConnectAgent[];
  connectedAt: string;
}

/** How an agent's file changes reach the paper. */
export type ApplyMode = "suggest" | "edit";

export interface SessionMode { id: string; name: string; description?: string | null }

export interface PlanItem { content: string; status: "pending" | "in_progress" | "completed"; priority?: string }

export interface PermissionOptionView { optionId: string; name: string; kind: string }

/** Everything the bridge reports about a running thread. */
export type ThreadEvent =
  | { kind: "started"; agentName: string; modes?: SessionMode[]; currentMode?: string }
  | { kind: "user"; by: string; text: string }
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; title: string; status: string; toolKind?: string; paths?: string[] }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "permission"; requestId: string; title: string; options: PermissionOptionView[] }
  | { kind: "permission_done"; requestId: string; optionId?: string }
  | { kind: "synced"; path: string; mode: ApplyMode | "delete"; suggestions?: number; conflicts?: number }
  | { kind: "mode"; mode: string }
  | { kind: "turn_end"; stopReason: string }
  | { kind: "error"; message: string };

export type ThreadEntry =
  | { type: "user"; by: string; text: string; at: string }
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; status: string; toolKind?: string; paths?: string[] }
  | { type: "plan"; items: PlanItem[] }
  | { type: "permission"; requestId: string; title: string; options: PermissionOptionView[]; chosen?: string; done: boolean }
  | { type: "synced"; path: string; mode: ApplyMode | "delete"; suggestions?: number; conflicts?: number }
  | { type: "handoff"; from: string; to: string }
  | { type: "error"; message: string }
  | { type: "turn_end"; stopReason: string };

export interface AgentThread {
  id: string;
  projectId: string;
  agentId: AgentId;
  agentName: string;
  deviceId: string;
  deviceName: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  mode: ApplyMode;
  /** "review": a read-only run whose final answer becomes a Margin review. */
  purpose?: "chat" | "review";
  reviewId?: string;
  modes?: SessionMode[];
  currentMode?: string;
  running: boolean;
  entries: ThreadEntry[];
}

/** Fold one event into a thread's transcript (used live in the browser and when storing). */
export function applyThreadEvent(t: AgentThread, e: ThreadEvent): AgentThread {
  const entries = [...t.entries];
  const last = entries.at(-1);
  switch (e.kind) {
    case "started":
      return { ...t, agentName: e.agentName, modes: e.modes ?? t.modes, currentMode: e.currentMode ?? t.currentMode };
    case "user":
      entries.push({ type: "user", by: e.by, text: e.text, at: new Date().toISOString() });
      return { ...t, entries, running: true };
    case "text":
    case "thought":
      if (last?.type === e.kind) entries[entries.length - 1] = { ...last, text: last.text + e.text };
      else entries.push({ type: e.kind, text: e.text });
      return { ...t, entries };
    case "tool": {
      const i = entries.findIndex((x) => x.type === "tool" && x.id === e.id);
      const next = { type: "tool" as const, id: e.id, title: e.title, status: e.status, toolKind: e.toolKind, paths: e.paths };
      if (i >= 0) {
        const prev = entries[i] as Extract<ThreadEntry, { type: "tool" }>;
        entries[i] = { ...prev, ...next, title: e.title || prev.title, paths: e.paths?.length ? e.paths : prev.paths, toolKind: e.toolKind ?? prev.toolKind };
      } else entries.push(next);
      return { ...t, entries };
    }
    case "plan": {
      const i = entries.findLastIndex((x) => x.type === "plan");
      // Keep one live plan per turn: replace it if nothing user-visible came after a user message.
      const lastUser = entries.findLastIndex((x) => x.type === "user");
      if (i > lastUser) entries[i] = { type: "plan", items: e.items };
      else entries.push({ type: "plan", items: e.items });
      return { ...t, entries };
    }
    case "permission":
      entries.push({ type: "permission", requestId: e.requestId, title: e.title, options: e.options, done: false });
      return { ...t, entries };
    case "permission_done": {
      const i = entries.findIndex((x) => x.type === "permission" && x.requestId === e.requestId);
      if (i >= 0) entries[i] = { ...(entries[i] as Extract<ThreadEntry, { type: "permission" }>), done: true, chosen: e.optionId };
      return { ...t, entries };
    }
    case "synced":
      entries.push({ type: "synced", path: e.path, mode: e.mode, suggestions: e.suggestions, conflicts: e.conflicts });
      return { ...t, entries };
    case "mode":
      return { ...t, currentMode: e.mode };
    case "turn_end":
      entries.push({ type: "turn_end", stopReason: e.stopReason });
      return { ...t, entries, running: false, updatedAt: new Date().toISOString() };
    case "error":
      entries.push({ type: "error", message: e.message });
      return { ...t, entries, running: false };
  }
}

/** A plain-text transcript, for handing a thread to another agent. */
export function threadTranscript(t: AgentThread, maxChars = 24_000): string {
  const lines: string[] = [];
  for (const e of t.entries) {
    if (e.type === "user") lines.push(`${e.by}: ${e.text}`);
    else if (e.type === "text") lines.push(`${t.agentName}: ${e.text}`);
    else if (e.type === "tool") lines.push(`[${t.agentName} used: ${e.title}${e.status === "failed" ? " (failed)" : ""}]`);
    else if (e.type === "synced") lines.push(`[changed ${e.path}${e.mode === "suggest" ? " as suggestions" : ""}]`);
    else if (e.type === "handoff") lines.push(`[handed over from ${e.from} to ${e.to}]`);
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

// Relay messages (bridge ⇄ server ⇄ browser).

export type ConnectCommand =
  | { kind: "start"; threadId: string; projectId: string; agentId: AgentId; mode: ApplyMode; handoff?: string; readonly?: boolean }
  | { kind: "prompt"; threadId: string; text: string; by: string; /** The document the person is viewing. */ doc?: string }
  | { kind: "cancel"; threadId: string }
  | { kind: "permission"; threadId: string; requestId: string; optionId: string | null }
  | { kind: "set_apply_mode"; threadId: string; mode: ApplyMode }
  | { kind: "set_session_mode"; threadId: string; modeId: string }
  | { kind: "close"; threadId: string };

export type BridgeMessage =
  | { type: "hello"; device: Omit<ConnectDevice, "connectedAt">; threads: string[] }
  | { type: "event"; threadId: string; event: ThreadEvent }
  | { type: "response"; reqId: string; ok: boolean; error?: string };

export type ServerToBridge = { type: "command"; reqId: string; command: ConnectCommand };

export type UiMessage =
  | { type: "subscribe"; projectId: string }
  | { type: "open"; threadId: string }
  | { type: "command"; reqId: string; deviceId: string; command: ConnectCommand | { kind: "new_thread"; agentId: AgentId; mode: ApplyMode; handoffFrom?: string } };

export type ServerToUi =
  | { type: "devices"; devices: ConnectDevice[] }
  | { type: "threads"; threads: Omit<AgentThread, "entries">[] }
  | { type: "thread"; thread: AgentThread }
  | { type: "event"; threadId: string; event: ThreadEvent }
  | { type: "response"; reqId: string; ok: boolean; error?: string; threadId?: string };
