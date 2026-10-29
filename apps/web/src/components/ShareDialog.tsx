import { useEffect, useState } from "react";
import type { AgentMode, MemberRole, ProjectAccess, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { Avatar } from "./Presence.tsx";

export function ShareDialog({ projectId, session, onClose }: { projectId: string; session: Session; onClose(): void }) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [link, setLink] = useState<{ url: string; role: "editor" | "advisor"; admits: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentMode, setAgentMode] = useState<AgentMode | null>(null);

  const refresh = () => api.access(projectId).then(setAccess).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, [projectId]);
  useEffect(() => { api.project(projectId).then((p) => setAgentMode(p.agentMode ?? "suggest")).catch(() => {}); }, [projectId]);

  const owner = access?.you?.role === "owner";
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const invite = (role: "editor" | "advisor") => run(async () => {
    const r = await api.createInvite(projectId, role);
    const url = `${location.origin}/#/join/${projectId}/${r.token}`;
    setLink({ url, role, admits: !!r.admits });
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
                <div className="code-line"><code>{link.url}</code>
                  <button className="icon-btn" title="Copy" onClick={async () => { await navigator.clipboard.writeText(link.url).catch(() => {}); setCopied(true); }}><Icon name={copied ? "check" : "copy"} size={14} /></button>
                </div>
              ) : (
                <div className="row gap">
                  <button className="btn primary" onClick={() => void invite("editor")}><Icon name="plus" size={13} />Invite a co-author</button>
                  <button className="btn" onClick={() => void invite("advisor")} title="Advisors read, comment, follow Updates and use the board, but don't edit files"><Icon name="people" size={13} />Invite an advisor</button>
                </div>
              )}
              <span className="muted small">{link
                ? `Anyone with this link can join as ${link.role === "advisor" ? "an advisor (read, comment, Updates, board)" : "an editor"} for 14 days.${link.admits ? " It also lets them sign in to Margin with GitHub, as a guest who sees only this paper; no separate Margin invite needed." : ""}`
                : "Links expire after 14 days. Advisors (an instructor or supervisor) can read, comment, follow Updates and use the board, but not change files."}</span>
            </div>
          )}
          <div className="section-label tokens-label">Members</div>
          <div className="token-list">
            {access.members.map((m) => (
              <div key={m.id} className="token-row">
                <Avatar name={m.name} src={m.avatar} size="sm" />
                <span className="grow">{m.name}{m.id === access.you?.id && <span className="muted"> (you)</span>} <span className="muted small">{m.id.startsWith("gh:") ? `@${m.id.slice(3)}` : ""}</span></span>
                {owner && m.id !== access.you?.id ? (
                  <select value={m.role} onChange={(e) => void run(() => api.setRole(projectId, m.id, e.target.value as MemberRole))}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="advisor">Advisor</option>
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
          {agentMode && (
            <>
              <div className="section-label tokens-label">AI agents</div>
              <div className="agent-mode">
                {([
                  ["edit", "Edit directly", "Claude and agents like Claude Code type into the paper like a co-author. You watch them work and can undo a run in one step."],
                  ["suggest", "Suggest only", "Agents leave suggestions and comments; a person accepts each change. They can't create, move or delete files."],
                ] as const).map(([mode, label, hint]) => (
                  <label key={mode} className={`agent-mode-option ${agentMode === mode ? "on" : ""}`}>
                    <input type="radio" name="agent-mode" checked={agentMode === mode} disabled={!owner}
                      onChange={() => void run(async () => { setAgentMode((await api.updateProject(projectId, { agentMode: mode })).agentMode ?? mode); })} />
                    <span><strong>{label}</strong><span className="muted small">{hint}</span></span>
                  </label>
                ))}
              </div>
              {!owner && <p className="muted small">Only owners can change this.</p>}
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
