import { useEffect, useState } from "react";
import type { Session, WorkspaceInfo } from "@margin/shared";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { Avatar } from "./Presence.tsx";

/** Workspace members and invite links (admins manage them). */
export function WorkspaceDialog({ session, onClose }: { session: Session; onClose(): void }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(1);
  const [copied, setCopied] = useState(false);

  const refresh = () => api.workspace().then(setInfo).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); } };

  const invite = () => run(async () => {
    const r = await api.createWorkspaceInvite(days, uses);
    const url = `${location.origin}/api/auth/invite/${r.token}`;
    setLink(url);
    setCopied(false);
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* copy by hand */ }
  });

  return (
    <Modal onClose={onClose} wide>
      <h3 className="modal-title">Workspace members</h3>
      {!info ? <Spinner /> : (
        <>
          <p className="muted small">
            {info.inviteOnly
              ? "This workspace is invite-only: only the people below can sign in (with GitHub). Removing someone signs them out everywhere, including their git and agent tokens."
              : "This workspace isn't invite-only. Set MARGIN_ADMINS on the server to require invites."}
          </p>
          {info.admin && info.inviteOnly && (
            <div className="invite-box">
              <div className="row gap">
                <button className="btn primary" onClick={() => void invite()}><Icon name="plus" size={13} />Create invite link</button>
                <select value={uses} onChange={(e) => setUses(Number(e.target.value))}>
                  <option value={1}>for 1 person</option><option value={5}>for up to 5 people</option><option value={20}>for up to 20 people</option>
                </select>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  <option value={1}>expires in 1 day</option><option value={7}>expires in 7 days</option><option value={30}>expires in 30 days</option>
                </select>
              </div>
              {link && (
                <div className="code-line"><code>{link}</code>
                  <button className="icon-btn" title="Copy" onClick={async () => { await navigator.clipboard.writeText(link).catch(() => {}); setCopied(true); }}><Icon name={copied ? "check" : "copy"} size={14} /></button>
                </div>
              )}
              {link && <span className="muted small">Send this link to the person. It's shown once; they open it and sign in with GitHub.</span>}
            </div>
          )}
          <div className="section-label tokens-label">Members ({info.members.length})</div>
          <div className="token-list">
            {info.members.map((m) => {
              const fixed = info.configAdmins.includes(m.login);
              const me = m.login === session.github?.toLowerCase();
              return (
                <div key={m.login} className="token-row">
                  <Avatar name={m.name} src={m.avatar} size="sm" />
                  <span className="grow">{m.name}{me && <span className="muted"> (you)</span>} <span className="muted small">@{m.login} · joined {relativeTime(m.joinedAt)}{m.invitedBy ? ` · invited by ${m.invitedBy}` : ""}</span></span>
                  {info.admin && !fixed && !me ? (
                    <>
                      <select value={m.role} onChange={(e) => void run(() => api.setWorkspaceRole(m.login, e.target.value as "admin" | "member"))}>
                        <option value="member">Member</option><option value="admin">Admin</option>
                      </select>
                      <button className="btn ghost danger-text tight" onClick={() => void run(() => api.removeWorkspaceMember(m.login))}>Remove</button>
                    </>
                  ) : <span className="badge">{fixed ? "admin (server)" : m.role}</span>}
                </div>
              );
            })}
          </div>
          {info.admin && info.invites.length > 0 && (
            <>
              <div className="section-label tokens-label">Active invite links</div>
              <div className="token-list">
                {info.invites.map((i) => (
                  <div key={i.id} className="token-row">
                    <Icon name="key" size={14} className="muted" />
                    <span className="grow small">By {i.createdBy} {relativeTime(i.createdAt)} · used {i.uses}/{i.maxUses} · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                    <button className="btn ghost danger-text tight" onClick={() => void run(() => api.revokeWorkspaceInvite(i.id))}>Revoke</button>
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p className="error small">{error}</p>}
        </>
      )}
    </Modal>
  );
}
