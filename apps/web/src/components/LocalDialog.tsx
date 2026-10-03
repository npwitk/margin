import { useEffect, useState } from "react";
import type { Session } from "@margin/shared";
import { api, type AccessToken } from "../lib/api.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="icon-btn" title="Copy" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* clipboard blocked */ }
    }}>
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}

function CodeLine({ text }: { text: string }) {
  return <div className="code-line"><code>{text}</code><Copy text={text} /></div>;
}

export function LocalDialog({ projectId, session, onClose }: { projectId: string; session: Session; onClose(): void }) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const url = `${location.origin}/git/${projectId}.git`;
  const user = session.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "me";

  const refresh = () => api.tokens().then(setTokens).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const t = await api.createToken(label || "Laptop");
      setFresh(t.token);
      setLabel("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal onClose={onClose} wide>
      <h3 className="modal-title">Work locally</h3>
      <p className="muted small">Clone this paper to edit it in your own editor or with Claude Code, Codex and other agents. Pushes merge straight into everyone's live view.</p>

      <div className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <div className="grow">
            <div>Create an access token. Use it as the password when git asks.</div>
            {fresh ? (
              <div className="token-fresh">
                <CodeLine text={fresh} />
                <span className="muted small">Copy it now; it won't be shown again.</span>
              </div>
            ) : (
              <form className="row gap" onSubmit={create}>
                <input className="input" placeholder="Label, e.g. “MacBook”" value={label} onChange={(e) => setLabel(e.target.value)} />
                <button className="btn primary">Create token</button>
              </form>
            )}
          </div>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <div className="grow">
            <div>Clone. Username: <code>{user}</code> (anything works); password: your token.</div>
            <CodeLine text={`git clone ${url}`} />
          </div>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <div className="grow">
            <div>Work as usual: <code>git pull</code> picks up teammates' live edits, and <code>git push</code> sends yours.</div>
            <CodeLine text="cd <folder> && claude" />
            <span className="muted small">Agents get the full paper, references and board (<code>.margin/board.json</code>).</span>
          </div>
        </div>
      </div>

      {error && <p className="error small">{error}</p>}
      <div className="section-label tokens-label">Your tokens</div>
      <div className="token-list">
        {tokens?.length === 0 && <div className="muted small">None yet.</div>}
        {tokens?.map((t) => (
          <div key={t.id} className="token-row">
            <Icon name="key" size={14} className="muted" />
            <span className="grow">{t.label}</span>
            <span className="muted small">created {relativeTime(t.createdAt)}{t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : " · never used"}</span>
            <button className="btn ghost danger-text tight" onClick={async () => { await api.revokeToken(t.id); await refresh(); }}>Revoke</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
