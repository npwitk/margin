import { useMemo, useState } from "react";
import { TASK_COLUMNS, colorFor, type FileEntry, type Session, type Task, type TaskStatus } from "@margin/shared";
import { useYMap, type Peer, type ProjectCollab } from "../lib/collab.ts";
import { Modal } from "./Dialog.tsx";
import { Avatar } from "./Presence.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  collab: ProjectCollab;
  session: Session;
  files: FileEntry[];
  peers: Peer[];
  onOpenFile(path: string): void;
}

const now = () => new Date().toISOString();

export function Board({ collab, session, files, peers, onOpenFile }: Props) {
  const tasksMap = useYMap(collab.tasks);
  const membersMap = useYMap(collab.members);
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [mine, setMine] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over?: string; column?: TaskStatus } | null>(null);

  const tasks = useMemo(() => [...tasksMap.values()].filter((t) => !mine || t.assignee === session.name), [tasksMap, mine, session.name]);
  const members = useMemo(() => {
    const names = new Set([session.name, ...membersMap.keys(), ...peers.map((p) => p.user.name)]);
    [...tasksMap.values()].forEach((t) => t.assignee && names.add(t.assignee));
    return [...names].sort();
  }, [membersMap, peers, tasksMap, session.name]);

  const column = (status: TaskStatus) => tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);

  const update = (task: Task, patch: Partial<Task>) => collab.tasks.set(task.id, { ...task, ...patch, updatedAt: now() });

  const create = (status: TaskStatus, title: string) => {
    const col = column(status);
    const task: Task = {
      id: crypto.randomUUID(), title, status,
      order: (col.at(-1)?.order ?? 0) + 1,
      createdBy: session.name, createdAt: now(), updatedAt: now(),
    };
    collab.tasks.set(task.id, task);
  };

  const drop = (status: TaskStatus, beforeId?: string) => {
    const task = drag && tasksMap.get(drag.id);
    setDrag(null);
    if (!task) return;
    const col = column(status).filter((t) => t.id !== task.id);
    const i = beforeId ? col.findIndex((t) => t.id === beforeId) : -1;
    let order: number;
    if (i < 0) order = (col.at(-1)?.order ?? 0) + 1;
    else order = i === 0 ? col[0].order - 1 : (col[i - 1].order + col[i].order) / 2;
    update(task, { status, order });
  };

  // Where each member is right now, for the team strip.
  const liveFile = (name: string) => peers.find((p) => p.user.name === name)?.file;
  const isLive = (t: Task) => !!t.assignee && (t.files ?? []).some((f) => peers.some((p) => p.user.name === t.assignee && p.file === f));

  return (
    <div className="board">
      <div className="team">
        {members.map((name) => {
          const doing = [...tasksMap.values()].filter((t) => t.assignee === name && (t.status === "doing" || t.status === "review"));
          const here = name === session.name || peers.some((p) => p.user.name === name);
          const file = name === session.name ? null : liveFile(name);
          return (
            <div key={name} className={`member ${here ? "" : "away"}`}>
              <Avatar name={name} online={here} />
              <div className="grow">
                <div className="member-name">{name}{name === session.name && <span className="muted"> (you)</span>}</div>
                <div className="muted small ellipsis" title={doing.map((t) => t.title).join(", ")}>
                  {doing.length ? `On: ${doing.map((t) => t.title).join(", ")}` : "Nothing in progress"}
                </div>
                {file && (
                  <div className="small ellipsis">
                    <span className="live-dot" />Editing <button className="link" onClick={() => onOpenFile(file)}>{file}</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="board-bar">
        <span className="section-label">Board</span>
        <span className="muted small">{tasksMap.size} task{tasksMap.size === 1 ? "" : "s"} · saved to .margin/board.json with each checkpoint</span>
        <div className="spacer" />
        <button className={`chip ${!mine ? "active" : ""}`} onClick={() => setMine(false)}>Everyone</button>
        <button className={`chip ${mine ? "active" : ""}`} onClick={() => setMine(true)}>Mine</button>
      </div>

      <div className="columns">
        {TASK_COLUMNS.map((c) => {
          const items = column(c.id);
          return (
            <section
              key={c.id}
              className={`column ${drag?.column === c.id && !drag.over ? "drop" : ""}`}
              onDragOver={(e) => { e.preventDefault(); if (drag) setDrag({ ...drag, column: c.id, over: undefined }); }}
              onDrop={(e) => { e.preventDefault(); drop(c.id); }}
            >
              <header className="column-head">
                <span className={`status-dot ${c.id}`} />
                <span>{c.label}</span>
                <span className="count">{items.length}</span>
                <div className="spacer" />
                <button className="icon-btn" title="Add task" onClick={() => setAdding(c.id)}><Icon name="plus" size={14} /></button>
              </header>
              <div className="cards">
                {items.map((t) => (
                  <article
                    key={t.id}
                    className={`card ${drag?.over === t.id ? "drop-before" : ""} ${drag?.id === t.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ id: t.id }); }}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (drag && drag.id !== t.id) setDrag({ ...drag, column: c.id, over: t.id }); }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(c.id, t.id); }}
                    onClick={() => setEditing(t)}
                  >
                    <div className="card-title">{t.title}</div>
                    {(t.files?.length || t.assignee || t.due) && (
                      <div className="card-meta">
                        {t.files?.map((f) => (
                          <button key={f} className="file-chip" onClick={(e) => { e.stopPropagation(); onOpenFile(f); }} title={`Open ${f}`}>
                            {f.split("/").pop()}
                          </button>
                        ))}
                        <div className="spacer" />
                        {t.due && <span className={`muted small ${t.status !== "done" && t.due < now().slice(0, 10) ? "error" : ""}`}>{t.due.slice(5)}</span>}
                        {isLive(t) && <span className="live" title={`${t.assignee} is in this file now`}>live</span>}
                        {t.assignee && <Avatar name={t.assignee} size="sm" />}
                      </div>
                    )}
                  </article>
                ))}
                {adding === c.id && (
                  <form className="card adding" onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.elements.namedItem("title") as HTMLInputElement);
                    if (input.value.trim()) create(c.id, input.value.trim());
                    input.value = "";
                  }}>
                    <input name="title" className="bare" autoFocus placeholder="Task title, then Enter" onBlur={() => setAdding(null)}
                      onKeyDown={(e) => e.key === "Escape" && setAdding(null)} />
                  </form>
                )}
                {items.length === 0 && adding !== c.id && <button className="column-empty" onClick={() => setAdding(c.id)}>+ Add a task</button>}
              </div>
            </section>
          );
        })}
      </div>

      {editing && (
        <TaskDialog
          task={tasksMap.get(editing.id) ?? editing}
          members={members}
          files={files.filter((f) => f.type === "file").map((f) => f.path)}
          onChange={(patch) => update(tasksMap.get(editing.id) ?? editing, patch)}
          onDelete={() => { collab.tasks.delete(editing.id); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TaskDialog({ task, members, files, onChange, onDelete, onClose }: {
  task: Task;
  members: string[];
  files: string[];
  onChange(patch: Partial<Task>): void;
  onDelete(): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const linked = task.files ?? [];

  return (
    <Modal onClose={() => { onChange({ title: title.trim() || task.title, notes }); onClose(); }} wide>
      <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => onChange({ title: title.trim() || task.title })} />
      <div className="fields">
        <label>Status</label>
        <select value={task.status} onChange={(e) => onChange({ status: e.target.value as TaskStatus })}>
          {TASK_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <label>Assignee</label>
        <div className="row gap">
          {task.assignee && <span className="avatar sm" style={{ background: colorFor(task.assignee) }}>{task.assignee[0].toUpperCase()}</span>}
          <select value={task.assignee ?? ""} onChange={(e) => onChange({ assignee: e.target.value || undefined })}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <label>Due</label>
        <input type="date" className="input sm" value={task.due ?? ""} onChange={(e) => onChange({ due: e.target.value || undefined })} />

        <label>Files</label>
        <div className="file-list">
          {linked.map((f) => (
            <span key={f} className="file-chip">
              {f}
              <button onClick={() => onChange({ files: linked.filter((x) => x !== f) })} title="Remove"><Icon name="x" size={11} /></button>
            </span>
          ))}
          <select value="" onChange={(e) => e.target.value && onChange({ files: [...linked, e.target.value] })}>
            <option value="">+ Link a file…</option>
            {files.filter((f) => !linked.includes(f)).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
      <textarea className="notes" placeholder="Notes, acceptance criteria, links…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => onChange({ notes })} />
      <div className="modal-actions">
        <span className="muted small grow">Created by {task.createdBy}</span>
        <button className="btn ghost danger-text" onClick={onDelete}>Delete</button>
        <button className="btn primary" onClick={() => { onChange({ title: title.trim() || task.title, notes }); onClose(); }}>Done</button>
      </div>
    </Modal>
  );
}
