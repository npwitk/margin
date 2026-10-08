import { useEffect, useRef, useState } from "react";
import type { AiSettings, Chat, ChatEntry, ChatPart, ChatSummary, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { relativeTime } from "../lib/time.ts";
import { Avatar } from "./Presence.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { ConnectPanel, ConnectSetup, useAgentChoices } from "./ConnectPanel.tsx";
import { useConnect } from "../lib/connect.ts";
import { load, save } from "../lib/storage.ts";

interface Props {
  projectId: string;
  session: Session;
  settings: AiSettings | null;
  /** A prompt to send in a fresh chat (e.g. "Fix with Claude"). */
  request?: { text: string; key: number };
  onOpenSettings(): void;
  onOpenSuggestion(path: string, threadId?: string): void;
  onOpenFile(path: string, review?: boolean): void;
  onCreateToken(): void;
  /** The document the person is compiling/viewing, so agents know the context. */
  doc?: string;
}

const STARTERS = [
  "Tighten the abstract and suggest edits",
  "Check the paper compiles and fix any errors",
  "Find claims in the introduction that need a citation",
  "Split the remaining work into tasks on the board",
];

/** The ✦ panel: Margin's built-in assistant, or one of your own agents through Margin Connect. */
export function AssistantPanel(props: Props) {
  const connect = useConnect(props.projectId);
  const choices = useAgentChoices(connect);
  const [source, setSource] = useState<string>(() => load(`agentSource:${props.projectId}`, "margin"));
  useEffect(() => save(`agentSource:${props.projectId}`, source), [source, props.projectId]);
  // A "Fix with Claude" request always goes to the built-in assistant.
  useEffect(() => { if (props.request) setSource("margin"); }, [props.request]);
  const [focusThread, setFocusThread] = useState<string | undefined>();
  const [deviceId, agentId] = source.split("|");
  const choice = choices.find((c) => c.device.id === deviceId && c.agent.id === agentId);

  return (
    <div className="assistant-wrap">
      <div className="source-bar">
        <select value={choice || source === "margin" || source === "setup" ? source : "margin"} onChange={(e) => { setFocusThread(undefined); setSource(e.target.value); }}>
          <option value="margin">✦ Margin assistant (Claude API)</option>
          {choices.map((c) => (
            <option key={`${c.device.id}|${c.agent.id}`} value={`${c.device.id}|${c.agent.id}`} disabled={!c.agent.available}>
              {c.agent.name} · {c.device.name}{c.agent.available ? "" : " (not installed)"}
            </option>
          ))}
          <option value="setup">+ Use Claude Code or Codex…</option>
        </select>
        {connect.devices.length > 0 && <span className="muted small">{connect.devices.length} computer{connect.devices.length > 1 ? "s" : ""} connected</span>}
      </div>
      {source === "setup" ? <ConnectSetup onCreateToken={props.onCreateToken} />
        : choice ? <ConnectPanel connect={connect} device={choice.device} agentId={choice.agent.id} onOpenFile={props.onOpenFile} initialThreadId={focusThread} doc={props.doc}
            onPickAgent={(d, a, t) => { setFocusThread(t); setSource(`${d}|${a}`); }} />
        : <MarginAssistant {...props} />}
    </div>
  );
}

function MarginAssistant({ projectId, session, settings, request, onOpenSettings, onOpenSuggestion, doc }: Props) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [live, setLive] = useState<ChatEntry | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const handled = useRef<number | null>(null);

  const refreshList = () => api.chats(projectId).then(setChats).catch(() => {});
  useEffect(() => { void refreshList(); }, [projectId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat?.entries.length, live]);

  const open = async (id: string) => setChat(await api.chat(projectId, id));

  const send = async (text: string, fresh = false) => {
    if (!text.trim() || busy) return;
    setError(null);
    setBusy(true);
    let target = fresh ? null : chat;
    try {
      if (!target) target = await api.createChat(projectId);
      const userEntry: ChatEntry = { role: "user", by: session.name, text, at: new Date().toISOString() };
      setChat({ ...target, entries: [...target.entries, userEntry] });
      setInput("");
      const parts: ChatPart[] = [];
      const entry: ChatEntry = { role: "assistant", parts, at: new Date().toISOString() };
      setLive({ ...entry });
      await api.sendChat(projectId, target.id, text, (e) => {
        if (e.type === "text") {
          const last = parts.at(-1);
          if (last?.type === "text") last.text += e.delta;
          else parts.push({ type: "text", text: e.delta });
        } else if (e.type === "tool_end") {
          parts.push(e.step);
        } else if (e.type === "error") {
          entry.error = e.message;
        }
        setLive({ ...entry, parts: [...parts] });
      }, doc);
      setChat(await api.chat(projectId, target.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLive(null);
      setBusy(false);
      void refreshList();
    }
  };

  useEffect(() => {
    if (request && handled.current !== request.key) {
      handled.current = request.key;
      void send(request.text, true);
    }
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const noKey = settings && !settings.hasKey && !settings.shared;
  const entries = chat?.entries ?? [];

  return (
    <div className="assistant">
      <div className="assistant-head">
        <select value={chat?.id ?? ""} onChange={(e) => (e.target.value ? void open(e.target.value) : setChat(null))}>
          <option value="">New chat</option>
          {chats.map((c) => <option key={c.id} value={c.id}>{c.title} · {c.createdBy} · {relativeTime(c.updatedAt)}</option>)}
        </select>
        <div className="spacer" />
        {chat && !busy && (
          <button className="icon-btn" title="Delete chat" onClick={async () => { await api.deleteChat(projectId, chat.id); setChat(null); void refreshList(); }}>
            <Icon name="x" size={14} />
          </button>
        )}
        <button className="icon-btn" title="New chat" onClick={() => setChat(null)} disabled={busy}><Icon name="plus" size={14} /></button>
        <button className="icon-btn" title="AI settings" onClick={onOpenSettings}><Icon name="key" size={14} /></button>
      </div>

      <div className="assistant-body" ref={scroller}>
        {noKey ? (
          <div className="assistant-empty">
            <div className="spark lg">✦</div>
            <h3>Use Claude with your paper</h3>
            <p className="muted small">Add your Anthropic API key to chat with Claude about this project. It reads your files and leaves suggestions you can accept.</p>
            <button className="btn primary" onClick={onOpenSettings}>Add API key</button>
          </div>
        ) : entries.length === 0 && !live ? (
          <div className="assistant-empty">
            <div className="spark lg">✦</div>
            <h3>Ask Claude about this paper</h3>
            <p className="muted small">Claude can read every file, search, compile and check the board. It never edits directly: changes arrive as suggestions in the Review panel.</p>
            <div className="starters">
              {STARTERS.map((s) => <button key={s} className="starter" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        ) : (
          <>
            {entries.map((e, i) => <Entry key={i} entry={e} onOpenSuggestion={onOpenSuggestion} />)}
            {live && <Entry entry={live} streaming onOpenSuggestion={onOpenSuggestion} />}
          </>
        )}
      </div>

      {error && <div className="error small assistant-error">{error}</div>}
      {!noKey && (
        <form className="composer-box" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <textarea
            rows={2}
            value={input}
            placeholder={busy ? "Claude is working…" : "Ask Claude… (Enter to send, Shift+Enter for a new line)"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
            disabled={busy}
          />
          {busy ? (
            <button type="button" className="btn" onClick={() => chat && void api.stopChat(projectId, chat.id)}>Stop</button>
          ) : (
            <button className="btn primary" disabled={!input.trim()}><Icon name="play" size={12} />Send</button>
          )}
        </form>
      )}
    </div>
  );
}

function Entry({ entry, streaming, onOpenSuggestion }: { entry: ChatEntry; streaming?: boolean; onOpenSuggestion(path: string, threadId?: string): void }) {
  if (entry.role === "user") {
    return (
      <div className="msg user">
        <Avatar name={entry.by} size="sm" />
        <div className="msg-body"><div className="msg-author">{entry.by}</div><div className="msg-text">{entry.text}</div></div>
      </div>
    );
  }
  return (
    <div className="msg assistant-msg">
      <span className="spark">✦</span>
      <div className="msg-body">
        <div className="msg-author">Claude</div>
        {entry.parts.map((p, i) => p.type === "text"
          ? <div key={i} className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />
          : (
            <button key={i} className={`step ${p.ok ? "" : "failed"} ${p.path ? "link-step" : ""}`} disabled={!p.path} onClick={() => p.path && onOpenSuggestion(p.path, p.threadId)}>
              <Icon name={p.ok ? stepIcon(p.name) : "alert"} size={12} />
              <span>{p.summary}</span>
            </button>
          ))}
        {streaming && !entry.error && <div className="muted small working"><Spinner size={11} /> Working…</div>}
        {entry.error && <div className="error small">{entry.error}</div>}
      </div>
    </div>
  );
}

function stepIcon(name: string) {
  return ({ read_file: "file", list_files: "folder", search: "command", propose_edit: "comment", add_comment: "comment", compile: "play", list_tasks: "board", create_task: "board", web_search: "command" } as Record<string, string>)[name] ?? "check";
}
