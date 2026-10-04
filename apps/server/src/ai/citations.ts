import { parseBibtex, plainTex, citedKeys, titleSimilarity, type CitationCheck, type CitationMatch, type CitationReport, type Session } from "@margin/shared";
import { writeThroughCollab } from "../collab.ts";
import { writeText } from "../storage.ts";
import { textFiles, textOf } from "./paper.ts";

/**
 * Checks every .bib entry against Crossref (and OpenAlex as a fallback) so
 * made-up or mangled references are caught before reviewers find them.
 */

const CROSSREF = process.env.CROSSREF_API_URL ?? "https://api.crossref.org";
const OPENALEX = process.env.OPENALEX_API_URL ?? "https://api.openalex.org";
const DOI_RESOLVER = process.env.DOI_RESOLVER_URL ?? "https://doi.org";
const UA = `Margin/0.1 (https://github.com/margin; ${process.env.CROSSREF_MAILTO ? `mailto:${process.env.CROSSREF_MAILTO}` : "research writing tool"})`;

async function getJson(url: string): Promise<unknown | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    if (!res) throw new Error("network");
    if (res.status === 404) return null;
    // Public APIs rate-limit bursts: back off and retry a few times.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Math.min(8, Number(res.headers.get("retry-after")) || 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

type CrossrefWork = { title?: string[]; subtitle?: string[]; author?: { family?: string; given?: string; name?: string }[]; issued?: { "date-parts"?: number[][] }; DOI?: string; URL?: string; "container-title"?: string[] };
type OpenAlexWork = { display_name?: string; publication_year?: number; doi?: string | null; id?: string; authorships?: { author?: { display_name?: string } }[]; primary_location?: { source?: { display_name?: string } | null } | null };

