import { plainTex } from "./bibtex.ts";

/**
 * The workspace reference library: every paper the group cites, kept once and
 * inserted into any project. `projects` is where it's used (the library's
 * sections); the project's own .bib stays the source LaTeX compiles from.
 */
export interface LibraryRef {
  id: string;
  key: string;
  /** BibTeX entry type, e.g. "article". */
  type: string;
  /** BibTeX fields, lowercase names, values as written (may contain TeX). */
  fields: Record<string, string>;
  projects: string[];
  note?: string;
  addedBy: string;
  addedAt: string;
  updatedAt: string;
  /** The paper itself, kept in the library (DATA_DIR/library/<id>/paper.pdf), never in a project. */
  pdf?: LibraryPdf;
  /** Notes on the paper: a TL;DR, method, results. */
  summary?: LibrarySummary;
  tags?: string[];
  /** Author LaTeX source is stored too (DATA_DIR/library/<id>/source/). */
  hasSource?: boolean;
}

export interface LibraryPdf {
  size: number;
  pages: number;
  addedAt: string;
  addedBy: string;
  source: "upload" | "openalex" | "arxiv" | "import";
}

export interface LibrarySummary {
  markdown: string;
  /** "ai-draft": written from the abstract and conclusion; check the paper before quoting numbers. */
  status: "ai-draft" | "verified";
  updatedAt: string;
  updatedBy: string;
}

/** Where a reference stands in one document. */
export type UsageStatus = "cited" | "formerly-cited" | "bibliography-only" | "dropped";

/** One reference in one document, over time. */
export interface UsageRecord {
  refId: string;
  projectId: string;
  /** The document's root .tex. */
  document: string;
  /** The key that document uses (e.g. ref7). */
  key: string;
  citedNow: boolean;
  inBibliography: boolean;
  firstCited?: string;
  lastCited?: string;
  firstSeen: string;
  lastSeen: string;
}

export function usageStatus(r: Pick<UsageRecord, "citedNow" | "inBibliography" | "lastCited">): UsageStatus {
  if (r.citedNow) return "cited";
  if (r.lastCited) return "formerly-cited";
  return r.inBibliography ? "bibliography-only" : "dropped";
}

export const USAGE_LABEL: Record<UsageStatus, string> = {
  cited: "Cited", "formerly-cited": "Formerly cited", "bibliography-only": "Bibliography only", dropped: "Dropped",
};

export interface UsageView {
  records: (UsageRecord & { status: UsageStatus; projectName: string; documentTitle: string })[];
  /** Documents you can open, per project, for the library's navigation. */
  documents: { projectId: string; path: string; title: string }[];
}

/** What the PDF preview shows when you hover a citation. */
export interface CiteCard {
  /** As printed in numeric styles: "4". */
  label: string;
  /** For author-year styles (natbib): "Vaswani et al., 2017". */
  authorYear?: string;
  key: string;
  title: string;
  byline: string;
  authors?: string;
  venue?: string;
  year?: string;
  doi?: string;
  url?: string;
  tldr?: string;
  refId?: string;
  hasPdf?: boolean;
}

/** Result of looking for a free copy of a paper. */
export interface PdfLookup {
  found: boolean;
  source?: LibraryPdf["source"];
  from?: string;
  /** Where a person can get it when it isn't free. */
  links: { label: string; url: string }[];
  note?: string;
}

export interface LibraryView {
  refs: LibraryRef[];
  /** Projects you can open, for the library's sections. */
  projects: { id: string; name: string }[];
}

export interface LibraryAddResult {
  added: LibraryRef[];
  /** Already in the library (matched by DOI or title); now also in the project. */
  merged: LibraryRef[];
}

/** For \cite completion in a project: what the paper has, and what the library could add. */
export interface CiteOption {
  key: string;
  title: string;
  byline: string;
  /** Set for library references not yet in this paper. */
  refId?: string;
}

export interface CiteOptions { paper: CiteOption[]; library: CiteOption[] }

