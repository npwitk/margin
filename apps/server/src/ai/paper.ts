import { readFile } from "node:fs/promises";
import path from "node:path";
import { isTextPath } from "@margin/shared";
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
      let target = m[1].trim();
      if (!target.endsWith(".tex")) target += ".tex";
      // LaTeX resolves relative to the main file's directory; also try the including file's.
      const candidates = [...new Set([path.posix.normalize(path.posix.join(mainDir, target)), path.posix.normalize(target), path.posix.normalize(path.posix.join(dir, target))])];
      let inner = "";
      for (const cand of candidates) {
        if (cand.startsWith("..")) continue;
        if ((await textOf(projectId, cand)) !== null) { inner = await expand(cand, depth + 1); break; }
      }
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
