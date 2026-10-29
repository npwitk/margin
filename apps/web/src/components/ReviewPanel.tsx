import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import {
  acceptSuggestion, createThread, deleteThread, reply, setStatus,
  type ResolvedThread, type Session, type ThreadKind,
} from "@margin/shared";
import { api } from "../lib/api.ts";
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
  /** Read-only viewers (advisors): send comments through the server instead of editing the document, and don't offer Accept. */
  remote?: { projectId: string; path: string; onError(message: string): void };
}

/** What a viewer can do to threads: on the live document, or through the API. */
interface ThreadOps {
  create(input: { from: number; to: number; kind: ThreadKind; message?: string; replacement?: string }): void;
  reply(id: string, text: string): void;
  status(id: string, status: "open" | "resolved" | "rejected"): void;
  accept?(id: string): void;
  remove(id: string): void;
}

function threadOps(doc: Y.Doc | null, me: string, remote: Props["remote"]): ThreadOps | null {
  if (remote) {
    const run = (p: Promise<unknown>) => void p.catch((e) => remote.onError((e as Error).message));
    return {
      create: (input) => run(api.addThread(remote.projectId, { path: remote.path, ...input })),
      reply: (id, text) => run(api.threadAction(remote.projectId, id, { path: remote.path, action: "reply", text })),
      status: (id, status) => run(api.threadAction(remote.projectId, id, { path: remote.path, action: status })),
      remove: (id) => run(api.threadAction(remote.projectId, id, { path: remote.path, action: "delete" })),
    };
  }
  if (!doc) return null;
  return {
    create: (input) => { createThread(doc, { ...input, author: me }); },
    reply: (id, text) => { reply(doc, id, me, text); },
    status: (id, status) => { setStatus(doc, id, status, me); },
    accept: (id) => { acceptSuggestion(doc, id, me); },
    remove: (id) => { deleteThread(doc, id); },
  };
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ReviewPanel({ doc, threads, session, activeId, draft, onDraftDone, onActivate, onClose, remote }: Props) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const list = threads.filter((t) => filter === "all" || t.status === "open");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId) listRef.current?.querySelector(`[data-id="${activeId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  const me = session.name;
  const ops = threadOps(doc, me, remote);
  return (
    <aside className="review-panel">
      <div className="review-head">
        <span className="section-label">Review</span>
        <div className="spacer" />
        <button className={`chip ${filter === "open" ? "active" : ""}`} onClick={() => setFilter("open")}>Open {threads.filter((t) => t.status === "open").length}</button>
        <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All</button>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" size={14} /></button>
      </div>
      <div className="review-list" ref={listRef}>
        {draft && ops && <Composer ops={ops} draft={draft} onDone={onDraftDone} />}
        {!draft && list.length === 0 && (
          <div className="empty small">
            {filter === "open" ? "No open comments." : "No comments yet."}<br />
            Select text and press <kbd>⌘⌥M</kbd> to comment or suggest an edit.
          </div>
        )}
        {list.map((t) => (
          <ThreadCard key={t.id} t={t} ops={ops} me={me} active={t.id === activeId} onActivate={() => onActivate(t)} />
        ))}
      </div>
    </aside>
  );
}

function Composer({ ops, draft, onDone }: { ops: ThreadOps; draft: Draft; onDone(): void }) {
  const [kind, setKind] = useState<ThreadKind>(draft.kind);
  const [message, setMessage] = useState("");
  const [replacement, setReplacement] = useState(draft.quote);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === "comment" && !message.trim()) return;
    ops.create({ from: draft.from, to: draft.to, kind, message: message.trim() || undefined, replacement: kind === "suggestion" ? replacement : undefined });
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

function ThreadCard({ t, ops, me, active, onActivate }: { t: ResolvedThread; ops: ThreadOps | null; me: string; active: boolean; onActivate(): void }) {
  const [text, setText] = useState("");
  const closed = t.status !== "open";
  const orphaned = t.from === null;
  const act = (fn: (o: ThreadOps) => unknown) => { if (ops) fn(ops); };

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
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { act((o) => o.reply(t.id, text.trim())); setText(""); } }}>
            <input className="input sm-input" placeholder="Reply…" value={text} onChange={(e) => setText(e.target.value)} />
          </form>
          <div className="row gap">
            {!closed && t.kind === "suggestion" && !orphaned && ops?.accept && (
              <button className="btn primary" onClick={() => act((o) => o.accept?.(t.id))}><Icon name="check" size={13} />Accept</button>
            )}
            {!closed && t.kind === "suggestion" && <button className="btn" onClick={() => act((o) => o.status(t.id, "rejected"))}>Reject</button>}
            {!closed && t.kind === "comment" && <button className="btn" onClick={() => act((o) => o.status(t.id, "resolved"))}><Icon name="check" size={13} />Resolve</button>}
            {closed && t.status !== "accepted" && <button className="btn ghost" onClick={() => act((o) => o.status(t.id, "open"))}>Reopen</button>}
            <div className="spacer" />
            {t.author === me && <button className="btn ghost danger-text" onClick={() => act((o) => o.remove(t.id))}>Delete</button>}
          </div>
          {closed && t.closedBy && <div className="muted small">{t.status} by {t.closedBy}</div>}
        </div>
      )}
    </div>
  );
}
