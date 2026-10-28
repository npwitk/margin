import { readFile } from "node:fs/promises";
import path from "node:path";
import { isTextPath, numberOutline, scanOutline, type OutlineEntry, type OutlineToken } from "@margin/shared";
import { liveText } from "../collab.ts";
import { getProject, listFiles, resolvePath } from "../storage.ts";

/** A file as collaborators see it right now (live document first, then disk). */
export async function textOf(projectId: string, rel: string): Promise<string | null> {
  const live = liveText(projectId, rel);
  if (live !== null) return live;
  return readFile(resolvePath(projectId, rel), "utf8").catch(() => null);
}

export async function textFiles(projectId: string) {
  return (await listFiles(projectId)).filter((f) => f.type === "file" && isTextPath(f.path) && f.size < 2_000_000);
}

/** Where `\input{target}` might point: LaTeX resolves from the main file's folder; also try the including file's. */
function includeCandidates(mainDir: string, dir: string, raw: string) {
  let target = raw.trim();
  if (!/\.tex$/i.test(target)) target += ".tex";
  return [...new Set([path.posix.normalize(path.posix.join(mainDir, target)), path.posix.normalize(target), path.posix.normalize(path.posix.join(dir, target))])];
}

async function findInclude(projectId: string, candidates: string[]) {
  for (const cand of candidates) {
    if (cand.startsWith("..")) continue;
    if ((await textOf(projectId, cand)) !== null) return cand;
  }
  return null;
}

/**
 * A document's table of contents: its headings in reading order, following
 * \input/\include into other files, numbered as LaTeX would.
 */
export async function documentOutline(projectId: string, doc: string): Promise<OutlineEntry[]> {
  const mainDir = path.posix.dirname(doc);
  const seen = new Set<string>();
  const tokens: OutlineToken[] = [];
  const walk = async (rel: string, depth: number) => {
    if (seen.has(rel) || depth > 12) return;
    seen.add(rel);
    const src = await textOf(projectId, rel);
    if (src === null) return;
    for (const t of scanOutline(src, rel)) {
      if (t.type !== "include") { tokens.push(t); continue; }
      const found = await findInclude(projectId, includeCandidates(mainDir, path.posix.dirname(rel), t.target));
      if (found) await walk(found, depth + 1);
    }
  };
  await walk(doc, 0);
  return numberOutline(tokens);
}

/**
 * The paper as one document: main file with \input/\include expanded in
 * place, each part marked with the file it came from.
 */
export async function flattenPaper(projectId: string, doc?: string): Promise<{ text: string; files: string[] }> {
  const mainFile = doc || (await getProject(projectId)).mainFile;
  const mainDir = path.posix.dirname(mainFile);
  const seen = new Set<string>();
  const files: string[] = [];

  const expand = async (rel: string, depth: number): Promise<string> => {
    if (seen.has(rel) || depth > 12) return "";
    seen.add(rel);
    const src = await textOf(projectId, rel);
    if (src === null) return `% [missing file: ${rel}]\n`;
    files.push(rel);
    const dir = path.posix.dirname(rel);
    let out = "";
    let last = 0;
    const re = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      if (src.slice(lineStart, m.index).includes("%")) continue;
      const candidates = includeCandidates(mainDir, dir, m[1]);
      const found = await findInclude(projectId, candidates);
      const inner = found ? await expand(found, depth + 1) : "";
      out += src.slice(last, m.index) + `\n%%%%% begin ${candidates[0]}\n${inner}\n%%%%% end ${candidates[0]}\n`;
      last = m.index + m[0].length;
    }
    return out + src.slice(last);
  };

  const text = `%%%%% file ${mainFile}\n${await expand(mainFile, 0)}`;
  return { text, files };
}

/** Find an exact quote somewhere in the project's text files. */
export async function locateQuote(projectId: string, quote: string, prefer: string[] = []) {
  if (!quote.trim()) return null;
  const files = (await textFiles(projectId)).map((f) => f.path);
  const ordered = [...prefer.filter((p) => files.includes(p)), ...files.filter((p) => !prefer.includes(p))];
  for (const file of ordered) {
    const text = await textOf(projectId, file);
    const i = text?.indexOf(quote) ?? -1;
    if (text && i >= 0) return { file, from: i, to: i + quote.length, line: text.slice(0, i).split("\n").length };
  }
  return null;
}
