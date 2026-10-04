import { useEffect, useMemo, useState } from "react";
import { TASK_COLUMNS, TASK_PRIORITIES, type FileEntry, type Session, type Task, type TaskPriority, type TaskStatus } from "@margin/shared";
import { rememberAvatars } from "../lib/avatars.ts";
import { useYMap, type Peer, type ProjectCollab } from "../lib/collab.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Avatar } from "./Presence.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  collab: ProjectCollab;
  session: Session;
  files: FileEntry[];
  peers: Peer[];
  projectName: string;
  onOpenFile(path: string): void;
}

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

/** "SIEMCrypt" → "SIEM", "Article paper" → "AP". */
const prefixOf = (name: string) => {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "T");
  return p.slice(0, 4).toUpperCase();
};

/** Jira-style priority arrows. */
export function PriorityIcon({ priority, size = 14 }: { priority?: TaskPriority; size?: number }) {
  if (!priority) return null;
  const d: Record<TaskPriority, string> = {
    highest: "M6 11l6-6 6 6M6 17l6-6 6 6", high: "M6 15l6-6 6 6", medium: "M6 9h12M6 15h12",
    low: "M6 9l6 6 6-6", lowest: "M6 7l6 6 6-6M6 13l6 6 6-6",
  };
  return (
    <svg className={`prio prio-${priority}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-label={`${priority} priority`}>
      <title>{`${priority[0].toUpperCase()}${priority.slice(1)} priority`}</title>
      <path d={d[priority]} />
    </svg>
  );
}

const LABEL_HUES = [210, 150, 30, 280, 350, 190, 100, 50];
const labelHue = (l: string) => LABEL_HUES[[...l].reduce((a, c) => a + c.charCodeAt(0), 0) % LABEL_HUES.length];
const Label = ({ text, onRemove }: { text: string; onRemove?(): void }) => (
  <span className="lozenge" style={{ "--hue": labelHue(text) } as React.CSSProperties}>
    {text}
    {onRemove && <button onClick={onRemove} title="Remove label"><Icon name="x" size={10} /></button>}
  </span>
);

export function Board({ collab, session, files, peers, projectName, onOpenFile }: Props) {
  const tasksMap = useYMap(collab.tasks);
  const membersMap = useYMap(collab.members);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [mine, setMine] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over?: string; column?: TaskStatus } | null>(null);

  // GitHub pictures of the project's members (stored in the room by each person's browser).
  useEffect(() => { rememberAvatars([...membersMap].map(([name, m]) => [name, m.avatar])); }, [membersMap]);

  const prefix = prefixOf(projectName);
  // Stable numbers: stored ones first, then creation order for older tasks.
  const numbers = useMemo(() => {
    const all = [...tasksMap.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const m = new Map<string, number>();
    let next = Math.max(0, ...all.map((t) => t.number ?? 0));
    for (const t of all) m.set(t.id, t.number ?? ++next);
    return m;
  }, [tasksMap]);
  const keyOf = (t: Task) => `${prefix}-${numbers.get(t.id) ?? "?"}`;

  const tasks = useMemo(() => [...tasksMap.values()].filter((t) => !mine || t.assignee === session.name), [tasksMap, mine, session.name]);
  const members = useMemo(() => {
    const names = new Set([session.name, ...membersMap.keys(), ...peers.filter((p) => !p.user.agent).map((p) => p.user.name)]);
    [...tasksMap.values()].forEach((t) => t.assignee && names.add(t.assignee));
    return [...names].sort();
  }, [membersMap, peers, tasksMap, session.name]);
  const allLabels = useMemo(() => [...new Set([...tasksMap.values()].flatMap((t) => t.labels ?? []))].sort(), [tasksMap]);

  const column = (status: TaskStatus) => tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);

  const update = (task: Task, patch: Partial<Task>) => collab.tasks.set(task.id, { ...task, ...patch, updatedAt: now() });

  const create = (status: TaskStatus, title: string) => {
    const col = column(status);
    const task: Task = {
      id: crypto.randomUUID(), title, status,
      order: (col.at(-1)?.order ?? 0) + 1,
      number: Math.max(0, ...numbers.values()) + 1,
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
  const editingTask = editing ? tasksMap.get(editing) : undefined;

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
                <span className={`status-dot st-${c.id}`} />
                <span className="column-title">{c.label}</span>
                <span className="count">{items.length}</span>
                <div className="spacer" />
                <button className="icon-btn" title="Add task" onClick={() => setAdding(c.id)}><Icon name="plus" size={14} /></button>
              </header>
              <div className="cards">
                {items.map((t) => {
                  const overdue = !!t.due && t.status !== "done" && t.due < today();
                  return (
                    <article
                      key={t.id}
                      className={`task-card ${drag?.over === t.id ? "drop-before" : ""} ${drag?.id === t.id ? "dragging" : ""} ${t.status === "done" ? "is-done" : ""}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ id: t.id }); }}
                      onDragEnd={() => setDrag(null)}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (drag && drag.id !== t.id) setDrag({ ...drag, column: c.id, over: t.id }); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(c.id, t.id); }}
                      onClick={() => setEditing(t.id)}
                    >
                      <div className="task-card-title">{t.title}</div>
                      {!!t.labels?.length && <div className="task-card-labels">{t.labels.map((l) => <Label key={l} text={l} />)}</div>}
                      {!!t.files?.length && (
                        <div className="task-card-files">
                          {t.files.slice(0, 3).map((f) => (
                            <button key={f} className="file-chip" onClick={(e) => { e.stopPropagation(); onOpenFile(f); }} title={`Open ${f}`}>{f.split("/").pop()}</button>
                          ))}
                          {t.files.length > 3 && <span className="muted small">+{t.files.length - 3}</span>}
                        </div>
                      )}
                      <div className="task-card-foot">
                        <span className={`type-icon ${t.status === "done" ? "done" : ""}`}><Icon name="check" size={10} /></span>
                        <span className={`task-key ${t.status === "done" ? "done" : ""}`}>{keyOf(t)}</span>
                        <PriorityIcon priority={t.priority} />
                        {t.due && <span className={`due ${overdue ? "overdue" : ""}`} title={overdue ? "Overdue" : "Due"}><Icon name="calendar" size={11} />{new Date(`${t.due}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
                        {!!t.notes?.trim() && <span className="muted" title="Has a description"><Icon name="comment" size={12} /></span>}
                        <div className="spacer" />
                        {isLive(t) && <span className="live" title={`${t.assignee} is in this file now`}>live</span>}
                        {t.assignee
                          ? <Avatar name={t.assignee} size="sm" title={`Assignee: ${t.assignee}`} />
                          : <span className="avatar sm unassigned" title="Unassigned"><Icon name="plus" size={10} /></span>}
                      </div>
                    </article>
                  );
                })}
                {adding === c.id && (
                  <form className="task-card adding" onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.elements.namedItem("title") as HTMLInputElement);
                    if (input.value.trim()) create(c.id, input.value.trim());
                    input.value = "";
                  }}>
                    <input name="title" className="bare" autoFocus placeholder="What needs to be done?" onBlur={() => setAdding(null)}
                      onKeyDown={(e) => e.key === "Escape" && setAdding(null)} />
                  </form>
                )}
                {adding !== c.id && <button className="column-add" onClick={() => setAdding(c.id)}><Icon name="plus" size={13} />Create</button>}
              </div>
            </section>
          );
        })}
      </div>

      {editingTask && (
        <TaskDialog
          task={editingTask}
          taskKey={keyOf(editingTask)}
          members={members}
          labels={allLabels}
          files={files.filter((f) => f.type === "file").map((f) => f.path)}
          onOpenFile={(f) => { setEditing(null); onOpenFile(f); }}
          onChange={(patch) => { const cur = tasksMap.get(editingTask.id); if (cur) update(cur, patch); }}
          onDelete={() => { collab.tasks.delete(editingTask.id); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TaskDialog({ task, taskKey, members, labels, files, onOpenFile, onChange, onDelete, onClose }: {
  task: Task;
  taskKey: string;
  members: string[];
  labels: string[];
  files: string[];
  onOpenFile(path: string): void;
  onChange(patch: Partial<Task>): void;
  onDelete(): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [label, setLabel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const linked = task.files ?? [];
  const own = task.labels ?? [];

  const commit = () => {
    const patch: Partial<Task> = {};
    if ((title.trim() || task.title) !== task.title) patch.title = title.trim() || task.title;
    if (notes !== (task.notes ?? "")) patch.notes = notes;
    if (Object.keys(patch).length) onChange(patch);
  };
  const close = () => { commit(); onClose(); };
  const addLabel = (l: string) => {
    const v = l.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 24);
    if (v && !own.includes(v)) onChange({ labels: [...own, v] });
    setLabel("");
  };

  return (
    <Modal onClose={close} className="task-modal">
      <div className="task-modal-head">
        <span className={`type-icon ${task.status === "done" ? "done" : ""}`}><Icon name="check" size={10} /></span>
        <span className="task-key">{taskKey}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={close} title="Close"><Icon name="x" /></button>
      </div>
      <div className="task-modal-body">
        <div className="task-main">
          <textarea className="task-title-input" rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />

          <div className="task-section-label">Description</div>
          <textarea className="notes task-desc" placeholder="Add a description: what to write, acceptance criteria, links…" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={commit} />

          <div className="task-section-label">Linked files</div>
          <div className="task-files">
            {linked.map((f) => (
              <div key={f} className="task-file">
                <Icon name="file" size={14} className="muted" />
                <button className="link grow ellipsis" onClick={() => onOpenFile(f)} title={`Open ${f}`}>{f}</button>
                <button className="icon-btn" onClick={() => onChange({ files: linked.filter((x) => x !== f) })} title="Unlink"><Icon name="x" size={12} /></button>
              </div>
            ))}
            <select className="task-add-file" value="" onChange={(e) => e.target.value && onChange({ files: [...linked, e.target.value] })}>
              <option value="">+ Link a file…</option>
              {files.filter((f) => !linked.includes(f)).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>

        <aside className="task-side">
          <select className={`status-select st-${task.status}`} value={task.status} onChange={(e) => onChange({ status: e.target.value as TaskStatus })} aria-label="Status">
            {TASK_COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>

          <div className="task-details">
            <div className="task-details-head">Details</div>
            <div className="detail-row">
              <span className="detail-label">Assignee</span>
              <div className="detail-value">
                {task.assignee ? <Avatar name={task.assignee} size="sm" /> : <span className="avatar sm unassigned"><Icon name="plus" size={10} /></span>}
                <select className="bare-select" value={task.assignee ?? ""} onChange={(e) => onChange({ assignee: e.target.value || undefined })}>
                  <option value="">Unassigned</option>
                  {members.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div className="detail-row">
              <span className="detail-label">Priority</span>
              <div className="detail-value">
                <PriorityIcon priority={task.priority} />
                <select className="bare-select" value={task.priority ?? ""} onChange={(e) => onChange({ priority: (e.target.value || undefined) as TaskPriority | undefined })}>
                  <option value="">None</option>
                  {TASK_PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </div>
            <div className="detail-row">
              <span className="detail-label">Due date</span>
              <div className="detail-value">
                <input type="date" className={`bare-select ${task.due && task.status !== "done" && task.due < today() ? "overdue" : ""}`} value={task.due ?? ""} onChange={(e) => onChange({ due: e.target.value || undefined })} />
              </div>
            </div>
            <div className="detail-row top">
              <span className="detail-label">Labels</span>
              <div className="detail-value wrap">
                {own.map((l) => <Label key={l} text={l} onRemove={() => onChange({ labels: own.filter((x) => x !== l) })} />)}
                <input className="bare-select label-input" list="task-labels" placeholder={own.length ? "+ Add" : "Add a label"} value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addLabel(label); } }}
                  onBlur={() => label.trim() && addLabel(label)} />
                <datalist id="task-labels">{labels.filter((l) => !own.includes(l)).map((l) => <option key={l} value={l} />)}</datalist>
              </div>
            </div>
            <div className="detail-row">
              <span className="detail-label">Reporter</span>
              <div className="detail-value"><Avatar name={task.createdBy} size="sm" /><span>{task.createdBy}</span></div>
            </div>
          </div>

          <div className="task-stamps muted small">
            <div>Created {relativeTime(task.createdAt)}</div>
            <div>Updated {relativeTime(task.updatedAt)}</div>
          </div>
          <div className="task-delete">
            {confirmDelete
              ? <><span className="small">Delete this task?</span><button className="btn danger tight" onClick={onDelete}>Delete</button><button className="btn ghost tight" onClick={() => setConfirmDelete(false)}>Cancel</button></>
              : <button className="btn ghost tight danger-text" onClick={() => setConfirmDelete(true)}>Delete task</button>}
          </div>
        </aside>
      </div>
    </Modal>
  );
}
