import { useState } from "react";
import type { CitationReport, CitationStatus } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Icon, Spinner } from "./Icon.tsx";

const LABEL: Record<CitationStatus, string> = { verified: "Verified", likely: "Check", mismatch: "Mismatch", not_found: "Not found", error: "Error" };

export function CitationsPanel({ projectId, onOpen, notify }: { projectId: string; onOpen(path: string, line?: number): void; notify(msg: string): void }) {
  const [report, setReport] = useState<CitationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [doi, setDoi] = useState("");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"problems" | "all">("problems");

  const run = async () => {
    setBusy(true);
    try { setReport(await api.citations(projectId)); } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      const r = await api.addDoi(projectId, doi);
      setDoi("");
      notify(`Added \\cite{${r.key}} to ${r.file}`);
      void navigator.clipboard?.writeText(`\\cite{${r.key}}`).catch(() => {});
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const problems = report ? report.entries.filter((e) => e.status !== "verified").length + report.missing.length : 0;
  const shown = report?.entries.filter((e) => filter === "all" || e.status !== "verified") ?? [];

  return (
    <div className="citations">
      <div className="citations-head">
        <button className="btn primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : <Icon name="check" size={13} />}{report ? "Check again" : "Check citations"}</button>
        {report && (
          <>
            <button className={`chip ${filter === "problems" ? "active" : ""}`} onClick={() => setFilter("problems")}>Problems {problems}</button>
            <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All {report.entries.length}</button>
          </>
        )}
      </div>
      <form className="row gap doi-form" onSubmit={add}>
        <input className="input" placeholder="Add a reference by DOI, e.g. 10.1145/3292500.3330701" value={doi} onChange={(e) => setDoi(e.target.value)} />
        <button className="btn" disabled={adding || !doi.trim()}>{adding ? <Spinner /> : "Add"}</button>
      </form>
      <div className="citations-list">
        {!report && !busy && <div className="empty small">Checks every entry in your .bib files against Crossref and OpenAlex, and every \cite against your .bib, so wrong or made-up references are caught before reviewers find them.</div>}
        {busy && !report && <div className="empty small"><Spinner /> Looking up references…</div>}
        {report?.missing.map((m) => (
          <button key={`missing-${m.key}`} className="cite-row" onClick={() => onOpen(m.file, m.line)}>
            <span className="cite-status not_found">Missing</span>
            <div className="grow"><div className="cite-key">{m.key}</div><div className="muted small">Cited in {m.file}:{m.line} but not in any .bib file or \bibitem.</div></div>
          </button>
        ))}
        {shown.map((e) => (
          <button key={`${e.file}-${e.key}`} className="cite-row" onClick={() => onOpen(e.file, e.line)}>
            <span className={`cite-status ${e.status}`}>{LABEL[e.status]}</span>
            <div className="grow">
              <div className="cite-key">{e.key}{!e.cited && <span className="muted small"> · not cited</span>}</div>
              {e.title && <div className="small cite-title">{e.title}</div>}
              <div className="muted small">{e.note}</div>
              {e.match && e.status !== "verified" && (
                <div className="small cite-match">Found: {e.match.title} ({e.match.authors.slice(0, 2).join(", ")}{e.match.authors.length > 2 ? " et al." : ""}{e.match.year ? `, ${e.match.year}` : ""}){e.match.doi && <> · <a href={`https://doi.org/${e.match.doi}`} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>{e.match.doi}</a></>}</div>
              )}
            </div>
          </button>
        ))}
        {report && !shown.length && !report.missing.length && <div className="empty small">All {report.entries.length} references check out.</div>}
      </div>
    </div>
  );
}
