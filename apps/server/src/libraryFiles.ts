import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normDoi, refTitle, type LibraryRef, type PdfLookup } from "@margin/shared";
import { DATA_DIR } from "./config.ts";
import { HttpError } from "./storage.ts";

/**
 * The papers themselves, kept with the library rather than in any project:
 * DATA_DIR/library/<refId>/paper.pdf, its extracted text (paper.txt, pages
 * separated by form feeds) for agents to read and search, and source/ for
 * author LaTeX.
 */

export const LIBRARY_FILES = path.join(DATA_DIR, "library");
export const MAX_PDF = 60 * 1024 * 1024;

const OPENALEX = process.env.OPENALEX_API_URL ?? "https://api.openalex.org";
const ARXIV = process.env.ARXIV_URL ?? "https://arxiv.org";
const UA = "Margin/0.1 (research writing tool)";

const dirOf = (refId: string) => {
  if (!/^[\w-]{1,64}$/.test(refId)) throw new HttpError(400, "Bad reference id");
  return path.join(LIBRARY_FILES, refId);
};
export const pdfFile = (refId: string) => path.join(dirOf(refId), "paper.pdf");
const textFile = (refId: string) => path.join(dirOf(refId), "paper.txt");
export const sourceDir = (refId: string) => path.join(dirOf(refId), "source");

export const isPdf = (buf: Buffer) => buf.subarray(0, 1024).includes("%PDF-");

/** Text of every page, in reading order as far as the PDF allows. */
export async function extractText(data: Buffer): Promise<string[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      // Join words hyphenated across lines; collapse runs of blank lines.
      pages.push(text.replace(/(\w)-\n(\w)/g, "$1$2").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Store a paper's PDF and its text. Returns the page count. */
export async function savePdf(refId: string, data: Buffer): Promise<{ pages: number; size: number }> {
  if (!isPdf(data)) throw new HttpError(400, "That file isn't a PDF");
  if (data.length > MAX_PDF) throw new HttpError(413, "PDFs up to 60 MB");
  const pages = await extractText(data).catch(() => [] as string[]);
  await mkdir(dirOf(refId), { recursive: true });
  await writeFile(pdfFile(refId), data);
  await writeFile(textFile(refId), pages.join("\n\f\n"));
  return { pages: pages.length, size: data.length };
}

export async function removeFiles(refId: string, what: "pdf" | "all") {
  if (what === "all") return rm(dirOf(refId), { recursive: true, force: true });
  await rm(pdfFile(refId), { force: true });
  await rm(textFile(refId), { force: true });
}

export async function readPages(refId: string): Promise<string[] | null> {
  const text = await readFile(textFile(refId), "utf8").catch(() => null);
  if (text === null) return null;
  return text.split("\n\f\n");
}

/** Author source files kept for a reference (paths under source/). */
export async function sourceFiles(refId: string): Promise<string[]> {
  const root = sourceDir(refId);
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return out.sort();
}

export async function saveSource(refId: string, rel: string, data: Buffer) {
  const root = sourceDir(refId);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, "Bad source path");
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function readSource(refId: string, rel: string) {
  const root = sourceDir(refId);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, "Bad source path");
  return readFile(full, "utf8").catch(() => null);
}

export const hasPdfFile = (refId: string) => stat(pdfFile(refId)).then((s) => s.isFile(), () => false);

interface OpenAlexLocation { pdf_url?: string | null; landing_page_url?: string | null; is_oa?: boolean }
interface OpenAlexWork { best_oa_location?: OpenAlexLocation | null; primary_location?: OpenAlexLocation | null; locations?: OpenAlexLocation[]; ids?: { doi?: string } }

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

/** Download a URL if it really is a PDF (not a login page), up to the size cap. */
export async function downloadPdf(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/pdf" }, redirect: "follow", signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!res?.ok || !res.body) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_PDF) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_PDF) return null;
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return isPdf(buf) ? buf : null;
}

/** An arXiv id from the reference's fields: eprint, an arXiv DOI, or an arxiv.org URL. */
export function arxivId(fields: Record<string, string>) {
  const doi = normDoi(fields.doi);
  const fromDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1];
  const fromUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#}]+?)(?:\.pdf)?(?:[?#}]|$)/i.exec(fields.url ?? "")?.[1];
  const eprint = (fields.archiveprefix ?? fields.eprinttype ?? "").toLowerCase() === "arxiv" || /^\d{4}\.\d{4,5}(v\d+)?$/.test(fields.eprint ?? "") ? fields.eprint : undefined;
  return (fromDoi ?? fromUrl ?? eprint)?.trim() || undefined;
}

/** Where a person can get the paper when no free copy turns up. */
function manualLinks(ref: Pick<LibraryRef, "fields">, landing?: string | null) {
  const doi = normDoi(ref.fields.doi);
  const links: PdfLookup["links"] = [];
  if (doi) links.push({ label: "Publisher (via DOI)", url: `https://doi.org/${doi}` });
  if (landing && !links.some((l) => l.url === landing)) links.push({ label: "Publisher page", url: landing });
  if (ref.fields.url && !links.some((l) => l.url === ref.fields.url)) links.push({ label: "Link in the entry", url: ref.fields.url });
  links.push({ label: "Google Scholar", url: `https://scholar.google.com/scholar?${new URLSearchParams({ q: doi || refTitle(ref.fields) })}` });
  return links;
}

/**
 * Look for a free, legal copy: OpenAlex's open-access locations first, then
 * arXiv. Returns the PDF when found; otherwise links and a note on getting it
 * through an institution.
 */
export async function findPdf(ref: Pick<LibraryRef, "fields">): Promise<PdfLookup & { data?: Buffer }> {
  const doi = normDoi(ref.fields.doi);
  let landing: string | null | undefined;
  if (doi) {
    const work = await getJson(`${OPENALEX}/works/doi:${encodeURIComponent(doi)}`) as OpenAlexWork | null;
    landing = work?.primary_location?.landing_page_url;
    const candidates = [work?.best_oa_location, ...(work?.locations ?? [])]
      .filter((l): l is OpenAlexLocation => !!l?.pdf_url)
      .map((l) => l.pdf_url!);
    for (const url of [...new Set(candidates)].slice(0, 4)) {
      const data = await downloadPdf(url);
      if (data) return { found: true, source: "openalex", from: url, links: manualLinks(ref, landing), data };
    }
  }
  const arxiv = arxivId(ref.fields);
  if (arxiv) {
    const url = `${ARXIV}/pdf/${arxiv}`;
    const data = await downloadPdf(url);
    if (data) return { found: true, source: "arxiv", from: url, links: manualLinks(ref, landing), data };
  }
  return {
    found: false,
    links: manualLinks(ref, landing),
    note: doi
      ? "No open-access copy found. Download the PDF through your institution's access (sign in to the publisher via your library), then attach it to this reference."
      : "No DOI or arXiv id to look it up by. Find the PDF yourself, then attach it to this reference.",
  };
}
