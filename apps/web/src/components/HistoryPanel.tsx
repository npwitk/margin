import { useEffect, useMemo, useState } from "react";
import type { Checkpoint, CheckpointFileDiff, PendingChanges } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { Avatar } from "./Presence.tsx";

/**
 * Version history, like Google Docs. Margin saves a version by itself a few
 * minutes after people stop typing (crediting everyone who edited); you can
 * also save a named version for important moments. Pick a version to see what
 * changed, and restore a file or the whole project to it.
 */
export function HistoryPanel({ projectId, onClose, beforeCheckpoint, onOpenFile, onRestored, refreshKey }: {
  projectId: string;
  onClose(): void;
  beforeCheckpoint(): Promise<unknown>;
  onOpenFile(path: string): void;
  onRestored(message: string): void;
  /** Bumped when someone saves a version, to refresh the list live. */
  refreshKey?: number;
}) {
  const [versions, setVersions] = useState<Checkpoint[] | null>(null);
  const [pending, setPending] = useState<PendingChanges | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [namedOnly, setNamedOnly] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [more, setMore] = useState(true);

  const refresh = async () => {
    try {
      const r = await api.history(projectId);
      setVersions(r.versions);
      setPending(r.pending);
      setMore(r.versions.length >= 60);
      setSelected((s) => (s && r.versions.some((v) => v.hash === s) ? s : r.versions[0]?.hash ?? null));
    } catch (e) { setNote((e as Error).message); }
  };
  useEffect(() => { void refresh(); }, [projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    const r = await api.history(projectId, versions?.length ?? 0);
    setVersions((v) => [...(v ?? []), ...r.versions]);
    setMore(r.versions.length >= 60);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await beforeCheckpoint();
      const { checkpoint } = await api.checkpoint(projectId, message);
      if (!checkpoint) setNote("Nothing changed since the last version.");
      setMessage("");
      await refresh();
      if (checkpoint) setSelected(checkpoint.hash);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    const shown = (versions ?? []).filter((v) => !namedOnly || v.kind === "named" || v.kind === "restore");
    const out: { day: string; items: Checkpoint[] }[] = [];
    for (const v of shown) {
      const day = dayLabel(v.date);
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(v);
    }
    return out;
  }, [versions, namedOnly]);
  const current = versions?.find((v) => v.hash === selected) ?? null;
  const isLatest = !!current && versions?.[0]?.hash === current.hash;

  return (
    <Modal onClose={onClose} className="history-modal">
      <div className="history-head">
        <div className="grow">
          <h3 className="modal-title">Version history</h3>
          <p className="muted small history-explain">
            Margin saves a version by itself a few minutes after people stop typing, crediting everyone who edited. Name the moments that matter, like “Submitted to CCS”. Restoring is always safe: your current work is saved as a version first.
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" /></button>
      </div>

      <div className="history-body">
        <aside className="history-list">
          <form className="history-save" onSubmit={save}>
            <input className="input sm" placeholder="Name this version, e.g. Sent to advisor" value={message} onChange={(e) => setMessage(e.target.value)} />
            <button className="btn primary tight" disabled={busy}>{busy ? <Spinner /> : "Save version"}</button>
          </form>
          {note && <p className="muted small history-note">{note}</p>}
          {pending && (
            <div className="history-pending">
              <span className="pending-dot" />
              <div className="grow">
                <div className="small"><b>Not saved yet</b> · {pending.files.length} file{pending.files.length === 1 ? "" : "s"} edited</div>
                <div className="muted small ellipsis">{pending.people.join(", ")} · saves by itself when editing pauses</div>
              </div>
            </div>
          )}
          <div className="history-filter">
            <button className={`chip ${!namedOnly ? "active" : ""}`} onClick={() => setNamedOnly(false)}>All versions</button>
            <button className={`chip ${namedOnly ? "active" : ""}`} onClick={() => setNamedOnly(true)}><Icon name="star" size={11} />Named only</button>
          </div>
          {!versions && <div className="empty"><Spinner /></div>}
          {groups.map((g) => (
            <div key={g.day}>
              <div className="history-day">{g.day}</div>
              {g.items.map((v) => (
                <button key={v.hash} className={`version-row ${selected === v.hash ? "active" : ""} k-${v.kind}`} onClick={() => setSelected(v.hash)}>
                  <span className="version-people">{(v.people ?? [v.author]).slice(0, 3).map((p) => <Avatar key={p} name={baseName(p)} size="xs" title={p} />)}</span>
                  <span className="version-text">
                    <span className="version-title">
                      {v.kind === "named" && <Icon name="star" size={11} className="version-star" />}
                      {v.kind === "restore" && <Icon name="history" size={11} className="muted" />}
                      {v.kind === "local" && <span title="Uploaded from a local copy (git push / margin sync)"><Icon name="upload" size={11} className="muted" /></span>}
                      <span className="ellipsis">{v.message}</span>
                    </span>
                    <span className="muted small ellipsis">{time(v.date)} · {(v.people ?? [v.author]).join(", ")}</span>
                  </span>
                  <span className="version-stat">{stat(v)}</span>
                </button>
              ))}
            </div>
          ))}
          {more && versions && !namedOnly && <button className="btn ghost tight history-more" onClick={() => void loadMore()}>Show older versions</button>}
        </aside>

        <main className="history-detail">
          {current
            ? <VersionDetail key={current.hash} projectId={projectId} version={current} isLatest={isLatest && !pending} onOpenFile={onOpenFile} latestWithEdits={isLatest && !!pending}
                onRestored={(msg) => { onRestored(msg); setSelected(null); void refresh(); }} />
            : <div className="empty">Pick a version to see what changed.</div>}
        </main>
      </div>
    </Modal>
  );
}

