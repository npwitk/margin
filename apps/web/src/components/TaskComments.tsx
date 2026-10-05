import { useEffect, useMemo, useRef, useState } from "react";
import { REACTIONS, type Session, type TaskComment } from "@margin/shared";
import { useYMap, type ProjectCollab } from "../lib/collab.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { relativeTime } from "../lib/time.ts";
import { MarkdownEditor } from "./MarkdownField.tsx";
import { Avatar } from "./Presence.tsx";
import { Icon } from "./Icon.tsx";

const now = () => new Date().toISOString();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Comments of every task, for counts on cards. */
export function useTaskComments(collab: ProjectCollab) {
  return useYMap(collab.taskComments);
}

/** Open (unresolved) threads with at least one visible comment, per task. */
export function openThreadCounts(comments: Map<string, TaskComment>) {
  const counts = new Map<string, number>();
  for (const c of comments.values()) {
    if (c.parentId || c.resolved || c.deleted) continue;
    counts.set(c.taskId, (counts.get(c.taskId) ?? 0) + 1);
  }
  return counts;
}

/** Remove a task's comments along with it. */
export function deleteTaskComments(collab: ProjectCollab, taskId: string) {
  const map = collab.taskComments;
  map.doc?.transact(() => { for (const [id, c] of map) if (c.taskId === taskId) map.delete(id); });
}

function Body({ text, members }: { text: string; members: string[] }) {
  // @Name mentions of people on the paper stand out.
  const html = useMemo(() => {
    let out = renderMarkdown(text);
    for (const m of [...members].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(`(^|[\\s>(])@${esc(m)}(?![\\w])`, "g"), `$1<span class="mention">@${m.replace(/[&<>"]/g, "")}</span>`);
    }
    return out;
  }, [text, members]);
  return <div className="md comment-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Reactions({ c, me, onToggle }: { c: TaskComment; me: string; onToggle(emoji: string): void }) {
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setPicking(false); };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [picking]);
  const used = Object.entries(c.reactions ?? {}).filter(([, who]) => who.length);
  return (
    <div className="reactions" ref={ref}>
      {used.map(([emoji, who]) => (
        <button key={emoji} className={`reaction ${who.includes(me) ? "mine" : ""}`} title={who.join(", ")} onClick={() => onToggle(emoji)}>
          <span>{emoji}</span><span className="reaction-n">{who.length}</span>
        </button>
      ))}
      <button className="reaction add" title="Add reaction" onClick={() => setPicking((p) => !p)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>
        {!used.length && <span className="small">React</span>}
      </button>
      {picking && (
        <div className="reaction-picker">
          {REACTIONS.map((e) => <button key={e} className={c.reactions?.[e]?.includes(me) ? "mine" : ""} onClick={() => { onToggle(e); setPicking(false); }}>{e}</button>)}
        </div>
      )}
    </div>
  );
}

