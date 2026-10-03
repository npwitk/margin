import { useEffect, useState } from "react";
import type { Checkpoint } from "@margin/shared";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Spinner } from "./Icon.tsx";

export function HistoryPanel({ projectId, onClose, beforeCheckpoint }: {
  projectId: string;
  onClose(): void;
  beforeCheckpoint(): Promise<unknown>;
}) {
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => api.history(projectId).then(setItems).catch((e) => setNote(e.message));
  useEffect(() => { void refresh(); }, [projectId]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await beforeCheckpoint();
      const { checkpoint } = await api.checkpoint(projectId, message);
      setNote(checkpoint ? null : "Nothing changed since the last checkpoint.");
      setMessage("");
      await refresh();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} wide>
      <h3 className="modal-title">Checkpoints</h3>
      <p className="muted small">Each checkpoint is a git commit, credited to whoever made it.</p>
      <form className="row gap" onSubmit={create}>
        <input className="input grow" autoFocus placeholder="What changed? e.g. “Finished related work draft”" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : "Checkpoint"}</button>
      </form>
      {note && <p className="muted small">{note}</p>}
      <div className="history">
        {!items && <Spinner />}
        {items?.map((c) => (
          <div key={c.hash} className="history-item">
            <span className="avatar sm">{c.author.slice(0, 1).toUpperCase()}</span>
            <div className="grow">
              <div>{c.message}</div>
              <div className="muted small">{c.author} · {relativeTime(c.date)}</div>
            </div>
            <code className="muted small">{c.hash.slice(0, 7)}</code>
          </div>
        ))}
      </div>
    </Modal>
  );
}