const fromCrossref = (w: CrossrefWork): CitationMatch => ({
  title: [w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(": "),
  authors: (w.author ?? []).map((a) => a.family ?? a.name ?? "").filter(Boolean),
  year: w.issued?.["date-parts"]?.[0]?.[0],
  doi: w.DOI,
  url: w.URL,
  venue: w["container-title"]?.[0],
  source: "crossref",
});

const fromOpenAlex = (w: OpenAlexWork): CitationMatch => ({
  title: w.display_name ?? "",
  authors: (w.authorships ?? []).map((a) => (a.author?.display_name ?? "").split(" ").pop() ?? "").filter(Boolean),
  year: w.publication_year,
  doi: w.doi?.replace(/^https?:\/\/doi\.org\//, "") || undefined,
  url: w.doi ?? w.id,
  venue: w.primary_location?.source?.display_name,
  source: "openalex",
});

async function byDoi(doi: string): Promise<CitationMatch | null> {
  const cr = await getJson(`${CROSSREF}/works/${encodeURIComponent(doi)}`) as { message?: CrossrefWork } | null;
  if (cr?.message) return fromCrossref(cr.message);
  const oa = await getJson(`${OPENALEX}/works/doi:${encodeURIComponent(doi)}`) as OpenAlexWork | null;
  return oa?.display_name ? fromOpenAlex(oa) : null;
}

async function crossrefSearch(title: string, author?: string) {
  const q = new URLSearchParams({ "query.bibliographic": `${title} ${author ?? ""}`.trim(), rows: "5", select: "DOI,title,subtitle,author,issued,container-title,URL" });
  const cr = await getJson(`${CROSSREF}/works?${q}`) as { message?: { items?: CrossrefWork[] } } | null;
  return (cr?.message?.items ?? []).map(fromCrossref);
}

async function openAlexSearch(title: string) {
  const oa = await getJson(`${OPENALEX}/works?${new URLSearchParams({ search: title, "per-page": "5" })}`) as { results?: OpenAlexWork[] } | null;
  return (oa?.results ?? []).map(fromOpenAlex);
}

const firstAuthor = (authorField?: string) => {
  const first = plainTex(authorField ?? "").split(/\s+and\s+/i)[0] ?? "";
  return (first.includes(",") ? first.split(",")[0] : first.split(" ").pop() ?? "").trim().toLowerCase();
};

const cache = new Map<string, Promise<Omit<CitationCheck, "key" | "file" | "line" | "cited">>>();

async function check(fields: Record<string, string>) {
  const title = fields.title ? plainTex(fields.title) : undefined;
  const year = Number(fields.year) || undefined;
  const doi = fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim() || undefined;
  const author = firstAuthor(fields.author);
  const base = { title, year, doi };
  if (!title && !doi) return { ...base, status: "error" as const, note: "Entry has no title or DOI." };

  // Compare full titles, and main titles (before a colon) since databases split subtitles differently.
  const similarity = (m: CitationMatch) => title
    ? Math.max(titleSimilarity(title, m.title), titleSimilarity(title.split(":")[0], m.title.split(":")[0]) * 0.97)
    : 1;
  const judge = (m: CitationMatch, how: string) => {
    const sim = similarity(m);
    const authorOk = !author || m.authors.some((a) => a.toLowerCase().includes(author) || author.includes(a.toLowerCase()));
    const yearOk = !year || !m.year || Math.abs(m.year - year) <= 1;
    if (sim >= 0.9 && authorOk && yearOk) return { ...base, status: "verified" as const, similarity: sim, match: m, note: `Matches a published record ${how}.` };
    // Same title and authors, different year: almost always a reprint or re-registration, not a fake.
    if (sim >= 0.95 && authorOk && author) return { ...base, status: "verified" as const, similarity: sim, match: m, note: `Title and authors match a published record ${how}; it's listed as ${m.year}, likely a later reprint.` };
    const diffs = [sim < 0.9 && "title differs", !authorOk && "first author differs", !yearOk && `year is ${m.year}`].filter(Boolean).join(", ");
    if (sim >= 0.7) return { ...base, status: "likely" as const, similarity: sim, match: m, note: `Close match ${how}, but ${diffs}.` };
    return null;
  };

  try {
    if (doi) {
      const m = await byDoi(doi);
      if (m) {
        const verdict = judge(m, "for this DOI");
        if (verdict) return verdict;
        return { ...base, status: "mismatch" as const, similarity: similarity(m), match: m, note: `The DOI points to a different work: “${m.title}”.` };
      }
    }
    if (!title) return { ...base, status: "not_found" as const, note: "The DOI doesn't resolve and there's no title to search." };
    // Titles repeat (reprints, workshop versions, other papers), so judge every
    // candidate and keep the best verdict; ask OpenAlex too when Crossref has no
    // verified match (conference and arXiv papers are often missing there).
    const rank = { verified: 0, likely: 1 } as const;
    const bestOf = (cands: CitationMatch[]) => cands
      .map((m) => judge(m, `on ${m.source === "crossref" ? "Crossref" : "OpenAlex"}`))
      .filter((v): v is NonNullable<typeof v> => !!v)
      .sort((x, y) => rank[x.status] - rank[y.status] || (y.similarity ?? 0) - (x.similarity ?? 0))[0];
    const crossref = await crossrefSearch(title, author);
    let verdict = bestOf(crossref);
    let candidates = crossref;
    if (verdict?.status !== "verified") {
      const openalex = await openAlexSearch(title).catch(() => []);
      candidates = [...crossref, ...openalex];
      verdict = bestOf(candidates);
    }
    const best = candidates.map((m) => ({ m, sim: titleSimilarity(title, m.title) })).sort((a, b) => b.sim - a.sim)[0];
    if (verdict) {
      if (doi) return { ...verdict, status: "mismatch" as const, note: `The DOI doesn't resolve; the paper exists with DOI ${verdict.match?.doi ?? "unknown"}.` };
      return verdict;
    }
    return { ...base, status: "not_found" as const, similarity: best?.sim, match: best?.m, note: "No published work matches this title. Check it isn't misremembered or made up." };
  } catch (err) {
    return { ...base, status: "error" as const, note: `Lookup failed (${(err as Error).message}). Try again.` };
  }
}

/** Entries of a hand-written `thebibliography` (`\bibitem{key} Authors, ``Title,'' …`). */
export function parseBibitems(text: string) {
  const out: { key: string; line: number; fields: Record<string, string> }[] = [];
  const re = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  const starts = [...text.matchAll(re)];
  starts.forEach((m, i) => {
    const end = starts[i + 1]?.index ?? text.search(/\\end\{thebibliography\}/);
    const body = text.slice(m.index! + m[0].length, end > m.index! ? end : undefined).replace(/%.*$/gm, "").replace(/\s+/g, " ").trim();
    const fields: Record<string, string> = {};
    const title = body.match(/``(.+?)''/) ?? body.match(/"(.+?)"/);
    if (title) {
      fields.title = title[1].replace(/[,.]\s*$/, "").trim();
      // IEEE style lists "A. One, B. Two, and C. Three" or "A. One et al."; keep the first author.
      const first = body.slice(0, title.index).split(/,|\s+and\s+/)[0].replace(/\\textit\{\s*et al\.?\s*\}|\bet al\.?/g, "").trim();
      if (first) fields.author = first;
      const venue = body.slice(title.index! + title[0].length).match(/\\(?:textit|emph)\{([^}]+)\}/);
      if (venue) fields.journal = venue[1].trim();
    }
    const doi = body.match(/doi:?\s*(10\.\d{4,9}\/[^\s,;}]+)/i);
    if (doi) fields.doi = doi[1].replace(/\.$/, "");
    const years = body.replace(/doi:?\s*\S+/gi, "").match(/\b(19|20)\d{2}\b/g);
    if (years) fields.year = years[years.length - 1];
    out.push({ key: m[1].trim(), line: text.slice(0, m.index).split("\n").length, fields });
  });
  return out;
}

