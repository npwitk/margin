import { useEffect, useMemo, useRef, useState } from "react";
import { byline, checkProxy, normDoi, refTitle, refVenue, toBibtex, USAGE_LABEL, viaProxy, type LibraryRef, type LibraryView, type PdfLookup, type Session, type UsageStatus, type UsageView } from "@margin/shared";
import { api } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.ts";
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

type Usage = UsageView["records"][number];
const STATUS_ORDER: UsageStatus[] = ["cited", "formerly-cited", "bibliography-only", "dropped"];
/** The most telling status among a reference's records: cited beats formerly cited, and so on. */
const bestStatus = (records: Usage[]) => STATUS_ORDER.find((s) => records.some((r) => r.status === s));

export function Library({ section, doc, initialRef, session }: { section: Section; doc?: string; initialRef?: string; session: Session }) {
  const [view, setView] = useState<LibraryView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [status, setStatus] = useState<UsageStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialRef ?? null);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reload = () => api.library().then(setView).catch((e) => setError(e.message));
  useEffect(() => { void reload(); }, []);
  const inProject = section !== undefined && section !== "none";
  useEffect(() => {
    setUsage(null);
    api.libraryUsage(inProject ? { project: section } : {}).then(setUsage).catch(() => {});
  }, [section]);
  useEffect(() => { if (initialRef) setSelected(initialRef); }, [initialRef]);
  useEffect(() => { setStatus("all"); }, [section, doc]);

  /** This reference's records in the current scope (project, and document if one is chosen). */
  const scoped = (r: LibraryRef) => usage?.records.filter((u) => u.refId === r.id && (!inProject || u.projectId === section) && (!doc || u.document === doc)) ?? [];
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const projectName = (id: string) => view?.projects.find((p) => p.id === id)?.name ?? id;
  const inSection = (r: LibraryRef) => {
    if (section === undefined) return true;
    if (section === "none") return r.projects.length === 0;
    const mine = scoped(r);
    if (doc) return mine.length > 0;
    return r.projects.includes(section) || mine.length > 0;
  };
  const inStatus = (r: LibraryRef) => status === "all" || scoped(r).some((u) => u.status === status);

  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.refs
      .filter(inSection)
      .filter(inStatus)
      .filter((r) => !q || [r.key, r.fields.title, r.fields.author, r.fields.year, r.fields.journal, r.fields.booktitle, r.fields.doi, ...(r.tags ?? [])].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => {
        // In a paper, order by the key it cites them with (ref1, ref2 … ref10); elsewhere newest first.
        const ka = scoped(a)[0]?.key, kb = scoped(b)[0]?.key;
        return inProject && ka && kb ? ka.localeCompare(kb, undefined, { numeric: true }) : b.addedAt.localeCompare(a.addedAt);
      });
  }, [view, usage, query, section, doc, status]);

  const statusCount = (s: UsageStatus | "all") => view?.refs.filter(inSection).filter((r) => s === "all" || scoped(r).some((u) => u.status === s)).length ?? 0;
  const docsOf = (projectId: string) => usage?.documents.filter((d) => d.projectId === projectId) ?? [];

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
        <button className="btn ghost" onClick={() => setSettingsOpen(true)} title="Get paywalled papers through your university library"><Icon name="key" size={13} />Library access</button>
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
            <div key={p.id}>
              <NavItem active={section === p.id && !doc} onClick={() => navigate({ name: "library", project: p.id })} icon="file" label={p.name} n={count(p.id)} />
              {section === p.id && docsOf(p.id).length > 1 && docsOf(p.id).map((d) => (
                <button key={d.path} className={`lib-nav-item lib-nav-doc ${doc === d.path ? "active" : ""}`} title={d.path}
                  onClick={() => navigate({ name: "library", project: p.id, doc: d.path })}>
                  <span className="grow ellipsis">{d.title}</span>
                  <span className="muted small">{usage?.records.filter((u) => u.projectId === p.id && u.document === d.path).length ?? ""}</span>
                </button>
              ))}
            </div>
          ))}
          {view && !view.projects.length && <p className="muted small">No papers yet.</p>}
        </nav>

        <main className="lib-main">
          {error && <p className="error">{error}</p>}
          {!view && !error && <div className="empty"><Spinner /></div>}
          {view && section && section !== "none" && (
            <div className="lib-section-head">
              <h2>{projectName(section)}{doc && <span className="muted"> › {usage?.documents.find((d) => d.projectId === section && d.path === doc)?.title ?? doc}</span>}</h2>
              <div className="spacer" />
              <ImportPaperButton projectId={section} onDone={(msg) => { setToast(msg); void reload(); }} />
              <button className="btn ghost" onClick={() => navigate({ name: "project", id: section })}>Open paper</button>
            </div>
          )}
          {view && inProject && (
            <div className="lib-filters" role="tablist" aria-label="Filter by citation status">
              {(["all", "cited", "formerly-cited", "bibliography-only", "dropped"] as const).map((s) => {
                const n = statusCount(s);
                if (s !== "all" && s !== status && !n) return null;
                return (
                  <button key={s} role="tab" aria-selected={status === s} className={`chip ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>
                    {s === "all" ? "All" : USAGE_LABEL[s]} <span className="muted">{n}</span>
                  </button>
                );
              })}
              {!usage && <Spinner />}
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
                    {inProject ? (() => {
                      const mine = scoped(r);
                      const best = bestStatus(mine);
                      return <>
                        {mine[0] && mine[0].key !== r.key && <span className="key-chip subtle" title="Key in this paper">{mine[0].key}</span>}
                        {best && <span className={`chip status-${best}`}>{USAGE_LABEL[best]}</span>}
                      </>;
                    })() : <>
                      {r.projects.slice(0, 2).map((p) => <span key={p} className="chip subtle">{projectName(p)}</span>)}
                      {r.projects.length > 2 && <span className="chip subtle">+{r.projects.length - 2}</span>}
                    </>}
                    {r.summary && <span className={`chip subtle ${r.summary.status === "verified" ? "" : "warn"}`} title={`Summary: ${r.summary.status}`}>{r.summary.status === "verified" ? "Notes" : "Draft notes"}</span>}
                    <span title={r.pdf ? `PDF, ${r.pdf.pages} pages` : "No PDF yet"} className={r.pdf ? "" : "lib-faint"}><Icon name="pdf" size={14} /></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </main>

        {current && view && (
          <RefDetail key={current.id} ref_={current} projects={view.projects} proxy={view.proxy} onClose={() => setSelected(null)}
            onSaved={(r) => { replace(r); setToast("Saved"); }}
            onDeleted={() => { setView((v) => v && { ...v, refs: v.refs.filter((r) => r.id !== current.id) }); setSelected(null); }}
            onChanged={replace}
            onToast={setToast} />
        )}
      </div>
      {adding && view && (
        <AddDialog projects={view.projects} defaultProject={section && section !== "none" ? section : undefined} onClose={() => setAdding(false)}
          onDone={(msg) => { setAdding(false); setToast(msg); void reload(); }} />
      )}
      {settingsOpen && view && (
        <AccessDialog proxy={view.proxy} onClose={() => setSettingsOpen(false)}
          onSaved={(proxy) => { setView((v) => v && { ...v, proxy }); setSettingsOpen(false); setToast(proxy ? "Library access saved" : "Library access removed"); }} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** The university library's proxy link, so papers open behind its sign-in. */
function AccessDialog({ proxy, onClose, onSaved }: { proxy?: string; onClose(): void; onSaved(proxy?: string): void }) {
  const [value, setValue] = useState(proxy ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkProxy(value);
  const example = checked.proxy ? viaProxy(checked.proxy, "https://doi.org/10.1016/j.jisa.2026.104550") : undefined;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checked.error) { setError(checked.error); return; }
    setBusy(true); setError(null);
    try { onSaved((await api.librarySettings(value)).proxy); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={save}>
        <h3 className="modal-title">Library access</h3>
        <p className="muted small lib-help">
          Margin finds free copies of papers by itself. For paywalled ones, it can give you a link that opens the paper through your university library:
          you sign in with your university account, download the PDF, and drop it on the reference. Margin never sees your university password.
        </p>
        <label className="lib-field">
          <span className="muted small">Your library's proxy link</span>
          <input className="input sm mono" autoFocus placeholder="https://ezproxy.your-university.ac.th/login?url=" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} />
        </label>
        <p className="muted small lib-help">
          Find it on your library's website under off-campus or remote access (often called EZproxy or OpenAthens): it's the start of any link that opens a journal through the library.
          If the paper's address goes in the middle, write <code>{"{url}"}</code> where it goes.
        </p>
        {example && <p className="small lib-help">A paper would open at: <a href={example} target="_blank" rel="noreferrer" className="mono">{example}</a></p>}
        {error && <p className="error small">{error}</p>}
        <div className="modal-actions">
          {proxy && <button type="button" className="btn ghost" disabled={busy} onClick={async () => { setBusy(true); try { onSaved((await api.librarySettings("")).proxy); } catch (err) { setError((err as Error).message); setBusy(false); } }}>Remove</button>}
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !!checked.error || !value.trim()}>{busy ? <Spinner /> : "Save"}</button>
        </div>
      </form>
    </Modal>
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

function RefDetail({ ref_, projects, proxy, onClose, onSaved, onDeleted, onToast, onChanged }: {
  ref_: LibraryRef; projects: LibraryView["projects"]; proxy?: string; onClose(): void; onSaved(r: LibraryRef): void; onDeleted(): void; onToast(msg: string): void; onChanged(r: LibraryRef): void;
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

      <PaperFile ref_={ref_} proxy={proxy} onChanged={onChanged} onToast={onToast} />
      <SummaryNotes ref_={ref_} onChanged={onChanged} onToast={onToast} />
      <CitationHistory refId={ref_.id} />

      <div className="section-label lib-detail-gap">Details</div>
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

/** The paper itself: open it, attach one, or look for a free copy. */
function PaperFile({ ref_, proxy, onChanged, onToast }: { ref_: LibraryRef; proxy?: string; onChanged(r: LibraryRef): void; onToast(msg: string): void }) {
  const doi = normDoi(ref_.fields.doi);
  const target = doi ? `https://doi.org/${doi}` : ref_.fields.url;
  const libraryUrl = target ? viaProxy(proxy, target) : undefined;
  const [busy, setBusy] = useState<"find" | "attach" | null>(null);
  const [lookup, setLookup] = useState<PdfLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const attach = async (file?: File | null) => {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") { setError("That isn't a PDF"); return; }
    setBusy("attach"); setError(null);
    try { onChanged(await api.libraryAttachPdf(ref_.id, file)); setLookup(null); onToast("PDF attached"); }
    catch (e) { setError((e as Error).message); }
    setBusy(null);
  };
  const find = async () => {
    setBusy("find"); setError(null);
    try {
      const r = await api.libraryFindPdf(ref_.id);
      onChanged(r.ref);
      setLookup(r.found ? null : r);
      if (r.found) onToast("Found a free copy and attached it");
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  return (
    <div className={`lib-paper ${over ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void attach(e.dataTransfer.files[0]); }}>
      <div className="section-label">Paper</div>
      {ref_.pdf ? (
        <div className="row gap">
          <a className="btn tight" href={api.libraryPdfUrl(ref_.id)} target="_blank" rel="noreferrer"><Icon name="pdf" size={13} />Open PDF</a>
          <span className="muted small">{ref_.pdf.pages} pages · {relativeTime(ref_.pdf.addedAt)}</span>
          <div className="spacer" />
          <button className="btn ghost tight" title="Replace with another file" onClick={() => input.current?.click()}>Replace</button>
        </div>
      ) : (
        <>
          <div className="row gap">
            <button className="btn tight" disabled={!!busy} onClick={find}>{busy === "find" ? <Spinner /> : <Icon name="search" size={12} />}Find free PDF</button>
            {libraryUrl && <a className="btn tight" href={libraryUrl} target="_blank" rel="noreferrer" title="Opens the paper through your university library's sign-in">Via your library<Icon name="external" size={11} /></a>}
            <button className="btn tight" disabled={!!busy} onClick={() => input.current?.click()}>{busy === "attach" ? <Spinner /> : <Icon name="upload" size={12} />}Attach PDF</button>
          </div>
          <p className="muted small">{libraryUrl ? "Download it through your library, then drop the PDF here." : "Drop the PDF here once you have it."} Agents can read it once it's attached.</p>
        </>
      )}
      {lookup && !lookup.found && (
        <div className="lib-lookup">
          <p className="small">{lookup.note}</p>
          <ul>{lookup.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external" size={11} /></a></li>)}</ul>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}

/** Notes on the paper: a TL;DR first (it shows on hover in the PDF preview), then anything else. */
function SummaryNotes({ ref_, onChanged, onToast }: { ref_: LibraryRef; onChanged(r: LibraryRef): void; onToast(msg: string): void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ref_.summary?.markdown ?? "");
  const [busy, setBusy] = useState(false);
  const html = useMemo(() => (ref_.summary ? renderMarkdown(ref_.summary.markdown) : ""), [ref_.summary?.markdown]);

  const save = async (patch: { summary?: string; summaryStatus?: "ai-draft" | "verified" }) => {
    setBusy(true);
    try { onChanged(await api.libraryUpdate(ref_.id, patch)); setEditing(false); onToast("Saved"); }
    catch (e) { onToast((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="lib-summary">
      <div className="row gap">
        <div className="section-label">Summary</div>
        {ref_.summary && <span className={`chip ${ref_.summary.status === "verified" ? "" : "warn"}`} title={ref_.summary.status === "ai-draft" ? "Written from the abstract; check the paper before quoting numbers" : `Checked by ${ref_.summary.updatedBy}`}>{ref_.summary.status === "verified" ? "Verified" : "AI draft"}</span>}
        <div className="spacer" />
        {!editing && ref_.summary?.status === "ai-draft" && <button className="btn ghost tight" disabled={busy} onClick={() => save({ summaryStatus: "verified" })}>Mark verified</button>}
        {!editing && <button className="btn ghost tight" onClick={() => { setText(ref_.summary?.markdown ?? "> **TL;DR.** \n"); setEditing(true); }}>{ref_.summary ? "Edit" : "Write"}</button>}
      </div>
      {editing ? (
        <>
          <textarea className="notes lib-area mono lib-summary-edit" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="row gap">
            <div className="spacer" />
            <button className="btn ghost tight" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn primary tight" disabled={busy} onClick={() => save({ summary: text })}>{busy ? <Spinner /> : "Save"}</button>
          </div>
        </>
      ) : ref_.summary
        ? <article className="md lib-summary-body" dangerouslySetInnerHTML={{ __html: html }} />
        : <p className="muted small">No notes yet. Ask an agent to read the paper and write them (update_reference_summary).</p>}
    </div>
  );
}

/** Every document that cites, cited, or lists this reference. */
function CitationHistory({ refId }: { refId: string }) {
  const [records, setRecords] = useState<Usage[] | null>(null);
  useEffect(() => { api.libraryUsage({ ref: refId }).then((u) => setRecords(u.records)).catch(() => setRecords([])); }, [refId]);
  const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  return (
    <div className="lib-history">
      <div className="section-label">Citation history</div>
      {records === null ? <Spinner /> : !records.length ? <p className="muted small">Not in any document yet.</p> : (
        <ul>
          {records.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)).map((u) => (
            <li key={`${u.projectId}:${u.document}`}>
              <button className="lib-history-doc" onClick={() => navigate({ name: "library", project: u.projectId, doc: u.document, ref: refId })}>
                <span className="ellipsis">{u.projectName} › {u.documentTitle}</span>
              </button>
              <span className={`chip status-${u.status}`}>{USAGE_LABEL[u.status]}</span>
              <span className="muted small">
                <code>\cite{"{"}{u.key}{"}"}</code>{" "}
                {u.status === "cited" ? `since ${day(u.firstCited)}` : u.lastCited ? `${day(u.firstCited)} – ${day(u.lastCited)}` : `listed since ${day(u.firstSeen)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
