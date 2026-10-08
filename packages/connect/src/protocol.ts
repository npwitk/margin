// Wire protocol between margin-connect and the Margin server.
// Generated from packages/shared/src/connect.ts (types only) — keep them identical; protocol.test.ts checks.
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