function CommentItem({ c, me, members, isThread, onReply, collab }: {
  c: TaskComment; me: string; members: string[]; isThread: boolean; onReply?(): void; collab: ProjectCollab;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const map = collab.taskComments;
  const patch = (p: Partial<TaskComment>) => { const cur = map.get(c.id); if (cur) map.set(c.id, { ...cur, ...p }); };
  const toggle = (emoji: string) => {
    const cur = map.get(c.id);
    if (!cur) return;
    const who = cur.reactions?.[emoji] ?? [];
    const next = who.includes(me) ? who.filter((n) => n !== me) : [...who, me];
    const reactions = { ...(cur.reactions ?? {}), [emoji]: next };
    if (!next.length) delete reactions[emoji];
    map.set(c.id, { ...cur, reactions });
  };
  const remove = () => {
    // A thread with replies keeps a placeholder so the replies still make sense.
    const hasReplies = isThread && [...map.values()].some((x) => x.parentId === c.id && !x.deleted);
    if (hasReplies) patch({ deleted: true, body: "", reactions: {} });
    else map.delete(c.id);
  };

  if (c.deleted) return <div className="comment deleted"><span className="muted small">Comment deleted</span></div>;
  return (
    <div className="comment">
      <Avatar name={c.author} size="sm" />
      <div className="comment-main">
        <div className="comment-head">
          <span className="comment-author">{c.author}</span>
          <span className="muted small" title={new Date(c.createdAt).toLocaleString()}>{relativeTime(c.createdAt)}</span>
          {c.editedAt && <span className="muted small" title={`Edited ${new Date(c.editedAt).toLocaleString()}`}>· edited</span>}
        </div>
        {editing
          ? <MarkdownEditor compact initial={c.body} placeholder="Edit comment" saveLabel="Save" onCancel={() => setEditing(false)}
              onSave={(v) => { if (v.trim() && v !== c.body) patch({ body: v, editedAt: now() }); setEditing(false); }} />
          : <Body text={c.body} members={members} />}
        {!editing && (
          <div className="comment-actions">
            <Reactions c={c} me={me} onToggle={toggle} />
            {onReply && <button className="link-btn" onClick={onReply}>Reply</button>}
            {c.author === me && <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}
            {c.author === me && (confirm
              ? <><button className="link-btn danger-text" onClick={remove}>Delete?</button><button className="link-btn" onClick={() => setConfirm(false)}>Keep</button></>
              : <button className="link-btn" onClick={() => setConfirm(true)}>Delete</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

function Thread({ root, replies, me, members, collab }: { root: TaskComment; replies: TaskComment[]; me: string; members: string[]; collab: ProjectCollab }) {
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const map = collab.taskComments;
  const resolved = !!root.resolved;
  const setResolved = (on: boolean) => {
    const cur = map.get(root.id);
    if (!cur) return;
    const next = { ...cur };
    if (on) next.resolved = { by: me, at: now() }; else delete next.resolved;
    map.set(root.id, next);
    setExpanded(false);
  };
  const reply = (body: string) => {
    const c: TaskComment = { id: crypto.randomUUID(), taskId: root.taskId, parentId: root.id, author: me, body, createdAt: now() };
    map.set(c.id, c);
    setReplying(false);
  };

  if (resolved && !expanded) {
    return (
      <div className="thread resolved-collapsed">
        <Icon name="check" size={13} className="ok-text" />
        <span className="ellipsis grow"><b>{root.deleted ? "Thread" : root.author}</b>{!root.deleted && <span className="muted">: {root.body.replace(/[*_`#>~]|\$+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").slice(0, 90)}</span>}</span>
        <span className="muted small">Resolved by {root.resolved!.by} {relativeTime(root.resolved!.at)}</span>
        <button className="link-btn" onClick={() => setExpanded(true)}>Show{replies.length ? ` (${replies.length + 1})` : ""}</button>
      </div>
    );
  }

  return (
    <div className={`thread ${resolved ? "is-resolved" : ""}`}>
      <div className="thread-tools">
        {resolved
          ? <><span className="muted small">Resolved by {root.resolved!.by}</span><button className="link-btn" onClick={() => setResolved(false)}>Reopen</button><button className="link-btn" onClick={() => setExpanded(false)}>Hide</button></>
          : <button className="resolve-btn" onClick={() => setResolved(true)} title="Resolve thread"><Icon name="check" size={12} />Resolve</button>}
      </div>
      <CommentItem c={root} me={me} members={members} isThread collab={collab} onReply={resolved ? undefined : () => setReplying(true)} />
      {!!replies.length && (
        <div className="replies">
          {replies.map((r) => <CommentItem key={r.id} c={r} me={me} members={members} isThread={false} collab={collab} onReply={resolved ? undefined : () => setReplying(true)} />)}
        </div>
      )}
      {replying && (
        <div className="replies reply-box">
          <MarkdownEditor compact initial="" placeholder={`Reply to ${root.author}…`} saveLabel="Reply" onCancel={() => setReplying(false)} onSave={reply} />
        </div>
      )}
    </div>
  );
}

/** Comment threads on one task: replies, reactions, edit/delete, resolve/reopen. All live via the board's Yjs room. */
export function TaskComments({ taskId, collab, session, members }: { taskId: string; collab: ProjectCollab; session: Session; members: string[] }) {
  const all = useYMap(collab.taskComments);
  const [composing, setComposing] = useState(false);
  const [showResolved, setShowResolved] = useState(true);
  const me = session.name;

  const { threads, replies } = useMemo(() => {
    const mine = [...all.values()].filter((c) => c.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const replies = new Map<string, TaskComment[]>();
    for (const c of mine) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c]);
    // Drop deleted threads with nothing left under them.
    const threads = mine.filter((c) => !c.parentId && !(c.deleted && !(replies.get(c.id) ?? []).some((r) => !r.deleted)));
    return { threads, replies };
  }, [all, taskId]);
  const resolvedCount = threads.filter((t) => t.resolved).length;

  const add = (body: string) => {
    const c: TaskComment = { id: crypto.randomUUID(), taskId, author: me, body, createdAt: now() };
    collab.taskComments.set(c.id, c);
    setComposing(false);
  };

  return (
    <div className="task-comments">
      <div className="comments-head">
        <span className="task-section-label">Comments{threads.length ? ` · ${threads.length - resolvedCount} open` : ""}</span>
        <div className="spacer" />
        {!!resolvedCount && <button className="link-btn" onClick={() => setShowResolved((s) => !s)}>{showResolved ? "Hide" : "Show"} resolved ({resolvedCount})</button>}
      </div>
      <div className="comment-composer">
        <Avatar name={me} size="sm" />
        <div className="grow">
          {composing
            ? <MarkdownEditor compact initial="" placeholder="Add a comment… @mention someone, Markdown and $math$ work" saveLabel="Comment" onCancel={() => setComposing(false)} onSave={add} />
            : <button className="comment-placeholder" onClick={() => setComposing(true)}>Add a comment…</button>}
        </div>
      </div>
      {threads.filter((t) => showResolved || !t.resolved).map((t) => (
        <Thread key={t.id} root={t} replies={replies.get(t.id) ?? []} me={me} members={members} collab={collab} />
      ))}
    </div>
  );
}
