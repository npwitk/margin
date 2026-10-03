import { useEffect, useState } from "react";
import type { Project, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";

const TEMPLATES = [
  { id: "article", label: "Article", hint: "Sections, natbib, a references folder" },
  { id: "ieee", label: "IEEE conference", hint: "IEEEtran two-column" },
  { id: "blank", label: "Blank", hint: "Just main.tex" },
];

export function Projects({ session, onLogout }: { session: Session; onLogout(): void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
    </div>
  );
}

function NewProject({ onClose }: { onClose(): void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("article");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api.createProject(name, template);
      navigate({ name: "project", id: p.id });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit}>
        <h3 className="modal-title">New paper</h3>
        <input className="input" autoFocus placeholder="Working title" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="templates">
          {TEMPLATES.map((t) => (
            <label key={t.id} className={`template ${template === t.id ? "active" : ""}`}>
              <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span className="template-label">{t.label}</span>
              <span className="muted small">{t.hint}</span>
            </label>
          ))}
        </div>
        {error && <p className="error small">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? <Spinner /> : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
