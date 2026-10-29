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
  const [agentTab, setAgentTab] = useState<"claude" | "codex" | "other">("claude");
  const [mode, setMode] = useState<"agent" | "folder" | "git">("agent");
  const url = `${location.origin}/git/${projectId}.git`;
  const user = session.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "me";
  const token = fresh ?? "<your-token>";

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

  const tokenStep = (
    <div className="step">
      <span className="step-n">1</span>
      <div className="grow">
        <div>Create an access token. It's a password for your tools; keep it private.</div>
        {fresh ? (
          <div className="token-fresh">
            <CodeLine text={fresh} />
            <span className="muted small">Copy it now; it won't be shown again. The commands below already include it.</span>
          </div>
        ) : (
          <form className="row gap" onSubmit={create}>
            <input className="input" placeholder="Label, e.g. “MacBook”" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn primary">Create token</button>
          </form>
        )}
      </div>
    </div>
  );
  const link = `${location.origin}/#/p/${projectId}`;
  const cli = "npx -y -p margin-paper-mcp margin";

  return (
    <Modal onClose={onClose} wide>
      <h3 className="modal-title">Work outside the browser</h3>
      <div className="segmented mode-tabs local-tabs">
        <button className={mode === "agent" ? "active" : ""} onClick={() => setMode("agent")}>Let an agent work on it</button>
        <button className={mode === "folder" ? "active" : ""} onClick={() => setMode("folder")}>A folder on my computer</button>
        <button className={mode === "git" ? "active" : ""} onClick={() => setMode("git")}>Git</button>
      </div>

      {mode === "agent" && (
        <>
          <p className="muted small">The easiest way: Claude Code, Codex or another agent works on the live paper from your terminal, with nothing to download or upload. Everyone sees it as “Claude Code for {session.name}” with its own cursor. It can edit text (directly or as suggestions, set in Share), create documents, sections and files, compile, pick up board tasks and answer comments. You can undo everything it did in one click on its avatar.</p>
          <div className="steps">
            {tokenStep}
            <div className="step">
              <span className="step-n">2</span>
              <div className="grow">
                <div>Connect your agent once:</div>
                <div className="agent-tabs">
                  <button className={agentTab === "claude" ? "active" : ""} onClick={() => setAgentTab("claude")}>Claude Code</button>
                  <button className={agentTab === "codex" ? "active" : ""} onClick={() => setAgentTab("codex")}>Codex</button>
                  <button className={agentTab === "other" ? "active" : ""} onClick={() => setAgentTab("other")}>Other</button>
                </div>
                {agentTab === "claude" && <CodeLine text={`claude mcp add margin -e MARGIN_TOKEN=${token} -- npx -y margin-paper-mcp --url ${location.origin} --project ${projectId}`} />}
                {agentTab === "codex" && (
                  <pre className="code-block">{`# ~/.codex/config.toml
[mcp_servers.margin]
command = "npx"
args = ["-y", "margin-paper-mcp", "--url", "${location.origin}", "--project", "${projectId}"]
env = { MARGIN_TOKEN = "${token}" }`}</pre>
                )}
                {agentTab === "other" && (
                  <pre className="code-block">{`{
  "mcpServers": {
    "margin": {
      "command": "npx",
      "args": ["-y", "margin-paper-mcp", "--url", "${location.origin}", "--project", "${projectId}"],
      "env": { "MARGIN_TOKEN": "${token}" }
    }
  }
}`}</pre>
                )}
              </div>
            </div>
            <div className="step">
              <span className="step-n">3</span>
              <div className="grow">
                <div>Ask it for something, e.g. <em>“Read the board, take the intro task, tighten the introduction and save a version when you're done.”</em></div>
              </div>
            </div>
          </div>
        </>
      )}

      {mode === "folder" && (
        <>
          <p className="muted small">Edit the files in your own editor, offline, or with an agent in that folder. No git knowledge needed: one command downloads the paper, and one command sends your changes and brings in everyone else's. You need <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> and <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">git</a> installed; you never have to use git yourself.</p>
          <div className="steps">
            {tokenStep}
            <div className="step">
              <span className="step-n">2</span>
              <div className="grow">
                <div>Download the paper into a new folder (it asks for the token):</div>
                <CodeLine text={`${cli} clone ${link}`} />
              </div>
            </div>
            <div className="step">
              <span className="step-n">3</span>
              <div className="grow">
                <div>Edit the files. Whenever you want to share your changes, or get your co-authors' latest, run this in that folder:</div>
                <CodeLine text={`${cli} sync`} />
                <p className="muted small step-hint">It tells you what it sent and what it got. <code>margin status</code> shows what you've changed and whether Margin has anything newer.</p>
              </div>
            </div>
          </div>
          <details className="local-help">
            <summary>What if we changed the same sentence?</summary>
            <p className="small">Margin merges changes to different places by itself. If you and someone else changed the same lines, <code>margin sync</code> stops and puts both versions in the file between <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> lines. Either keep the text you want, delete the marker lines and sync again, or run <code>margin sync --keep-both</code>: both versions go up, and anyone can pick one with a click in Margin's editor.</p>
          </details>
          <details className="local-help">
            <summary>Is anything lost if I forget to sync?</summary>
            <p className="small">No. Your changes stay in the folder until you sync, and everything that reaches Margin is in History (versions from your computer are marked “Uploaded from a local copy”), so any version can be restored.</p>
          </details>
        </>
      )}

      {mode === "git" && (
        <>
          <p className="muted small">The project is a git repository. Pushes merge straight into everyone's live view; pulls include live edits.</p>
          <div className="steps">
            {tokenStep}
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
                <div><code>git pull</code> picks up teammates' live edits, <code>git push</code> sends yours. Force pushes are refused.</div>
                <span className="muted small">The board is in <code>.margin/board.json</code>. Overlapping lines are kept with conflict markers that name each side, and can be resolved in the editor.</span>
              </div>
            </div>
          </div>
        </>
      )}

      {mode !== "git" && <p className="muted small">Until margin-paper-mcp is on npm, use <code>node &lt;margin repo&gt;/packages/mcp/dist/{mode === "agent" ? "index" : "cli"}.js</code> in place of <code>{mode === "agent" ? "npx -y margin-paper-mcp" : cli}</code>.</p>}
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
