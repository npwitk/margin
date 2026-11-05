import { useState } from "react";
import type { CiteCard } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { Icon, Spinner } from "./Icon.tsx";

export interface CiteActions {
  projectId: string;
  /** Show the paper's PDF (stored in the library) beside your own. */
  onOpenPdf(card: CiteCard): void;
  /** A free PDF was found and attached, so the map should be refreshed. */
  onChanged?(): void;
}

/** What a citation points to: shown when you hover "[4]" in the PDF preview. */
export function CiteCards({ cards, actions }: { cards: CiteCard[]; actions: CiteActions }) {
  return (
    <div className="cite-cards">
      {cards.map((c) => <OneCard key={c.key} card={c} actions={actions} />)}
    </div>
  );
}

function OneCard({ card, actions }: { card: CiteCard; actions: CiteActions }) {
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<{ note?: string; links: { label: string; url: string }[] } | null>(null);

  const find = async () => {
    if (!card.refId) return;
    setBusy(true);
    try {
      const r = await api.libraryFindPdf(card.refId);
      if (r.found) actions.onChanged?.();
      else setLinks(r);
    } catch (e) { setLinks({ note: (e as Error).message, links: [] }); }
    setBusy(false);
  };

  return (
    <div className="cite-card">
      <div className="cite-card-head">
        <span className="cite-label">{card.authorYear ?? `[${card.label}]`}</span>
        <span className="key-chip subtle">{card.key}</span>
      </div>
      <div className="cite-title">{card.title}</div>
      <div className="muted small">{[card.authors ?? card.byline, card.venue, card.year].filter(Boolean).join(" · ")}</div>
      {card.tldr && <p className="cite-tldr small">{card.tldr}</p>}
      <div className="cite-actions">
        {card.hasPdf && card.refId && <button className="btn tight" onClick={() => actions.onOpenPdf(card)}><Icon name="pdf" size={12} />Open PDF</button>}
        {!card.hasPdf && card.libraryUrl && <a className="btn tight" href={card.libraryUrl} target="_blank" rel="noreferrer" title="Opens the paper through your university library's sign-in">Via your library<Icon name="external" size={11} /></a>}
        {!card.hasPdf && card.refId && <button className="btn tight" disabled={busy} onClick={find}>{busy ? <Spinner /> : <Icon name="search" size={12} />}Find free PDF</button>}
        {card.refId && <button className="btn ghost tight" onClick={() => navigate({ name: "library", project: actions.projectId, ref: card.refId })}><Icon name="book" size={12} />Library</button>}
        {card.doi && <a className="btn ghost tight" href={`https://doi.org/${card.doi}`} target="_blank" rel="noreferrer">DOI<Icon name="external" size={11} /></a>}
        {!card.doi && card.url && <a className="btn ghost tight" href={card.url} target="_blank" rel="noreferrer">Link<Icon name="external" size={11} /></a>}
      </div>
      {links && (
        <div className="cite-links small">
          {links.note && <p>{links.note}</p>}
          {links.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external" size={10} /></a>)}
        </div>
      )}
    </div>
  );
}
