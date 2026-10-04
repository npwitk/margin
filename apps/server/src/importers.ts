import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, unzipSync } from "fflate";
import type { Engine } from "@margin/shared";
import { HttpError } from "./storage.ts";

/**
 * Bring existing work into Margin: an Overleaf (or any) .zip, an arXiv
 * paper's LaTeX source, or a public git repository. Archives are treated as
 * hostile: paths are normalised (no zip-slip), sizes are capped, links and
 * system junk are dropped.
 */

export interface ImportedFile { path: string; data: Uint8Array }
export interface Imported { files: ImportedFile[]; mainFile: string; engine: Engine; title?: string }

const MAX_FILES = 3000;
const MAX_TOTAL = 150 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const ARXIV = process.env.ARXIV_URL ?? "https://arxiv.org";
const ARXIV_API = process.env.ARXIV_API_URL ?? "https://export.arxiv.org";
const exec = promisify(execFile);

/** A safe project-relative path, or null to skip the entry. */
export function safePath(name: string): string | null {
  const clean = path.posix.normalize(name.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (!clean || clean === "." || clean.endsWith("/")) return null;
  const parts = clean.split("/");
  if (parts.includes("..")) return null;
  if (parts.some((p) => p === "__MACOSX" || p === ".git" || p === ".margin" || p === ".DS_Store" || p.startsWith("._"))) return null;
  return clean;
}

function check(files: ImportedFile[]) {
  if (!files.length) throw new HttpError(400, "The archive has no files");
  if (files.length > MAX_FILES) throw new HttpError(413, `Too many files (max ${MAX_FILES})`);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_TOTAL) throw new HttpError(413, "Project is too large (max 150 MB)");
}

/** Overleaf zips sometimes wrap everything in one folder; unwrap it. */
function stripCommonRoot(files: ImportedFile[]): ImportedFile[] {
  const firsts = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (firsts.size !== 1 || firsts.has("")) return files;
  const root = [...firsts][0] + "/";
  return files.map((f) => ({ ...f, path: f.path.slice(root.length) }));
}

export function fromZip(buf: Uint8Array): ImportedFile[] {
  let declared = 0;
  let count = 0;
  let entries;
  try {
    entries = unzipSync(buf, {
      filter: (f) => {
        if (!safePath(f.name)) return false;
        if (++count > MAX_FILES) throw new HttpError(413, `Too many files (max ${MAX_FILES})`);
        declared += f.originalSize;
        if (f.originalSize > MAX_FILE || declared > MAX_TOTAL) throw new HttpError(413, "Archive is too large when unpacked (max 150 MB)");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "That isn't a valid .zip file");
  }
  const files = Object.entries(entries).map(([name, data]) => ({ path: safePath(name)!, data }));
  check(files);
  return stripCommonRoot(files);
}

/** Minimal ustar/pax/GNU tar reader (regular files only). */
export function fromTar(buf: Uint8Array): ImportedFile[] {
  const files: ImportedFile[] = [];
  const text = (a: number, b: number) => new TextDecoder().decode(buf.subarray(a, b)).replace(/\0.*$/s, "");
  let off = 0;
  let longName: string | null = null;
  let total = 0;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const size = parseInt(text(off + 124, off + 136).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = text(off + 345, off + 500);
    let name = longName ?? (prefix ? `${prefix}/${text(off, off + 100)}` : text(off, off + 100));
    longName = null;
    const dataStart = off + 512;
    if (!Number.isFinite(size) || size < 0 || dataStart + size > buf.length) throw new HttpError(400, "Corrupt tar archive");
    const data = buf.subarray(dataStart, dataStart + size);
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
      if (m) longName = m[1];
    } else if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0.*$/s, "");
    } else if (type === "0" || type === "\0" || type === "7") {
      const p = safePath(name);
      if (p) {
        if (size > MAX_FILE || (total += size) > MAX_TOTAL) throw new HttpError(413, "Archive is too large (max 150 MB)");
        files.push({ path: p, data: data.slice() });
        if (files.length > MAX_FILES) throw new HttpError(413, `Too many files (max ${MAX_FILES})`);
      }
    }
    // Directories, links (1, 2) and everything else are skipped.
    off = dataStart + Math.ceil(size / 512) * 512;
    void name;
  }
  check(files);
  return stripCommonRoot(files);
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const isTex = (f: ImportedFile) => /\.tex$/i.test(f.path);

/** The root .tex file: has \documentclass and \begin{document}; prefer conventional names, then shallow paths. */
export function detectMain(files: ImportedFile[]): string {
  const candidates = files.filter(isTex).filter((f) => {
    const t = decoder.decode(f.data.subarray(0, 200_000));
    return /^[^%\n]*\\documentclass/m.test(t) && /\\begin\s*\{document\}/.test(t);
  });
  if (!candidates.length) throw new HttpError(400, "No main .tex file found (one with \\documentclass and \\begin{document})");
  const score = (p: string) => (/(^|\/)(main|paper|manuscript|root|ms)\.tex$/i.test(p) ? 0 : 1) * 100 + p.split("/").length * 10 + p.length / 1000;
  return candidates.map((f) => f.path).sort((a, b) => score(a) - score(b))[0];
}

