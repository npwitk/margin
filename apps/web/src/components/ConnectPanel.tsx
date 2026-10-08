import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentThread, ApplyMode, ConnectDevice, ThreadEntry } from "@margin/shared";
import type { useConnect } from "../lib/connect.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { relativeTime } from "../lib/time.ts";
import { Icon, Spinner } from "./Icon.tsx";
import { Avatar } from "./Presence.tsx";

type Connect = ReturnType<typeof useConnect>;

interface Props {
  connect: Connect;
  device: ConnectDevice;
  agentId: string;
  onOpenFile(path: string, review?: boolean): void;
  onPickAgent(deviceId: string, agentId: string, threadId?: string): void;
  /** Open this thread when the panel shows (e.g. right after a handoff). */
  initialThreadId?: string;
  /** The document the person is viewing; the agent is told with each message. */
  doc?: string;
}

/** Chat with a local agent (Claude Code, Codex…) running through margin-connect. */
export function ConnectPanel({ connect, device, agentId, onOpenFile, onPickAgent, initialThreadId, doc }: Props) {
  const agent = device.agents.find((a) => a.id === agentId);
  const mine = connect.threads.filter((t) => t.deviceId === device.id && t.agentId === agentId && t.purpose !== "review");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<ApplyMode>("suggest");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const thread: AgentThread | undefined = threadId ? connect.open[threadId] : undefined;

  useEffect(() => { setThreadId(initialThreadId ?? null); }, [device.id, agentId, initialThreadId]);
  useEffect(() => { if (threadId && !connect.open[threadId]) connect.openThread(threadId); }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (thread) setMode(thread.mode); }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [thread?.entries.length, thread?.entries.at(-1)]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; threadId?: string }>) => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? "Something went wrong");
    return r;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      let id = threadId;
      if (!id) {
        const r = await run(() => connect.newThread(device.id, agentId, mode));
        if (!r.ok || !r.threadId) return;
        id = r.threadId;
        setThreadId(id);
      }
      setInput("");
      await run(() => connect.command(device.id, { kind: "prompt", threadId: id!, text, by: "", doc }));
    } finally {
      setBusy(false);
    }
  };

  const handoff = async (target: { deviceId: string; agentId: string }) => {
    if (!thread) return;
    const r = await run(() => connect.newThread(target.deviceId, target.agentId, mode, thread.id));
    if (r.ok && r.threadId) onPickAgent(target.deviceId, target.agentId, r.threadId);
  };

  const others = connect.devices.flatMap((d) => d.agents.filter((a) => a.available && !(d.id === device.id && a.id === agentId)).map((a) => ({ deviceId: d.id, agentId: a.id, label: `${a.name}${connect.devices.length > 1 ? ` · ${d.name}` : ""}` })));
  const running = thread?.running;
  const pendingPermission = thread?.entries.some((e) => e.type === "permission" && !e.done);

  return (
    <div className="assistant connect">
      <div className="assistant-head">
        <select value={threadId ?? ""} onChange={(e) => setThreadId(e.target.value || null)}>
          <option value="">New {agent?.name} thread</option>
          {mine.map((t) => <option key={t.id} value={t.id}>{t.title} · {relativeTime(t.updatedAt)}</option>)}
        </select>
        <div className="spacer" />
        <div className="segmented small-seg" title="How the agent's file changes reach the paper">
          <button className={mode === "suggest" ? "active" : ""} onClick={() => { setMode("suggest"); if (thread) void run(() => connect.command(device.id, { kind: "set_apply_mode", threadId: thread.id, mode: "suggest" })); }}>Suggest</button>
          <button className={mode === "edit" ? "active" : ""} onClick={() => { setMode("edit"); if (thread) void run(() => connect.command(device.id, { kind: "set_apply_mode", threadId: thread.id, mode: "edit" })); }}>Edit</button>
        </div>
      </div>
      {thread?.modes && thread.modes.length > 1 && (
        <div className="connect-bar">
          <span className="muted small">{agent?.name} mode</span>
          <select value={thread.currentMode ?? ""} onChange={(e) => void run(() => connect.command(device.id, { kind: "set_session_mode", threadId: thread.id, modeId: e.target.value }))}>
            {thread.modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="spacer" />
          {others.length > 0 && (
            <select value="" onChange={(e) => { const o = others[Number(e.target.value)]; if (o) void handoff(o); }} title="Continue this conversation with another agent">
              <option value="">Hand off to…</option>
              {others.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
            </select>
          )}
        </div>
      )}

      <div className="assistant-body" ref={scroller}>
        {!thread ? (
          <div className="assistant-empty">
            <div className="agent-mark">{agent?.name.slice(0, 1)}</div>
            <h3>{agent?.name} on {device.name}</h3>
            <p className="muted small">Runs on your computer with your own {agent?.name} sign-in, settings, MCP servers and skills. It works in a local copy of this paper; its file changes come back as {mode === "suggest" ? "suggestions you accept" : "direct edits"}, and co-authors see it working live.</p>
            {agent?.note && <p className="muted small">{agent.note}</p>}
          </div>
        ) : (
          thread.entries.map((e, i) => <Entry key={i} entry={e} agentName={thread.agentName} device={device} threadId={thread.id} connect={connect} onOpenFile={onOpenFile} />)
        )}
        {running && !pendingPermission && <div className="muted small working"><Spinner size={11} /> {thread?.agentName} is working…</div>}
      </div>

      {error && <div className="error small assistant-error">{error}</div>}
      <form className="composer-box" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea rows={2} value={input} disabled={busy || !!running}
          placeholder={running ? `${agent?.name} is working…` : `Ask ${agent?.name}… (Enter to send)`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        {running ? (
          <button type="button" className="btn" onClick={() => thread && void run(() => connect.command(device.id, { kind: "cancel", threadId: thread.id }))}>Stop</button>
        ) : (
          <button className="btn primary" disabled={!input.trim() || busy}>{busy ? <Spinner /> : <Icon name="play" size={12} />}Send</button>
        )}
      </form>
    </div>
  );
}

function Entry({ entry: e, agentName, device, threadId, connect, onOpenFile }: {
  entry: ThreadEntry; agentName: string; device: ConnectDevice; threadId: string; connect: Connect; onOpenFile(path: string, review?: boolean): void;
}) {
  switch (e.type) {
    case "user":
      return <div className="msg user"><Avatar name={e.by} size="sm" /><div className="msg-body"><div className="msg-author">{e.by}</div><div className="msg-text">{e.text}</div></div></div>;
    case "text":
      return <div className="msg assistant-msg"><span className="agent-mark sm">{agentName.slice(0, 1)}</span><div className="msg-body"><div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }} /></div></div>;
    case "thought":
      return <details className="thought"><summary>Thinking</summary><div className="small muted">{e.text}</div></details>;
    case "tool":
      return (
        <div className={`tool-row ${e.status}`}>
          {e.status === "completed" ? <Icon name="check" size={12} /> : e.status === "failed" ? <Icon name="alert" size={12} /> : <Spinner size={10} />}
          <span className="ellipsis">{e.title || "Tool"}</span>
          {e.paths?.slice(0, 2).map((p) => <button key={p} className="file-chip" onClick={() => onOpenFile(p)}>{p.split("/").pop()}</button>)}
        </div>
      );
    case "plan":
      return (
        <div className="plan">
          {e.items.map((it, i) => <div key={i} className={`plan-item ${it.status}`}><span className="plan-box">{it.status === "completed" ? "✓" : it.status === "in_progress" ? "•" : ""}</span>{it.content}</div>)}
        </div>
      );
    case "permission":
      return (
        <div className={`permission ${e.done ? "done" : ""}`}>
          <div><strong>{agentName}</strong> wants to: {e.title}</div>
          <div className="row gap">
            {e.options.map((o) => (
              <button key={o.optionId} disabled={e.done}
                className={`btn tight ${o.kind.startsWith("allow") ? "primary" : ""} ${e.chosen === o.optionId ? "chosen" : ""}`}
                onClick={() => void connect.command(device.id, { kind: "permission", threadId, requestId: e.requestId, optionId: o.optionId })}>
                {o.name}
              </button>
            ))}
            {!e.done && <button className="btn ghost tight" onClick={() => void connect.command(device.id, { kind: "permission", threadId, requestId: e.requestId, optionId: null })}>Cancel</button>}
          </div>
        </div>
      );
    case "synced":
      return (
        <button className="step link-step" onClick={() => onOpenFile(e.path, e.mode === "suggest")}>
          <Icon name={e.mode === "suggest" ? "comment" : "file"} size={12} />
          <span>{e.mode === "suggest" ? `Suggested ${e.suggestions ?? 0} edit${e.suggestions === 1 ? "" : "s"} in ${e.path}` : e.mode === "delete" ? `Deleted ${e.path}` : `Edited ${e.path}`}{e.conflicts ? ` (${e.conflicts} conflict${e.conflicts > 1 ? "s" : ""} to resolve)` : ""}</span>
        </button>
      );
    case "handoff":
      return <div className="handoff">Handed over from {e.from} to {e.to}</div>;
    case "error":
      return <div className="error small">{e.message}</div>;
    case "turn_end":
      return e.stopReason === "cancelled" ? <div className="muted small">Stopped.</div> : null;
  }
}

/** Shown when no computer is connected yet. */
export function ConnectSetup({ onCreateToken }: { onCreateToken(): void }) {
  const cmd = `npx -y margin-connect --url ${location.origin} --token <your-token>`;
  return (
    <div className="assistant-body">
      <div className="assistant-empty">
        <div className="agent-mark">⌘</div>
        <h3>Use Claude Code or Codex here</h3>
        <p className="muted small">Run Margin Connect on your computer. Your agents run there with your own sign-in, settings, MCP servers and skills, and you drive them from this panel.</p>
        <div className="code-line"><code>{cmd}</code></div>
        <p className="muted small">Until it's on npm: <code>node &lt;margin repo&gt;/packages/connect/dist/index.js --url … --token …</code></p>
        <button className="btn" onClick={onCreateToken}><Icon name="key" size={13} />Create a token</button>
        <p className="muted small">Sign in to each agent once in a terminal (<code>claude</code>, <code>codex login</code>). Using a subscription through other apps is subject to each provider's terms; an API key always works.</p>
      </div>
    </div>
  );
}

export function useAgentChoices(connect: Connect) {
  return useMemo(() => connect.devices.flatMap((d) => d.agents.map((a) => ({ device: d, agent: a }))), [connect.devices]);
}
