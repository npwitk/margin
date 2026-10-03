import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import {
  acceptSuggestion, createThread, deleteThread, reply, setStatus,
  type ResolvedThread, type Session, type ThreadKind,
} from "@margin/shared";
import { relativeTime } from "../lib/time.ts";
import { Avatar } from "./Presence.tsx";
import { Icon } from "./Icon.tsx";

export interface Draft { from: number; to: number; quote: string; kind: ThreadKind }

interface Props {
  doc: Y.Doc | null;
  threads: ResolvedThread[];
  session: Session;
  activeId: string | null;
  draft: Draft | null;
  onDraftDone(): void;
  onActivate(t: ResolvedThread): void;
  onClose(): void;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ReviewPanel({ doc, threads, session, activeId, draft, onDraftDone, onActivate, onClose }: Props) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const list = threads.filter((t) => filter === "all" || t.status === "open");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId) listRef.current?.querySelector(`[data-id="${activeId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  const me = session.name;
  return (
    <aside className="review">
      <div className="review-head">
        <span className="section-label">Review</span>
        <div className="spacer" />
        <button className={`chip ${filter === "open" ? "active" : ""}`} onClick={() => setFilter("open")}>Open {threads.filter((t) => t.status === "open").length}</button>
        <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All</button>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" size={14} /></button>
      </div>
      <div className="review-list" ref={listRef}>
        {draft && doc && <Composer doc={doc} draft={draft} author={me} onDone={onDraftDone} />}
        {!draft && list.length === 0 && (
          <div className="empty small">
            {filter === "open" ? "No open comments." : "No comments yet."}<br />
            Select text and press <kbd>⌘⌥M</kbd> to comment or suggest an edit.
          </div>
        )}
        {list.map((t) => (
          <ThreadCard key={t.id} t={t} doc={doc} me={me} active={t.id === activeId} onActivate={() => onActivate(t)} />
        ))}
      </div>
    </aside>
  );
}

function Composer({ doc, draft, author, onDone }: { doc: Y.Doc; draft: Draft; author: string; onDone(): void }) {
  const [kind, setKind] = useState<ThreadKind>(draft.kind);
  const [message, setMessage] = useState("");
  const [replacement, setReplacement] = useState(draft.quote);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === "comment" && !message.trim()) return;
    createThread(doc, { from: draft.from, to: draft.to, author, kind, message: message.trim() || undefined, replacement: kind === "suggestion" ? replacement : undefined });
    onDone();
  };

  return (
    <form className="thread active composer" onSubmit={submit}>
      <div className="segmented small-seg">
        <button type="button" className={kind === "comment" ? "active" : ""} onClick={() => setKind("comment")}>Comment</button>
        <button type="button" className={kind === "suggestion" ? "active" : ""} onClick={() => setKind("suggestion")}>Suggest edit</button>
      </div>
      <blockquote className="quote">{clip(draft.quote)}</blockquote>
      {kind === "suggestion" && (
        <textarea className="notes code" autoFocus value={replacement} onChange={(e) => setReplacement(e.target.value)} rows={3} placeholder="Replace with…" />
      )}
      <textarea className="notes" autoFocus={kind === "comment"} value={message} onChange={(e) => setMessage(e.target.value)} rows={2}
        placeholder={kind === "comment" ? "Write a comment…" : "Why? (optional)"}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); if (e.key === "Escape") onDone(); }} />
      <div className="row gap end">
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={kind === "comment" ? !message.trim() : replacement === draft.quote}>
          {kind === "comment" ? "Comment" : "Suggest"}
        </button>
      </div>
    </form>
  );
}

function ThreadCard({ t, doc, me, active, onActivate }: { t: ResolvedThread; doc: Y.Doc | null; me: string; active: boolean; onActivate(): void }) {
  const [text, setText] = useState("");
  const closed = t.status !== "open";
  const orphaned = t.from === null;
  const act = (fn: (d: Y.Doc) => unknown) => { if (doc) fn(doc); };

  return (
    <div className={`thread ${active ? "active" : ""} ${closed ? "closed" : ""}`} data-id={t.id} onClick={onActivate}>
      <div className="thread-head">
        <Avatar name={t.author} size="sm" />
        <span className="thread-author">{t.author}</span>
        <span className="muted small">{relativeTime(t.createdAt)}</span>
        <div className="spacer" />
        {t.kind === "suggestion" && <span className="badge">edit</span>}
        {closed && <span className={`status-chip ${t.status}`}>{t.status}</span>}
      </div>
      {orphaned && !closed ? (
        <div className="muted small">The text this was attached to was removed.</div>
      ) : t.kind === "suggestion" ? (
        <div className="diff">
          {t.quote && <del>{clip(t.quote)}</del>}
          {t.replacement && <ins>{clip(t.replacement)}</ins>}
        </div>
      ) : (
        <blockquote className="quote">{clip(t.quote)}</blockquote>
      )}
      {t.messages.map((m) => (
        <div key={m.id} className="message">
          {m.author !== t.author || m !== t.messages[0] ? <span className="message-author">{m.author}</span> : null}
          <span>{m.text}</span>
        </div>
      ))}
      {active && (
        <div className="thread-actions" onClick={(e) => e.stopPropagation()}>
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { act((d) => reply(d, t.id, me, text.trim())); setText(""); } }}>
            <input className="input sm-input" placeholder="Reply…" value={text} onChange={(e) => setText(e.target.value)} />
          </form>
          <div className="row gap">
            {!closed && t.kind === "suggestion" && !orphaned && (
              <button className="btn primary" onClick={() => act((d) => acceptSuggestion(d, t.id, me))}><Icon name="check" size={13} />Accept</button>
            )}
            {!closed && t.kind === "suggestion" && <button className="btn" onClick={() => act((d) => setStatus(d, t.id, "rejected", me))}>Reject</button>}
            {!closed && t.kind === "comment" && <button className="btn" onClick={() => act((d) => setStatus(d, t.id, "resolved", me))}><Icon name="check" size={13} />Resolve</button>}
            {closed && t.status !== "accepted" && <button className="btn ghost" onClick={() => act((d) => setStatus(d, t.id, "open", me))}>Reopen</button>}
            <div className="spacer" />
            {t.author === me && <button className="btn ghost danger-text" onClick={() => act((d) => deleteThread(d, t.id))}>Delete</button>}
          </div>
          {closed && t.closedBy && <div className="muted small">{t.status} by {t.closedBy}</div>}
        </div>
      )}
    </div>
  );
}