export function detectEngine(files: ImportedFile[], main: string): Engine {
  const text = files.filter(isTex).map((f) => decoder.decode(f.data.subarray(0, 100_000))).join("\n");
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(luacode|luatexja|luaotfload)\b/.test(text) || /% *!TEX +(TS-)?program *= *lualatex/i.test(text)) return "lualatex";
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|xeCJK|polyglossia|unicode-math|fontawesome5)\b/.test(text) || /% *!TEX +(TS-)?program *= *xelatex/i.test(text)) return "xelatex";
  void main;
  return "pdflatex";
}

function finish(files: ImportedFile[], title?: string): Imported {
  const mainFile = detectMain(files);
  return { files, mainFile, engine: detectEngine(files, mainFile), title };
}

export const importZip = (buf: Uint8Array) => finish(fromZip(buf));

// ── arXiv ─────────────────────────────────────────────────────────────────

export function parseArxivId(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf|e-print)\//, "").replace(/\.pdf$/, "").replace(/^arxiv:/i, "");
  return /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/.test(s) ? s : null;
}

export async function importArxiv(input: string): Promise<Imported> {
  const id = parseArxivId(input);
  if (!id) throw new HttpError(400, "That isn't an arXiv ID (e.g. 1706.03762)");
  const res = await fetch(`${ARXIV}/e-print/${id}`, { headers: { "user-agent": "Margin/0.1" }, redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res) throw new HttpError(400, "Couldn't reach arXiv");
  if (res.status === 404) throw new HttpError(404, `arXiv has no paper ${id}`);
  if (!res.ok) throw new HttpError(400, `arXiv returned HTTP ${res.status}`);
  let buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_TOTAL) throw new HttpError(413, "Source is too large");
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) throw new HttpError(400, "This paper has no LaTeX source on arXiv (PDF only)");
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch { throw new HttpError(400, "Couldn't unpack the arXiv source"); }
  }
  const isTar = new TextDecoder().decode(buf.subarray(257, 262)) === "ustar";
  const files = isTar ? fromTar(buf) : [{ path: "main.tex", data: buf }];

  let title: string | undefined;
  const meta = await fetch(`${ARXIV_API}/api/query?id_list=${encodeURIComponent(id.replace(/v\d+$/, ""))}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text()).catch(() => "");
  const m = /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(meta);
  if (m) title = m[1].replace(/\s+/g, " ").trim();
  return finish(files, title ?? `arXiv ${id}`);
}

// ── Git ───────────────────────────────────────────────────────────────────

function isPrivateAddress(ip: string) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Public HTTPS repositories only, so the server can't be used to reach internal hosts. */
export async function checkGitUrl(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(400, "That isn't a URL"); }
  if (url.protocol !== "https:") throw new HttpError(400, "Only https:// repositories can be imported");
  if (url.username || url.password) throw new HttpError(400, "Private repositories aren't supported yet; use a public URL");
  const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, `Couldn't resolve ${url.hostname}`);
  if (!process.env.MARGIN_ALLOW_PRIVATE_GIT && addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "That repository is on a private network");
  return url.toString();
}

export async function importGit(raw: string): Promise<Imported> {
  const url = await checkGitUrl(raw);
  const tmp = await mkdtemp(path.join(tmpdir(), "margin-import-"));
  try {
    await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--depth", "1", "--no-tags", "--single-branch", url, "repo"], {
      cwd: tmp, timeout: 90_000, env: { PATH: process.env.PATH, HOME: tmp, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
    }).catch((err) => { throw new HttpError(400, `Couldn't clone: ${String(err.stderr || err.message).split("\n").find((l: string) => /fatal|error/i.test(l)) ?? "git failed"}`); });
    const root = path.join(tmp, "repo");
    const files: ImportedFile[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (!safePath(rel)) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.isFile()) {
          const size = (await stat(path.join(dir, e.name))).size;
          if (size > MAX_FILE) continue;
          if ((total += size) > MAX_TOTAL) throw new HttpError(413, "Repository is too large (max 150 MB)");
          files.push({ path: rel, data: await readFile(path.join(dir, e.name)) });
          if (files.length > MAX_FILES) throw new HttpError(413, `Too many files (max ${MAX_FILES})`);
        }
      }
    };
    await walk(root, "");
    check(files);
    const name = url.replace(/\.git$/, "").split("/").filter(Boolean).pop();
    return finish(files, name);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
