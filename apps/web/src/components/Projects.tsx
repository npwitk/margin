import { useEffect, useState } from "react";
import type { Project, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { WorkspaceDialog } from "./WorkspaceDialog.tsx";

const TEMPLATES = [
  { id: "article", label: "Article", hint: "Sections, natbib, a references folder" },
  { id: "ieee", label: "IEEE conference", hint: "IEEEtran two-column" },
  { id: "blank", label: "Blank", hint: "Just main.tex" },
];

export function Projects({ session, onLogout }: { session: Session; onLogout(): void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  useEffect(() => { api.workspace().then((w) => setAdmin(w.admin)).catch(() => {}); }, []);

  useEffect(() => { api.projects().then(setProjects).catch((e) => setError(e.message)); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="projects-page">
      <header className="topbar">
        <div className="logo">M</div>
        <span className="project-name static">Margin</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setMembersOpen(true)}><Icon name="plus" size={13} />{admin ? "Members & invites" : "Members"}</button>
        <span className="muted small">{session.name}</span>
        <button className="icon-btn" title="Sign out" onClick={async () => { await api.logout(); onLogout(); }}><Icon name="logout" /></button>
      </header>
      <main className="projects">
        <div className="row">
          <h2>Projects</h2>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New paper <kbd>N</kbd></button>
        </div>
        {error && <p className="error">{error}</p>}
        {!projects && !error && <Spinner />}
        {projects?.length === 0 && (
          <div className="empty-card">
            <Icon name="file" size={28} className="muted" />
            <h3>No papers yet</h3>
            <p className="muted">Start one from a template. Everything lives in a git repo you own.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>New paper</button>
          </div>
        )}
        <div className="project-list">
          {projects?.map((p) => (
            <button key={p.id} className="project-row" onClick={() => navigate({ name: "project", id: p.id })}>
              <Icon name="file" size={15} className="muted" />
              <span className="grow">{p.name}</span>
              <span className="muted small">{p.mainFile}</span>
              <span className="muted small fixed">{relativeTime(p.updatedAt)}</span>
            </button>
          ))}
        </div>
      </main>
      {creating && <NewProject onClose={() => setCreating(false)} />}
      {membersOpen && <WorkspaceDialog session={session} onClose={() => setMembersOpen(false)} />}
    </div>
  );
}

type Mode = "template" | "import" | "idea";

function NewProject({ onClose }: { onClose(): void }) {
  const [mode, setMode] = useState<Mode>("template");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("article");
  const [source, setSource] = useState<"zip" | "arxiv" | "git">("zip");
  const [file, setFile] = useState<File | null>(null);
  const [ref, setRef] = useState("");
  const [idea, setIdea] = useState("");
  const [goal, setGoal] = useState("");
  const [members, setMembers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = mode === "template" ? !!name.trim()
    : mode === "import" ? (source === "zip" ? !!file : !!ref.trim())
    : idea.trim().length >= 20;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let p: Project;
      if (mode === "template") p = await api.createProject(name, template);
      else if (mode === "import") p = source === "zip" ? await api.importZip(file!) : await api.importFrom(source === "arxiv" ? { arxiv: ref } : { git: ref });
      else p = await api.fromIdea({ idea, goal, template, members: members.split(",").map((m) => m.trim()).filter(Boolean) });
      navigate({ name: "project", id: p.id });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3 className="modal-title">New paper</h3>
        <div className="segmented mode-tabs">
          <button type="button" className={mode === "template" ? "active" : ""} onClick={() => setMode("template")}>From a template</button>
          <button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>Import existing</button>
          <button type="button" className={mode === "idea" ? "active" : ""} onClick={() => setMode("idea")}>✦ From an idea</button>
        </div>

        {mode === "template" && (
          <>
            <input className="input" autoFocus placeholder="Working title" value={name} onChange={(e) => setName(e.target.value)} />
            <TemplatePicker value={template} onChange={setTemplate} />
          </>
        )}

        {mode === "import" && (
          <>
            <div className="templates">
              {([["zip", "Overleaf or .zip", "Download from Overleaf: Menu → Download → Source"], ["arxiv", "arXiv paper", "Its LaTeX source, by arXiv ID or link"], ["git", "Git repository", "A public https:// repository (GitHub, GitLab…)"]] as const).map(([id, label, hint]) => (
                <label key={id} className={`template ${source === id ? "active" : ""}`}>
                  <input type="radio" name="source" checked={source === id} onChange={() => { setSource(id); setRef(""); }} />
                  <span className="template-label">{label}</span>
                  <span className="muted small">{hint}</span>
                </label>
              ))}
            </div>
            {source === "zip" ? (
              <label className="dropzone">
                <input type="file" accept=".zip,application/zip" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                {file ? <span>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span> : <span className="muted">Choose a .zip file</span>}
              </label>
            ) : (
              <input className="input import-ref" autoFocus placeholder={source === "arxiv" ? "1706.03762 or https://arxiv.org/abs/1706.03762" : "https://github.com/you/paper"} value={ref} onChange={(e) => setRef(e.target.value)} />
            )}
            <p className="muted small">Margin finds the main .tex file and the right engine. Everything becomes a git repo with full history from here on.</p>
          </>
        )}

        {mode === "idea" && (
          <>
            <textarea className="notes idea-box" autoFocus placeholder="Describe the idea in a few sentences: the problem, what you'd try, and why it matters. Rough is fine." value={idea} onChange={(e) => setIdea(e.target.value)} />
            <div className="row gap">
              <input className="input" placeholder="Target venue or goal (optional)" value={goal} onChange={(e) => setGoal(e.target.value)} />
              <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="article">Article</option>
                <option value="ieee">IEEE conference</option>
              </select>
            </div>
            <input className="input" placeholder="Co-authors to split the work with, e.g. Bob, Chai (optional)" value={members} onChange={(e) => setMembers(e.target.value)} />
            <p className="muted small">Claude sharpens the research question, outlines the sections, drafts an abstract, finds real related work (OpenAlex) for your .bib, and puts first tasks on the board. Uses your Anthropic API key; takes about a minute.</p>
          </>
        )}

        {error && <p className="error small">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !canSubmit}>
            {busy ? <Spinner /> : mode === "template" ? "Create" : mode === "import" ? "Import" : "✦ Plan my paper"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TemplatePicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="templates">
      {TEMPLATES.map((t) => (
        <label key={t.id} className={`template ${value === t.id ? "active" : ""}`}>
          <input type="radio" name="template" value={t.id} checked={value === t.id} onChange={() => onChange(t.id)} />
          <span className="template-label">{t.label}</span>
          <span className="muted small">{t.hint}</span>
        </label>
      ))}
    </div>
  );
}
