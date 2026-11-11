import { useEffect, useRef, useState } from "react";
import { documentLabels, templateById, type DocumentInfo, type Engine } from "@margin/shared";
import { Modal } from "./Dialog.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { TemplateGallery } from "./TemplateGallery.tsx";

const ENGINE_LABEL: Record<Engine, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" };
const KIND: Record<string, string> = { beamer: "Slides", letter: "Letter", tikzposter: "Poster", IEEEtran: "IEEE", article: "Article", report: "Report", book: "Book", standalone: "Figure" };
const kindOf = (d: DocumentInfo) => (d.docClass ? KIND[d.docClass] ?? d.docClass : "Document");

/**
 * Topbar control for projects with several LaTeX documents: pick which one
 * you compile and preview, change its engine, make it the default, or start
 * a new one.
 */
export function DocumentSwitcher({ docs, active, onSelect, onCreate, onSetEngine, onMakeDefault, onRestore, openSignal }: {
  docs: DocumentInfo[];
  active: string;
  onSelect(path: string): void;
  onCreate(): void;
  onSetEngine(path: string, engine: Engine): void;
  onMakeDefault(path: string): void;
  /** Bring an archived document back. */
  onRestore?(path: string): void;
  /** Bumped by ⌘⇧D to open the menu. */
  openSignal: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const current = docs.find((d) => d.path === active);
  const labels = documentLabels(docs);

  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  useEffect(() => {
    if (!open) { setQuery(""); return; }
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close, true); window.removeEventListener("keydown", key); };
  }, [open]);

  const matches = (d: DocumentInfo) => !query || `${d.title} ${d.path}`.toLowerCase().includes(query.toLowerCase());
  const shown = docs.filter((d) => !d.archived && matches(d));
  const archived = docs.filter((d) => d.archived && matches(d));
  const [showArchived, setShowArchived] = useState(false);
  return (
    <div className="doc-switcher" ref={ref}>
      <button className={`chip subtle doc-current ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title={`Document to compile and preview (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}⇧D)`}>
        <Icon name="file" size={12} />
        <span className="ellipsis">{current?.path ?? active}</span>
        {docs.filter((d) => !d.archived).length > 1 && <span className="doc-count">{docs.filter((d) => !d.archived).length}</span>}
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
                  <span className="doc-title ellipsis">{labels.get(d.path) ?? d.title}</span>
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
          {!!archived.length && (
            <>
              <button className="doc-archived-toggle" onClick={() => setShowArchived((v) => !v)}>
                <Icon name="chevron" size={11} className={`chev ${showArchived ? "open" : ""}`} />Archived · {archived.length}
              </button>
              {showArchived && archived.map((d) => (
                <div key={d.path} className="doc-item archived">
                  <div className="doc-pick">
                    <span className="doc-kind">{kindOf(d)}</span>
                    <span className="doc-text">
                      <span className="doc-title ellipsis">{labels.get(d.path) ?? d.title}</span>
                      <span className="muted small ellipsis">{d.path}</span>
                    </span>
                    {onRestore && <button className="btn tight" onClick={() => onRestore(d.path)}>Restore</button>}
                  </div>
                </div>
              ))}
            </>
          )}
          <button className="doc-new" onClick={() => { setOpen(false); onCreate(); }}><Icon name="plus" size={13} />New document…</button>
          <p className="muted small doc-tip">Any .tex file with a <code>\documentclass</code> is a document; agents can create them too.</p>
        </div>
      )}
    </div>
  );
}

export interface NewDocumentInput { title: string; template: string; path?: string; copyFrom?: string }

/**
 * Start a new document, always in a folder of its own (one document per
 * folder): from a template, or from a copy of an existing document, e.g. a
 * journal version of a conference paper. Files several documents use live in
 * the project's shared/ folder.
 */
export function NewDocumentDialog({ docs, initialCopyFrom, onCreate, onClose }: {
  docs: DocumentInfo[];
  /** Open on "Copy of a document" with this one picked (Duplicate). */
  initialCopyFrom?: string;
  onCreate(input: NewDocumentInput): Promise<void>;
  onClose(): void;
}) {
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState<"template" | "copy">(initialCopyFrom ? "copy" : "template");
  const [template, setTemplate] = useState<string>("article");
  const [copyFrom, setCopyFrom] = useState(initialCopyFrom ?? docs.find((d) => d.isDefault)?.path ?? docs[0]?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = documentLabels(docs);
  const fallback = from === "copy" ? `${(copyFrom.includes("/") ? copyFrom.slice(0, copyFrom.lastIndexOf("/")).split("/").pop() : "document")}-copy` : templateById(template)?.name ?? "document";
  const slug = ((title || fallback).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document").slice(0, 40);
  const where = `${slug}/${from === "copy" ? copyFrom.split("/").pop() : "main.tex"}`;

  const chosen = templateById(template);
  return (
    <Modal onClose={onClose} className={from === "template" ? "gallery-modal" : "wide"}>
      <form className={from === "template" ? "gallery-form" : undefined} onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try { await onCreate({ title: title.trim(), template, path: slug, copyFrom: from === "copy" ? copyFrom : undefined }); }
        catch (err) { setError((err as Error).message); setBusy(false); }
      }}>
        <div className="gallery-head">
          <h3 className="modal-title">New document</h3>
          <div className="segmented mode-tabs">
            <button type="button" className={from === "template" ? "active" : ""} onClick={() => setFrom("template")}>Templates</button>
            <button type="button" className={from === "copy" ? "active" : ""} onClick={() => setFrom("copy")} disabled={!docs.length}>Copy of a document</button>
          </div>
        </div>

        {from === "template" ? (
          <TemplateGallery selected={template} onSelect={setTemplate} conferences={false}
            onChoose={(id) => { setTemplate(id); (document.querySelector(".gallery-foot input") as HTMLInputElement | null)?.focus(); }} />
        ) : (
          <>
            <p className="muted small">Another version of a paper you already have, e.g. the journal version of a conference paper.</p>
            <label className="lib-field">
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                {docs.map((d) => <option key={d.path} value={d.path}>{labels.get(d.path) ?? d.title} ({d.path})</option>)}
              </select>
              <span className="muted small">Copies its whole folder: the .tex files, figures and .bib. Your edits go to the copy only.</span>
            </label>
            <input className="input newdoc-title" placeholder="Title, e.g. Journal version" value={title} onChange={(e) => setTitle(e.target.value)} />
            <p className="muted small lib-help">Creates <code>{where}</code></p>
          </>
        )}

        {from === "template" ? (
          <div className="gallery-foot">
            <div className="gallery-pick">
              <span className="gallery-pick-name">{chosen?.name}</span>
              <span className="muted small ellipsis">Creates <code>{where}</code></span>
            </div>
            <input className="input" placeholder="Title, e.g. Conference talk" value={title} onChange={(e) => setTitle(e.target.value)} />
            {error && <p className="error small">{error}</p>}
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy}>{busy ? <Spinner /> : "Create"}</button>
          </div>
        ) : (
          <>
            {error && <p className="error small">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || !copyFrom}>{busy ? <Spinner /> : "Create"}</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