const surname = (name: string) => {
  const n = plainTex(name).trim();
  if (n.includes(",")) return n.split(",")[0].trim();
  return n.split(/\s+/).pop() ?? n;
};

export const authorList = (author?: string) =>
  (author ?? "").split(/\s+and\s+/i).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== "others");

/** "Wells & Houben, 2020", "Wells et al., 2020". */
export function byline(fields: Record<string, string>) {
  const authors = authorList(fields.author).map(surname);
  const who = authors.length === 0 ? "" : authors.length === 1 ? authors[0]
    : authors.length === 2 ? `${authors[0]} & ${authors[1]}` : `${authors[0]} et al.`;
  return [who, fields.year].filter(Boolean).join(", ");
}

export const refTitle = (fields: Record<string, string>) => plainTex(fields.title ?? "") || "Untitled";
export const refVenue = (fields: Record<string, string>) => plainTex(fields.journal ?? fields.booktitle ?? fields.publisher ?? fields.howpublished ?? "");

const STOP = new Set(["with", "from", "towards", "toward", "using", "into", "about", "over", "under", "between", "through", "their", "this", "that", "what", "when", "where", "which"]);

/** A readable citation key: surname + year + first meaningful title word, e.g. wells2020collabar. */
export function suggestKey(fields: Record<string, string>) {
  const first = authorList(fields.author)[0];
  const name = (first ? surname(first) : "").normalize("NFKD").replace(/[^a-zA-Z]/g, "").toLowerCase() || "ref";
  const word = plainTex(fields.title ?? "").toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length > 3 && !STOP.has(w)) ?? "";
  return `${name}${(fields.year ?? "").replace(/\D/g, "").slice(0, 4)}${word}`;
}

/** Keys that carry no meaning (ref12, b3) get a readable one when they enter the library. */
export const isGenericKey = (key: string) => /^(ref|refs|bib|b|r|cite|c|item)?[-_:]?\d+$/i.test(key);