function VersionDetail({ projectId, version, isLatest, latestWithEdits, onOpenFile, onRestored }: {
  projectId: string; version: Checkpoint; isLatest: boolean; latestWithEdits?: boolean; onOpenFile(path: string): void; onRestored(message: string): void;
}) {
  const [changes, setChanges] = useState<CheckpointFileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.versionChanges(projectId, version.hash).then((c) => {
      setChanges(c);
      setOpen(new Set(c.filter((f) => !f.binary && f.additions + f.deletions <= 150).slice(0, 4).map((f) => f.path)));
    }).catch((e) => setError(e.message));
  }, [projectId, version.hash]);

  const restore = async (file?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.restoreVersion(projectId, version.hash, file);
      onRestored(file ? `Restored ${file} to that version` : `Restored the project (${r.restored} files) to that version`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    setConfirm(null);
  };

  return (
    <div className="version-detail">
      <div className="version-head">
        <div className="grow">
          <div className="version-name">{version.kind === "named" && <Icon name="star" size={13} className="version-star" />}{version.message}</div>
          <div className="muted small">
            {new Date(version.date).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
            {" · "}{kindLabel(version.kind)}{" · "}<code>{version.hash.slice(0, 7)}</code>
          </div>
          <div className="version-credits">
            {(version.people ?? [version.author]).map((p) => <span key={p} className="assignee-chip"><Avatar name={baseName(p)} size="xs" />{p}</span>)}
          </div>
        </div>
        {!isLatest && (confirm === "*"
          ? <div className="confirm-box">
              <span className="small">Bring the <b>whole project</b> back to this version? Your current work is saved as a version first, so you can undo this.</span>
              <div className="row gap"><button className="btn primary tight" disabled={busy} onClick={() => void restore()}>{busy ? <Spinner /> : "Restore project"}</button><button className="btn ghost tight" onClick={() => setConfirm(null)}>Cancel</button></div>
            </div>
          : <button className="btn tight" onClick={() => setConfirm("*")}><Icon name="history" size={13} />{latestWithEdits ? "Discard unsaved edits" : "Restore project to here"}</button>)}
      </div>
      {isLatest && <p className="muted small">This is the latest saved version, and nothing has changed since. Pick an older one to restore it.</p>}
      {latestWithEdits && <p className="muted small">This is the latest saved version. Restoring it throws away the edits made since (they're saved as a version first, so you can still get them back).</p>}
      {error && <p className="error small">{error}</p>}
      {!changes && !error && <div className="empty"><Spinner /></div>}
      {changes && !changes.length && <div className="empty small">{version.kind === "named" ? "A bookmark: it marks the project exactly as it was at this moment." : "No file changes in this version."}</div>}
      {changes?.map((f) => {
        const isOpen = open.has(f.path);
        const internal = f.path.startsWith(".margin/");
        return (
          <div key={f.path} className="diff-file">
            <div className="diff-head">
              <button className="diff-toggle" onClick={() => setOpen((s) => { const n = new Set(s); n.has(f.path) ? n.delete(f.path) : n.add(f.path); return n; })}>
                <Icon name="chevron" size={11} className={`chev ${isOpen ? "open" : ""}`} />
                <span className={`diff-status s-${f.status}`}>{f.status === "added" ? "New" : f.status === "deleted" ? "Deleted" : f.status === "renamed" ? "Moved" : "Edited"}</span>
                <span className="diff-path ellipsis">{internal ? "Board (tasks and comments)" : f.from ? `${f.from} → ${f.path}` : f.path}</span>
                {!f.binary && <span className="diff-counts"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>}
              </button>
              {f.status !== "deleted" && !internal && <button className="link-btn" onClick={() => onOpenFile(f.path)}>Open</button>}
              {!isLatest && f.status !== "deleted" && !internal && (confirm === f.path
                ? <><button className="link-btn danger-text" disabled={busy} onClick={() => void restore(f.path)}>Restore this file?</button><button className="link-btn" onClick={() => setConfirm(null)}>Cancel</button></>
                : <button className="link-btn" onClick={() => setConfirm(f.path)}>Restore file</button>)}
            </div>
            {isOpen && (f.binary ? <div className="muted small diff-binary">Binary file (image, PDF…): no text to compare.</div> : <Patch text={f.patch} />)}
          </div>
        );
      })}
    </div>
  );
}

/** A unified diff with old/new line numbers. */
function Patch({ text }: { text: string }) {
  const rows: { kind: "hunk" | "add" | "del" | "ctx"; old?: number; new?: number; text: string }[] = [];
  let o = 0, n = 0;
  for (const line of text.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
    if (h) { o = Number(h[1]); n = Number(h[2]); rows.push({ kind: "hunk", text: h[3].trim() }); continue; }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", new: n++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: o++, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
    else if (line) rows.push({ kind: "hunk", text: line });
  }
  return (
    <div className="diff">
      {rows.map((r, i) => r.kind === "hunk"
        ? <div key={i} className="diff-row hunk"><span className="ln" /><span className="ln" /><span className="code">{r.text || "⋯"}</span></div>
        : <div key={i} className={`diff-row ${r.kind}`}><span className="ln">{r.old ?? ""}</span><span className="ln">{r.new ?? ""}</span><span className="code">{r.text || " "}</span></div>)}
    </div>
  );
}

const baseName = (p: string) => p.replace(/ \(for .*\)$/, "");
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const kindLabel = (k?: Checkpoint["kind"]) => (k === "named" ? "Named version" : k === "auto" ? "Saved automatically" : k === "restore" ? "Restore" : k === "local" ? "Uploaded from a local copy" : "Saved");
function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function stat(v: Checkpoint) {
  if (!v.files?.length) return null;
  const add = v.files.reduce((s, f) => s + f.additions, 0), del = v.files.reduce((s, f) => s + f.deletions, 0);
  return <><span className="add">+{add}</span> <span className="del">−{del}</span></>;
}
