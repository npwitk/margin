import { useEffect, useMemo, useState } from "react";
import { byline, refTitle, refVenue, toBibtex, type LibraryRef, type LibraryView, type Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { relativeTime } from "../lib/time.ts";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";

/** "none" = references not in any paper; undefined = all. */
type Section = string | undefined;

const TYPES = ["article", "inproceedings", "book", "incollection", "phdthesis", "mastersthesis", "techreport", "misc", "online"];
const EDIT_FIELDS: [string, string][] = [
  ["title", "Title"], ["author", "Authors"], ["year", "Year"], ["journal", "Journal"], ["booktitle", "Proceedings"],
  ["volume", "Volume"], ["number", "Number"], ["pages", "Pages"], ["publisher", "Publisher"], ["doi", "DOI"], ["url", "URL"],
];

export function Library({ section, session }: { section: Section; session: Session }) {
  const [view, setView] = useState<LibraryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reload = () => api.library().then(setView).catch((e) => setError(e.message));
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const projectName = (id: string) => view?.projects.find((p) => p.id === id)?.name ?? id;
  const inSection = (r: LibraryRef) => section === undefined ? true : section === "none" ? r.projects.length === 0 : r.projects.includes(section);

  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.refs
      .filter(inSection)
      .filter((r) => !q || [r.key, r.fields.title, r.fields.author, r.fields.year, r.fields.journal, r.fields.booktitle, r.fields.doi].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }, [view, query, section]);

  const current = view?.refs.find((r) => r.id === selected) ?? null;
  const count = (s: Section) => view?.refs.filter((r) => s === undefined ? true : s === "none" ? !r.projects.length : r.projects.includes(s)).length ?? 0;

  const replace = (ref: LibraryRef) => setView((v) => v && { ...v, refs: v.refs.map((r) => (r.id === ref.id ? ref : r)) });

  return (
    <div className="projects-page">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate({ name: "projects" })} title="All projects"><Icon name="back" /></button>
        <Icon name="book" size={15} className="muted" />
        <span className="project-name static">Library</span>
        <div className="spacer" />
        <input className="input sm lib-search" placeholder="Search title, author, key, DOI…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add references</button>
        <span className="muted small">{session.name}</span>
      </header>
      <div className="library">
        <nav className="lib-nav">
          <div className="section-label">Library</div>
          <NavItem active={section === undefined} onClick={() => navigate({ name: "library" })} icon="book" label="All references" n={count(undefined)} />
          <NavItem active={section === "none"} onClick={() => navigate({ name: "library", project: "none" })} icon="bookmark" label="Not in a paper" n={count("none")} />
          <div className="section-label lib-nav-gap">Papers</div>
          {view?.projects.map((p) => (
            <NavItem key={p.id} active={section === p.id} onClick={() => navigate({ name: "library", project: p.id })} icon="file" label={p.name} n={count(p.id)} />
          ))}
          {view && !view.projects.length && <p className="muted small">No papers yet.</p>}
        </nav>

        <main className="lib-main">
          {error && <p className="error">{error}</p>}
          {!view && !error && <div className="empty"><Spinner /></div>}
          {view && section && section !== "none" && (
            <div className="lib-section-head">
              <h2>{projectName(section)}</h2>
              <div className="spacer" />
              <ImportPaperButton projectId={section} onDone={(msg) => { setToast(msg); void reload(); }} />
              <button className="btn ghost" onClick={() => navigate({ name: "project", id: section })}>Open paper</button>
            </div>
          )}
          {view && !view.refs.length && (
            <div className="lib-hero">
              <div className="lib-hero-art" aria-hidden="true">
                <div className="lib-card"><span className="key-chip">wells2020</span><b>CollabAR: mobile AR interfaces for co-located group collaboration</b><span className="muted small">Wells & Houben · 2020</span></div>
                <div className="lib-arrow">→</div>
                <div className="lib-code"><code>\cite{"{"}<span>wells2020</span>{"}"}</code></div>
              </div>
              <h3>Your references, ready to use anywhere.</h3>
              <p className="muted">Add references to the library once, then insert them into any paper: type <code>\cite{"{"}</code> in the editor. Start by pulling in the references your papers already have.</p>
              <button className="btn primary" onClick={() => setAdding(true)}>Add references</button>
            </div>
          )}
          {view && !!view.refs.length && !shown.length && <div className="empty">{query ? "No references match." : "No references in this section yet."}</div>}
          {!!shown.length && (
            <div className="lib-list">
              {shown.map((r) => (
                <button key={r.id} className={`lib-row ${selected === r.id ? "active" : ""}`} onClick={() => setSelected(r.id)}>
                  <span className="key-chip">{r.key}</span>
                  <span className="lib-row-main">
                    <span className="lib-title">{refTitle(r.fields)}</span>
                    <span className="muted small">{[byline(r.fields), refVenue(r.fields)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="lib-row-projects">
                    {r.projects.slice(0, 2).map((p) => <span key={p} className="chip subtle">{projectName(p)}</span>)}
                    {r.projects.length > 2 && <span className="chip subtle">+{r.projects.length - 2}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </main>

        {current && view && (
          <RefDetail key={current.id} ref_={current} projects={view.projects} onClose={() => setSelected(null)}
            onSaved={(r) => { replace(r); setToast("Saved"); }}
            onDeleted={() => { setView((v) => v && { ...v, refs: v.refs.filter((r) => r.id !== current.id) }); setSelected(null); }}
            onToast={setToast} />
        )}
      </div>
      {adding && view && (
        <AddDialog projects={view.projects} defaultProject={section && section !== "none" ? section : undefined} onClose={() => setAdding(false)}
          onDone={(msg) => { setAdding(false); setToast(msg); void reload(); }} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function NavItem({ active, onClick, icon, label, n }: { active: boolean; onClick(): void; icon: string; label: string; n: number }) {
  return (
    <button className={`lib-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <Icon name={icon} size={14} className="muted" />
      <span className="grow ellipsis">{label}</span>
      <span className="muted small">{n}</span>
    </button>
  );
}

const summary = (r: { added: unknown[]; merged: unknown[] }) =>
  [r.added.length && `Added ${r.added.length}`, r.merged.length && `${r.merged.length} already in the library`].filter(Boolean).join(" · ") || "Nothing new";

function ImportPaperButton({ projectId, onDone }: { projectId: string; onDone(msg: string): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn ghost" disabled={busy} title="Add every reference this paper already cites"
      onClick={async () => {
        setBusy(true);
        try { onDone(summary(await api.libraryImportProject(projectId))); } catch (e) { onDone((e as Error).message); }
        setBusy(false);
      }}>
      {busy ? <Spinner /> : <Icon name="download" size={13} />}Pull in from paper
    </button>
  );
}

function AddDialog({ projects, defaultProject, onClose, onDone }: { projects: LibraryView["projects"]; defaultProject?: string; onClose(): void; onDone(msg: string): void }) {
  const [mode, setMode] = useState<"doi" | "bibtex" | "paper">("doi");
  const [text, setText] = useState("");
  const [project, setProject] = useState(defaultProject ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "doi") {
        const r = await api.libraryAddDois(text.split(/[\s,;]+/).filter(Boolean), project || undefined);
        onDone(summary(r) + (r.failed.length ? ` · ${r.failed.length} not found` : ""));
      } else if (mode === "bibtex") onDone(summary(await api.libraryAddBibtex(text, project || undefined)));
      else onDone(summary(await api.libraryImportProject(project)));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const can = mode === "paper" ? !!project : !!text.trim();
  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3 className="modal-title">Add references</h3>
        <div className="segmented mode-tabs">
          <button type="button" className={mode === "doi" ? "active" : ""} onClick={() => setMode("doi")}>DOI</button>
          <button type="button" className={mode === "bibtex" ? "active" : ""} onClick={() => setMode("bibtex")}>Paste BibTeX</button>
          <button type="button" className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>From a paper</button>
        </div>
        {mode === "doi" && <textarea className="notes lib-paste" autoFocus placeholder={"One or more DOIs, e.g.\n10.1145/3313831.3376541\nhttps://doi.org/10.1109/ACCESS.2024.3409413"} value={text} onChange={(e) => setText(e.target.value)} />}
        {mode === "bibtex" && <textarea className="notes lib-paste mono" autoFocus placeholder={"@article{wells2020collabar,\n  title = {CollabAR …},\n  author = {Wells, Thomas and Houben, Steven},\n  year = {2020}\n}"} value={text} onChange={(e) => setText(e.target.value)} />}
        {mode === "paper" && <p className="muted small lib-help">Copies every reference the paper already has (its .bib files, or a hand-written <code>thebibliography</code>) into the library. Duplicates are merged. References with a DOI get their full details.</p>}
        <label className="lib-field">
          <span className="muted small">{mode === "paper" ? "Paper" : "Also add to paper (optional)"}</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {mode !== "paper" && <option value="">Just the library</option>}
            {mode === "paper" && !project && <option value="">Choose a paper…</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {mode !== "paper" && project && <p className="muted small lib-help">This files them under that paper in the library. To put one in the paper's .bib, type <code>\cite{"{"}</code> in the editor and pick it.</p>}
        {error && <p className="error small">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !can}>{busy ? <Spinner /> : "Add"}</button>
        </div>
      </form>
    </Modal>
  );
}

function RefDetail({ ref_, projects, onClose, onSaved, onDeleted, onToast }: {
  ref_: LibraryRef; projects: LibraryView["projects"]; onClose(): void; onSaved(r: LibraryRef): void; onDeleted(): void; onToast(msg: string): void;
}) {
  const [key, setKey] = useState(ref_.key);
  const [type, setType] = useState(ref_.type);
  const [fields, setFields] = useState(ref_.fields);
  const [inProjects, setInProjects] = useState(ref_.projects);
  const [note, setNote] = useState(ref_.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = key !== ref_.key || type !== ref_.type || note !== (ref_.note ?? "") || JSON.stringify(fields) !== JSON.stringify(ref_.fields) || inProjects.join() !== ref_.projects.join();
  const extra = Object.keys(fields).filter((k) => !EDIT_FIELDS.some(([f]) => f === k));

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); onToast(`Copied ${what}`); } catch { onToast("Couldn't copy"); }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try { onSaved(await api.libraryUpdate(ref_.id, { key, type, fields, projects: inProjects, note })); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <aside className="lib-detail">
      <div className="row">
        <input className="input sm key-input" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Citation key" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Entry type">
          {[...new Set([...TYPES, type])].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" /></button>
      </div>
      <div className="row gap lib-actions">
        <button className="btn tight" onClick={() => copy(`\\cite{${ref_.key}}`, "\\cite")}><Icon name="copy" size={12} />\cite</button>
        <button className="btn tight" onClick={() => copy(toBibtex(ref_), "BibTeX")}><Icon name="copy" size={12} />BibTeX</button>
        {ref_.fields.doi && <a className="btn tight" href={`https://doi.org/${ref_.fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`} target="_blank" rel="noreferrer">Open DOI</a>}
        {!ref_.fields.doi && ref_.fields.url && <a className="btn tight" href={ref_.fields.url} target="_blank" rel="noreferrer">Open link</a>}
      </div>

      {EDIT_FIELDS.map(([f, label]) => (
        <label key={f} className="lib-field">
          <span className="muted small">{label}</span>
          {f === "title" || f === "author"
            ? <textarea className="notes lib-area" value={fields[f] ?? ""} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} placeholder={f === "author" ? "Last, First and Last, First" : ""} />
            : <input className="input sm" value={fields[f] ?? ""} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} />}
        </label>
      ))}
      {extra.map((f) => (
        <label key={f} className="lib-field">
          <span className="muted small">{f}</span>
          <input className="input sm" value={fields[f] ?? ""} onChange={(e) => setFields({ ...fields, [f]: e.target.value })} />
        </label>
      ))}

      <div className="lib-field">
        <span className="muted small">Used in</span>
        <div className="lib-chips">
          {projects.map((p) => {
            const on = inProjects.includes(p.id);
            return <button key={p.id} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => setInProjects(on ? inProjects.filter((x) => x !== p.id) : [...inProjects, p.id])}>{on && <Icon name="check" size={11} />}{p.name}</button>;
          })}
        </div>
      </div>
      <label className="lib-field">
        <span className="muted small">Notes</span>
        <textarea className="notes lib-area" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it matters, what to cite it for…" />
      </label>
      <p className="muted small">Added by {ref_.addedBy} {relativeTime(ref_.addedAt)}</p>

      {error && <p className="error small">{error}</p>}
      <div className="row gap">
        {confirmDelete
          ? <><span className="small">Remove from the library? Papers keep their copy.</span><button className="btn danger tight" onClick={async () => { await api.libraryDelete(ref_.id); onDeleted(); }}>Remove</button><button className="btn ghost tight" onClick={() => setConfirmDelete(false)}>Cancel</button></>
          : <button className="btn ghost tight" onClick={() => setConfirmDelete(true)}>Remove</button>}
        <div className="spacer" />
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? <Spinner /> : "Save"}</button>
      </div>
    </aside>
  );
}