export async function checkCitations(projectId: string): Promise<CitationReport> {
  const files = await textFiles(projectId);
  const contents = new Map(await Promise.all(files.map(async (f) => [f.path, (await textOf(projectId, f.path)) ?? ""] as const)));
  const cited = new Map<string, { file: string; line: number }>();
  for (const [file, text] of contents) {
    if (!file.endsWith(".tex")) continue;
    for (const { key, line } of citedKeys(text)) if (!cited.has(key)) cited.set(key, { file, line });
  }

  const entries: { key: string; file: string; line: number; fields: Record<string, string> }[] = [];
  for (const [file, text] of contents) {
    if (file.endsWith(".bib")) for (const e of parseBibtex(text)) entries.push({ key: e.key, file, line: e.line, fields: e.fields });
    else if (file.endsWith(".tex") && text.includes("\\bibitem")) for (const e of parseBibitems(text)) entries.push({ ...e, file });
  }

  // A few lookups at a time; be polite to the public APIs.
  const results: CitationCheck[] = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      const cacheKey = JSON.stringify([e.fields.title, e.fields.doi, e.fields.author, e.fields.year]);
      if (!cache.has(cacheKey)) cache.set(cacheKey, check(e.fields));
      const r = await cache.get(cacheKey)!;
      if (r.status === "error") cache.delete(cacheKey);
      results[i] = { key: e.key, file: e.file, line: e.line, cited: cited.has(e.key), ...r };
    }
  }));

  const known = new Set(entries.map((e) => e.key));
  const missing = [...cited].filter(([k]) => !known.has(k)).map(([key, loc]) => ({ key, ...loc }));
  return { checkedAt: new Date().toISOString(), entries: results, missing };
}

/** Fetch BibTeX for a DOI and append it to a .bib file through the live document. */
/** BibTeX for a DOI, from the DOI resolver. */
export async function fetchDoiBibtex(rawDoi: string) {
  const doi = rawDoi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/i, "").trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error("That doesn't look like a DOI (e.g. 10.1145/3292500.3330701)");
  const res = await fetch(`${DOI_RESOLVER}/${doi}`, { headers: { accept: "application/x-bibtex", "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (!res?.ok) throw new Error(res?.status === 404 ? `DOI not found: ${doi}` : `Couldn't fetch metadata for ${doi}`);
  const bib = (await res.text()).trim();
  const [entry] = parseBibtex(bib);
  if (!entry) throw new Error("The DOI service returned no BibTeX");
  if (!entry.fields.doi) entry.fields.doi = doi;
  return { doi, bib, entry };
}

export async function addByDoi(projectId: string, session: Session, rawDoi: string, bibPath?: string) {
  const fetched = await fetchDoiBibtex(rawDoi);
  const { doi, entry } = fetched;
  let { bib } = fetched;

  const bibs = (await textFiles(projectId)).filter((f) => f.path.endsWith(".bib")).map((f) => f.path);
  const target = bibPath ?? bibs[0] ?? "refs/references.bib";
  const current = (await textOf(projectId, target)) ?? "";
  const existing = parseBibtex(current);
  if (existing.some((e) => e.fields.doi?.toLowerCase() === doi.toLowerCase())) throw new Error(`Already in ${target}`);

  // Readable, unique key: lastname + year + first title word.
  const base = (firstAuthor(entry.fields.author).replace(/[^a-z]/g, "") || "ref") + (entry.fields.year ?? "") +
    (plainTex(entry.fields.title ?? "").toLowerCase().split(/\s+/).find((w) => w.length > 3 && !["with", "from", "towards", "using"].includes(w))?.replace(/[^a-z0-9]/g, "") ?? "");
  let key = base, n = 2;
  while (existing.some((e) => e.key === key)) key = `${base}${n++}`;
  bib = bib.replace(/^(@\w+\s*\{)\s*[^,]+,/, `$1${key},`).replace(/,\s*(\w+\s*=)/g, ",\n  $1").replace(/\s*\}\s*$/, "\n}");

  const next = `${current.replace(/\s*$/, "")}${current.trim() ? "\n\n" : ""}${bib}\n`;
  if (bibs.includes(target)) await writeThroughCollab(projectId, target, next, session);
  else await writeText(projectId, target, next);
  return { key, file: target, bibtex: bib, type: entry.type, fields: entry.fields };
}
