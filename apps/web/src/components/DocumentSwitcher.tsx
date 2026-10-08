import { useEffect, useRef, useState } from "react";
import { DOCUMENT_TEMPLATES, type DocumentInfo, type Engine } from "@margin/shared";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";

const ENGINE_LABEL: Record<Engine, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };
const KIND: Record<string, string> = { beamer: "Slides", letter: "Letter", tikzposter: "Poster", IEEEtran: "IEEE", article: "Article", report: "Report", book: "Book", standalone: "Figure" };
const kindOf = (d: DocumentInfo) => (d.docClass ? KIND[d.docClass] ?? d.docClass : "Document");

/**
 * Topbar control for projects with several LaTeX documents: pick which one
 * you compile and preview, change its engine, make it the default, or start
 * a new one.
 */
export function DocumentSwitcher({ docs, active, onSelect, onCreate, onSetEngine, onMakeDefault, openSignal }: {
  docs: DocumentInfo[];
  active: string;
  onSelect(path: string): void;
  onCreate(): void;
  onSetEngine(path: string, engine: Engine): void;
  onMakeDefault(path: string): void;
  /** Bumped by ⌘⇧D to open the menu. */
  openSignal: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const current = docs.find((d) => d.path === active);

  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  useEffect(() => {
    if (!open) { setQuery(""); return; }
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close, true); window.removeEventListener("keydown", key); };
  }, [open]);

  const shown = docs.filter((d) => !query || `${d.title} ${d.path}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="doc-switcher" ref={ref}>
      <button className={`chip subtle doc-current ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title={`Document to compile and preview (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}⇧D)`}>
        <Icon name="file" size={12} />
        <span className="ellipsis">{current?.path ?? active}</span>
        {docs.length > 1 && <span className="doc-count">{docs.length}</span>}
        <span className="muted">· {ENGINE_LABEL[current?.engine ?? "pdflatex"]}</span>
        <Icon name="chevron" size={11} className="doc-caret" />
      </button>
      {open && (
        <div className="doc-menu">
          {docs.length > 5 && <input className="input sm doc-filter" autoFocus placeholder="Find a document…" value={query} onChange={(e) => setQuery(e.target.value)} />}
          <div className="doc-menu-label">Documents in this project</div>
          {shown.map((d) => (
            <div key={d.path} className={`doc-item ${d.path === active ? "on" : ""}`}>
              <button className="doc-pick" onClick={() => { onSelect(d.path); setOpen(false); }}>
                <span className={`doc-kind k-${(d.docClass ?? "x").toLowerCase()}`}>{kindOf(d)}</span>
                <span className="doc-text">
                  <span className="doc-title ellipsis">{d.title}</span>
                  <span className="muted small ellipsis">{d.path}{d.isDefault ? " · default" : ""}{d.hasPdf ? "" : " · not compiled"}</span>
                </span>
                {d.path === active && <Icon name="check" size={14} />}
              </button>
              {d.path === active && (
                <div className="doc-settings">
                  <select value={d.engine} onChange={(e) => onSetEngine(d.path, e.target.value as Engine)} aria-label="Engine">
                    {(Object.keys(ENGINE_LABEL) as Engine[]).map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}
                  </select>
                  {!d.isDefault && <button className="link-btn" onClick={() => { onMakeDefault(d.path); setOpen(false); }}>Make default</button>}
                </div>
              )}
            </div>
          ))}
          <button className="doc-new" onClick={() => { setOpen(false); onCreate(); }}><Icon name="plus" size={13} />New document…</button>
          <p className="muted small doc-tip">Any .tex file with a <code>\documentclass</code> is a document; agents can create them too.</p>
        </div>
      )}
    </div>
  );
}

export function NewDocumentDialog({ defaultDir, onCreate, onClose }: {
  defaultDir: string;
  onCreate(input: { title: string; template: string; path?: string }): Promise<void>;
  onClose(): void;
}) {
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<string>("beamer");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = (title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || DOCUMENT_TEMPLATES.find((t) => t.id === template)!.label.toLowerCase()).slice(0, 40);
  const suggested = `${defaultDir === "." ? "" : `${defaultDir}/`}${slug}.tex`;

  return (
    <Modal onClose={onClose} wide>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try { await onCreate({ title: title.trim(), template, path: path.trim() || undefined }); }
        catch (err) { setError((err as Error).message); setBusy(false); }
      }}>
        <h3 className="modal-title">New document</h3>
        <p className="muted small">Slides, a cover letter, a rebuttal or a poster that lives with the paper and can use the same references, macros and figures.</p>
        <input className="input" autoFocus placeholder="Title, e.g. Conference talk" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="templates doc-templates">
          {DOCUMENT_TEMPLATES.map((t) => (
            <label key={t.id} className={`template ${template === t.id ? "active" : ""}`}>
              <input type="radio" name="doc-template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span className="template-label">{t.label}</span>
              <span className="muted small">{t.hint}</span>
            </label>
          ))}
        </div>
        <label className="lib-field">
          <span className="muted small">File</span>
          <input className="input sm mono" placeholder={suggested} value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <p className="muted small lib-help">Next to the main document by default, so it can use the same .bib and figures (LaTeX can't read ../ folders here).</p>
        {error && <p className="error small">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : "Create"}</button>
        </div>
      </form>
    </Modal>
  );
}