const norm = (s?: string) => plainTex(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const normDoi = (doi?: string) => (doi ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();

/** Same paper? By DOI when both have one, otherwise by title (and year when both have one). */
export function samePaper(a: Record<string, string>, b: Record<string, string>) {
  const da = normDoi(a.doi), db = normDoi(b.doi);
  if (da && db) return da === db;
  const ta = norm(a.title), tb = norm(b.title);
  if (!ta || ta !== tb) return false;
  return !a.year || !b.year || a.year.trim() === b.year.trim();
}

const FIELD_ORDER = ["author", "title", "journal", "booktitle", "editor", "volume", "number", "pages", "month", "year", "publisher", "address", "organization", "institution", "school", "howpublished", "edition", "series", "note", "doi", "url", "urldate", "eprint", "archiveprefix", "isbn", "issn"];

/** Serialize as a tidy BibTeX entry. */
export function toBibtex(ref: Pick<LibraryRef, "type" | "key" | "fields">) {
  const names = Object.keys(ref.fields).filter((k) => ref.fields[k]?.trim());
  names.sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a), ib = FIELD_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const width = Math.max(0, ...names.map((n) => n.length));
  const body = names.map((n) => `  ${n.padEnd(width)} = {${ref.fields[n].trim()}}`).join(",\n");
  return `@${ref.type || "misc"}{${ref.key},\n${body}\n}`;
}

/** IEEE-style \bibitem text, for papers that keep a hand-written thebibliography. */
export function toBibitem(ref: Pick<LibraryRef, "key" | "fields">) {
  const f = ref.fields;
  const initials = (name: string) => {
    const n = name.trim();
    const [last, first] = n.includes(",") ? [n.split(",")[0], n.split(",").slice(1).join(",")] : [n.split(/\s+/).pop() ?? n, n.split(/\s+/).slice(0, -1).join(" ")];
    const ini = first.split(/[\s.]+/).filter(Boolean).map((p) => p.split("-").map((q) => `${q[0]}.`).join("-")).join(" ");
    return `${ini ? `${ini} ` : ""}${last.trim()}`;
  };
  const authors = authorList(f.author).map(initials);
  const others = /\band\s+others\b/i.test(f.author ?? "");
  const who = authors.length === 0 ? "" : others || authors.length > 6 ? `${authors[0]} \\textit{et al.}`
    : authors.length <= 2 ? authors.join(" and ") : `${authors.slice(0, -1).join(", ")}, and ${authors[authors.length - 1]}`;
  const venue = f.journal ?? f.booktitle;
  const parts = [
    venue ? `${f.booktitle && !f.journal ? "in " : ""}\\textit{${venue}}` : f.publisher,
    f.volume && `vol. ${f.volume}`, f.number && `no. ${f.number}`, f.pages && `pp. ${f.pages.replace(/-+/g, "--")}`,
    [f.month, f.year].filter(Boolean).join(" "),
  ].filter(Boolean);
  const tail = `${parts.join(", ")}${f.doi ? `, doi: ${normDoi(f.doi)}` : f.url ? `. [Online]. Available: \\url{${f.url}}` : ""}.`;
  return `\\bibitem{${ref.key}}\n${who ? `${who},\n` : ""}\`\`${f.title ?? "Untitled"},''\n${tail}`;
}

/**
 * `\bibcite` lines from a LaTeX .aux file: key → printed label. Numeric styles
 * give `\bibcite{ref7}{4}`; natbib gives `\bibcite{k}{{4}{2017}{{Vaswani et~al.}}{{…}}}`,
 * where the label is the number and `authorYear` is "Vaswani et al., 2017".
 */
export function parseBibcite(aux: string): { key: string; label: string; authorYear?: string }[] {
  const out: { key: string; label: string; authorYear?: string }[] = [];
  for (const line of aux.split("\n")) {
    const m = /^\\bibcite\{([^}]+)\}\{(.*)\}\s*$/.exec(line.trim());
    if (!m) continue;
    const body = m[2];
    if (!body.startsWith("{")) { out.push({ key: m[1], label: body.trim() }); continue; }
    const groups: string[] = [];
    let depth = 0, start = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "{") { if (depth++ === 0) start = i + 1; }
      else if (body[i] === "}" && --depth === 0) groups.push(body.slice(start, i));
    }
    const [label = "", year, who] = groups;
    const name = who ? plainTex(who.replace(/^\{|\}$/g, "")).replace(/~/g, " ").trim() : "";
    out.push({ key: m[1], label: label.trim(), authorYear: name && year ? `${name}, ${plainTex(year).trim()}` : undefined });
  }
  return out;
}

/** The labels a printed citation names: "[3, 7]" → 3, 7; "[2]–[5]" and "[2–5]" → 2…5. */
export function citeLabels(raw: string): string[] {
  const text = raw.replace(/\(/g, "[").replace(/\)/g, "]");
  const out: string[] = [];
  const inner = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]).join(",") || text;
  // "[2]–[5]" split across brackets.
  const joined = text.replace(/\]\s*[–—-]\s*\[/g, "–");
  const body = /\]\s*[–—-]\s*\[/.test(text) ? [...joined.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]).join(",") : inner;
  for (const part of body.split(/[,;]/)) {
    const range = /^\s*(\d+)\s*[–—-]\s*(\d+)\s*$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b >= a && b - a < 50) for (let n = a; n <= b; n++) out.push(String(n));
    } else {
      const n = /^\s*(\d+)\s*$/.exec(part);
      if (n) out.push(n[1]);
    }
  }
  return [...new Set(out)];
}

/** The one-line takeaway of a summary: its "TL;DR." line, else its first paragraph. */
export function summaryTldr(md?: string) {
  if (!md) return undefined;
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const tl = /TL;DR\.?\**\s*(.+)/i.exec(body);
  const line = tl?.[1] ?? body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
  return line?.replace(/^>\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 400) || undefined;
}
