import { useCallback, useEffect, useState } from "react";
import type { ProjectUpdate, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import type { ProjectCollab } from "../lib/collab.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { relativeTime } from "../lib/time.ts";
import { Avatar } from "./Presence.tsx";
import { Icon, Spinner } from "./Icon.tsx";

interface Props {
  projectId: string;
  collab: ProjectCollab;
  session: Session;
  /** Advisors land here; the composer invites them to leave feedback. */
  advisor: boolean;
  onOpenFile(path: string): void;
  onOpenHistory(): void;
  onOpenBoard(): void;
  notify(message: string): void;
}

/**
 * The Updates feed: Claude's plain-language summary of each batch of saved
 * versions, and notes people post. Anyone can comment, and turn an update
 * into board tasks.
 */
export function Updates({ projectId, collab, session, advisor, onOpenFile, onOpenHistory, onOpenBoard, notify }: Props) {
  const [list, setList] = useState<ProjectUpdate[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const refresh = useCallback(() => api.updates(projectId).then(setList).catch((e) => notify(e.message)), [projectId, notify]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const events = collab.events;
    const on = (e: { keysChanged: Set<string> }) => { if (e.keysChanged.has("updatesVersion")) void refresh(); };
    events.observe(on);
    return () => events.unobserve(on);
  }, [collab, refresh]);

  const post = async () => {
    if (!draft.trim()) return;
    setPosting(true);
    try { await api.postUpdate(projectId, draft.trim()); setDraft(""); await refresh(); } catch (e) { notify((e as Error).message); }
    setPosting(false);
  };

  const summarize = async () => {
    setSummarizing(true);
    try {
      const r = await api.summarizeUpdates(projectId);
      if (!r.update) notify("Nothing new since the last update");
      await refresh();
    } catch (e) { notify((e as Error).message); }
    setSummarizing(false);
  };

  return (
    <div className="updates">
      <div className="updates-col">
        <div className="updates-head">
          <div>
            <h2>Updates</h2>
            <p className="muted small">What changed in the paper, summarized by Claude when versions are saved, and notes from the team{advisor ? "" : " and your advisor"}.</p>
          </div>
          <button className="btn" onClick={() => void summarize()} disabled={summarizing} title="Write an update now about everything since the last one">
            {summarizing ? <Spinner /> : <Icon name="sparkle" size={13} />}Summarize recent changes
          </button>
        </div>

        <form className="update-composer" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <textarea className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={advisor ? "Feedback for the team, e.g. “The second experiment doesn't support the claim in §4; try the ablation with C.”" : "Post a note: what you did, what didn't work, what's next…"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void post(); } }} />
          <div className="row gap">
            <span className="muted small grow">Markdown works. Notes can become board tasks.</span>
            <button className="btn primary" disabled={posting || !draft.trim()}>{posting ? <Spinner /> : "Post"}</button>
          </div>
        </form>

        {!list ? <Spinner /> : !list.length ? (
          <div className="empty small">No updates yet. When someone saves a named version (History → Save version), or uploads from a local copy, Claude writes one here.</div>
        ) : list.map((u) => (
          <UpdateCard key={u.id} u={u} projectId={projectId} session={session} onOpenFile={onOpenFile} onOpenHistory={onOpenHistory} onOpenBoard={onOpenBoard} notify={notify} onChange={refresh} />
        ))}
      </div>
    </div>
  );
}

function UpdateCard({ u, projectId, session, onOpenFile, onOpenHistory, onOpenBoard, notify, onChange }: {
  u: ProjectUpdate; projectId: string; session: Session; notify(m: string): void; onChange(): Promise<unknown> | void;
  onOpenFile(p: string): void; onOpenHistory(): void; onOpenBoard(): void;
}) {
  const [reply, setReply] = useState("");
  const [making, setMaking] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const comment = async () => {
    if (!reply.trim()) return;
    try { await api.commentOnUpdate(projectId, u.id, reply.trim()); setReply(""); await onChange(); } catch (e) { notify((e as Error).message); }
  };
  const makeTasks = async () => {
    setMaking(true);
    try {
      const r = await api.tasksFromUpdate(projectId, u.id);
      notify(r.tasks.length ? `Added ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} to the board: ${r.tasks.map((t) => t.title).join("; ")}` : "Claude didn't find anything to add to the board");
      await onChange();
    } catch (e) { notify((e as Error).message); }
    setMaking(false);
  };

  return (
    <article className={`update-card ${u.kind}`}>
      <header className="update-card-head">
        {u.kind === "summary" ? <Avatar name="Claude" agent size="sm" /> : <Avatar name={u.author} size="sm" />}
        <div className="grow">
          <div className="update-title">{u.title}</div>
          <div className="muted small">
            {u.kind === "summary" ? <>Changes by {u.people?.join(", ") || "the team"}</> : u.author} · {relativeTime(u.at)}
          </div>
        </div>
      </header>
      {u.body.trim() !== u.title && <div className="md update-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(u.body) }} />}
      {u.kind === "summary" && !!u.files?.length && (
        <div className="update-files">
          <button className="link small" onClick={() => setShowFiles((s) => !s)}>{u.files.length} file{u.files.length === 1 ? "" : "s"} changed</button>
          {" · "}<button className="link small" onClick={onOpenHistory}>See the changes in History</button>
          {showFiles && <div className="update-file-list">{u.files.map((f) => <button key={f} className="file-chip" onClick={() => onOpenFile(f)}>{f}</button>)}</div>}
        </div>
      )}
      {!!u.comments?.length && (
        <div className="update-comments">
          {u.comments.map((c) => (
            <div key={c.id} className="update-comment">
              <Avatar name={c.author} size="xs" />
              <div className="grow"><strong className="small">{c.author}</strong> <span className="muted small">{relativeTime(c.at)}</span>
                <div className="md small" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} /></div>
            </div>
          ))}
        </div>
      )}
      <form className="update-reply" onSubmit={(e) => { e.preventDefault(); void comment(); }}>
        <Avatar name={session.name} src={session.avatar} size="xs" />
        <input className="input" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" />
        <button type="button" className="btn tight" disabled={making} onClick={() => void makeTasks()} title="Let Claude turn this update and its replies into board tasks">
          {making ? <Spinner /> : <Icon name="task" size={13} />}Make tasks
        </button>
        {!!u.tasks?.length && <button type="button" className="link small" onClick={onOpenBoard}>{u.tasks.length} task{u.tasks.length === 1 ? "" : "s"} on the board</button>}
      </form>
    </article>
  );
}
