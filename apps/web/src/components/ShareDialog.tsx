import { useEffect, useState } from "react";
import type { ProjectAccess, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { Avatar } from "./Presence.tsx";

export function ShareDialog({ projectId, session, onClose }: { projectId: string; session: Session; onClose(): void }) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.access(projectId).then(setAccess).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, [projectId]);

  const owner = access?.you?.role === "owner";
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const invite = () => run(async () => {
    const r = await api.createInvite(projectId);
    const url = `${location.origin}/#/join/${projectId}/${r.token}`;
    setLink(url);
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* manual copy */ }
  });

  return (
    <Modal onClose={onClose} wide>
      <h3 className="modal-title">Share</h3>
      {!access ? <Spinner /> : (
        <>
          <p className="muted small">
            {access.mode === "workspace"
              ? "Everyone signed in to this workspace can open this project. Invite links matter once the workspace is open to the public."
              : "Only members can open this project, its git remote and its live documents. Invite people with a link."}
          </p>
          {owner && (
            <div className="invite-box">
              {link ? (
                <div className="code-line"><code>{link}</code>
                  <button className="icon-btn" title="Copy" onClick={async () => { await navigator.clipboard.writeText(link).catch(() => {}); setCopied(true); }}><Icon name={copied ? "check" : "copy"} size={14} /></button>
                </div>
              ) : (
                <button className="btn primary" onClick={() => void invite()}><Icon name="plus" size={13} />Create invite link</button>
              )}
              <span className="muted small">{link ? "Anyone with this link can join as an editor for 14 days." : "Links let people join as editors and expire after 14 days."}</span>
            </div>
          )}
          <div className="section-label tokens-label">Members</div>
          <div className="token-list">
            {access.members.map((m) => (
              <div key={m.id} className="token-row">
                <Avatar name={m.name} src={m.avatar} size="sm" />
                <span className="grow">{m.name}{m.id === access.you?.id && <span className="muted"> (you)</span>} <span className="muted small">{m.id.startsWith("gh:") ? `@${m.id.slice(3)}` : ""}</span></span>
                {owner && m.id !== access.you?.id ? (
                  <select value={m.role} onChange={(e) => void run(() => api.setRole(projectId, m.id, e.target.value as "owner" | "editor"))}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                  </select>
                ) : <span className="badge">{m.role}</span>}
                {(owner || m.id === access.you?.id) && (
                  <button className="btn ghost danger-text tight" onClick={() => void run(async () => {
                    await api.removeMember(projectId, m.id);
                    if (m.id === access.you?.id && access.mode === "members") navigate({ name: "projects" });
                  })}>{m.id === access.you?.id ? "Leave" : "Remove"}</button>
                )}
              </div>
            ))}
          </div>
          {owner && access.invites.length > 0 && (
            <>
              <div className="section-label tokens-label">Active invite links</div>
              <div className="token-list">
                {access.invites.map((i) => (
                  <div key={i.id} className="token-row">
                    <Icon name="key" size={14} className="muted" />
                    <span className="grow small">Created by {i.createdBy} {relativeTime(i.createdAt)} · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                    <button className="btn ghost danger-text tight" onClick={() => void run(() => api.revokeInvite(projectId, i.id))}>Revoke</button>
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p className="error small">{error}</p>}
          <p className="muted small">Signed in as {session.name}.</p>
        </>
      )}
    </Modal>
  );
}

/** Landing page for an invite link. */
export function JoinProject({ id, token }: { id: string; token: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.join(id, token).then(() => navigate({ name: "project", id })).catch((e) => setError(e.message));
  }, [id, token]);
  return (
    <div className="center-screen">
      {error ? (
        <>
          <p className="error">{error}</p>
          <button className="btn" onClick={() => navigate({ name: "projects" })}>Go to your projects</button>
        </>
      ) : <><Spinner size={20} /><p className="muted">Joining…</p></>}
    </div>
  );
}
