import { useEffect, useMemo, useState } from "react";
import { TEMPLATE_CATEGORIES, TEMPLATES, templateById, type ConferenceEdition, type TemplateCategory, type TemplateInfo } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Icon, Spinner } from "./Icon.tsx";

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  Basic: "Basic", Conference: "Conference papers", Journal: "Journals", Slides: "Slides",
  Poster: "Posters", "Thesis & reports": "Thesis & reports", "Letters & CV": "Letters & CV",
};

/** "in 12 days", "tomorrow", "closed". */
export function untilDeadline(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "Deadline not announced";
  const ms = Date.parse(iso) - now;
  if (ms < 0) return "Deadline passed";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return `${Math.max(1, Math.round(ms / 3_600_000))} h left`;
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function matches(t: TemplateInfo, q: string) {
  const hay = `${t.name} ${t.detail} ${t.keywords ?? ""} ${t.venues?.join(" ") ?? ""} ${t.category}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Choose a template like in Keynote or PowerPoint: categories on the left,
 * previews of each one's first page, a search that also finds conferences
 * and their next deadline (and picks the format they use).
 */
export function TemplateGallery({ selected, onSelect, onChoose, venue, onVenue, conferences = true, filter }: {
  selected: string;
  onSelect(id: string): void;
  /** Double-click: pick and go. */
  onChoose?(id: string): void;
  venue?: ConferenceEdition | null;
  onVenue?(c: ConferenceEdition | null): void;
  /** Search conference deadlines too. */
  conferences?: boolean;
  /** Only offer some templates (e.g. ones that work next to an existing paper). */
  filter?(t: TemplateInfo): boolean;
}) {
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [query, setQuery] = useState("");
  const [confs, setConfs] = useState<ConferenceEdition[] | null>(null);
  const [loadingConfs, setLoadingConfs] = useState(false);

  useEffect(() => {
    if (!conferences) return;
    let cancelled = false;
    setLoadingConfs(true);
    const t = setTimeout(() => {
      api.conferences(query.trim())
        .then((r) => { if (!cancelled) setConfs(r); })
        .catch(() => { if (!cancelled) setConfs([]); })
        .finally(() => { if (!cancelled) setLoadingConfs(false); });
    }, query ? 220 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, conferences]);

  const pool = useMemo(() => TEMPLATES.filter((t) => !filter || filter(t)), [filter]);
  const shown = pool.filter((t) => (category === "All" || t.category === category) && (!query.trim() || matches(t, query)));
  const groups = TEMPLATE_CATEGORIES.map((c) => ({ c, items: shown.filter((t) => t.category === c) })).filter((g) => g.items.length);
  const confList = (confs ?? []).slice(0, query.trim() ? 8 : 5);
  const showConfs = conferences && (category === "All" || category === "Conference") && (confList.length > 0 || (loadingConfs && !!query.trim()));

  const pickConference = (c: ConferenceEdition) => {
    if (venue?.name === c.name && venue.year === c.year) { onVenue?.(null); return; }
    onVenue?.(c);
    if (c.template && (!filter || filter(templateById(c.template)!))) onSelect(c.template);
  };

  return (
    <div className="tg">
      <nav className="tg-nav">
        {(["All", ...TEMPLATE_CATEGORIES] as const).map((c) => {
          const n = c === "All" ? pool.length : pool.filter((t) => t.category === c).length;
          if (!n) return null;
          return (
            <button key={c} type="button" className={category === c ? "active" : ""} onClick={() => setCategory(c)}>
              <span className="grow">{c === "All" ? "All templates" : CATEGORY_LABEL[c]}</span>
              <span className="tg-count">{n}</span>
            </button>
          );
        })}
      </nav>
      <div className="tg-main">
        <label className="search-field tg-search">
          <Icon name="search" size={14} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={conferences ? "Search templates or conferences, like “CCS” or “NeurIPS”" : "Search templates"} />
          {query && <button type="button" className="tg-clear" onClick={() => setQuery("")} aria-label="Clear"><Icon name="x" size={12} /></button>}
        </label>

        {showConfs && (
          <section className="tg-section">
            <h4>{query.trim() ? "Conferences" : "Upcoming deadlines"}{loadingConfs && <Spinner size={11} />}</h4>
            <div className="tg-confs">
              {confList.map((c) => {
                const t = c.template ? templateById(c.template) : undefined;
                const on = venue?.name === c.name && venue.year === c.year;
                const open = !!c.deadline && Date.parse(c.deadline) > Date.now();
                return (
                  <button key={`${c.name}-${c.year}-${c.round ?? ""}`} type="button" className={`tg-conf ${on ? "on" : ""}`} onClick={() => pickConference(c)}
                    title={c.deadline ? `Submission deadline ${new Date(c.deadline).toLocaleString()} (${c.timezone ?? "AoE"} in the call for papers)` : undefined}>
                    <span className="tg-conf-name">{c.name} {c.year}</span>
                    <span className="tg-conf-desc ellipsis">{c.description}{c.place ? ` · ${c.place}` : ""}</span>
                    <span className={`tg-conf-when ${open ? "" : "closed"}`}>
                      <strong>{untilDeadline(c.deadline)}</strong>
                      {c.deadline && <span>{dateOf(c.deadline)}{c.round && c.round.length < 24 ? ` · ${c.round}` : ""}</span>}
                    </span>
                    <span className={`tg-conf-format ${t ? "" : "unknown"}`}>{t ? t.name : "Pick a format"}</span>
                    {on && <Icon name="check" size={14} className="tg-conf-check" />}
                  </button>
                );
              })}
              {!confList.length && <p className="muted small tg-none">Looking up conferences…</p>}
            </div>
          </section>
        )}

        {groups.map(({ c, items }) => (
          <section key={c} className="tg-section">
            <h4>{CATEGORY_LABEL[c]}</h4>
            <div className={`tg-grid ${c === "Slides" ? "wide" : ""}`}>
              {items.map((t) => (
                <button key={t.id} type="button" className={`tg-card ${selected === t.id ? "on" : ""}`}
                  onClick={() => onSelect(t.id)} onDoubleClick={() => onChoose?.(t.id)}>
                  <span className={`tg-thumb ${t.shape ?? "page"}`}>
                    <img src={`/templates/${t.id}.jpg`} alt="" loading="lazy" draggable={false} />
                  </span>
                  <span className="tg-name">{t.name}</span>
                  <span className="tg-detail">{t.detail}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && !showConfs && <p className="muted tg-none">No templates match “{query}”.</p>}
      </div>
    </div>
  );
}
