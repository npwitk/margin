/**
 * Table of contents from LaTeX source: \part … \paragraph headings and beamer
 * frames, in document order, with the file and line each one is on. The
 * server walks a document's \input files with `scanOutline` and numbers the
 * result with `numberOutline`, like LaTeX would.
 */

export type OutlineKind = "part" | "chapter" | "section" | "subsection" | "subsubsection" | "paragraph" | "frame";

export interface OutlineEntry {
  kind: OutlineKind;
  /** 0 = part … 5 = paragraph; frames sit at 3 (under beamer sections). */
  level: number;
  /** Display text (LaTeX markup removed, inline $math$ kept). */
  title: string;
  file: string;
  /** 1-based line of the heading command. */
  line: number;
  starred: boolean;
  /** "2.1", "A", "Part II"; absent when LaTeX wouldn't number it. */
  number?: string;
  /** In the appendix. */
  appendix?: boolean;
}

/** What a scan finds, in order: headings, \input-like includes, and \appendix. */
export type OutlineToken =
  | { type: "heading"; entry: OutlineEntry }
  | { type: "include"; target: string; line: number }
  | { type: "appendix"; line: number };

const LEVEL: Record<OutlineKind, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, frame: 3 };

/** The text with comments blanked out (same length, newlines kept), so offsets and lines still match. */
function stripComments(text: string) {
  let out = "";
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") { inComment = false; out += ch; continue; }
    if (inComment) { out += " "; continue; }
    if (ch === "\\") { out += ch + (text[i + 1] ?? ""); i++; if (text[i] === "\n") inComment = false; continue; }
    if (ch === "%") { inComment = true; out += " "; continue; }
    out += ch;
  }
  return out;
}

/** The balanced group starting at `i` (which must be `open`), or null. */
function group(s: string, i: number, open: string, close: string): { body: string; end: number } | null {
  if (s[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < s.length && j < i + 2000; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

const skipSpace = (s: string, i: number) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

/** A heading's display text: commands unwrapped, labels and notes dropped, $math$ kept. */
export function outlineTitle(raw: string): string {
  let s = raw;
  s = s.replace(/\\texorpdfstring\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1");
  s = s.replace(/\\(?:label|footnote|thanks|cite[a-z]*|index|ref|eqref)\*?\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  // Keep math as-is; tidy text outside it.
  const parts = s.split(/(\$[^$]*\$)/);
  s = parts.map((p, i) => {
    if (i % 2) return p;
    let t = p;
    for (let k = 0; k < 6; k++) {
      const next = t.replace(/\\[a-zA-Z]+\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1");
      if (next === t) break;
      t = next;
    }
    return t
      .replace(/\\\\(?:\[[^\]]*\])?/g, " ")
      .replace(/\\([&%#_$])/g, "$1")
      .replace(/\\(?:[a-zA-Z]+)\s?/g, "")
      .replace(/~/g, " ")
      .replace(/[{}]/g, "")
      .replace(/``|''/g, "\"");
  }).join("");
  return s.replace(/\s+/g, " ").trim();
}

/** Headings, includes and \appendix in one file, in order. */
export function scanOutline(text: string, file: string): OutlineToken[] {
  const src = stripComments(text);
  const tokens: OutlineToken[] = [];
  // Line of an offset, without rescanning from the start each time.
  let lineAt = 0, lineNo = 1;
  const lineOf = (pos: number) => {
    for (; lineAt < pos; lineAt++) if (src[lineAt] === "\n") lineNo++;
    return lineNo;
  };
  const re = /\\(part|chapter|section|subsection|subsubsection|paragraph|input|include|subfile|appendix|frametitle|begin\s*\{frame\}|end\s*\{frame\})(?![a-zA-Z])(\*)?/g;
  let openFrame: { at: number; line: number; titled: boolean } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cmd = m[1].replace(/\s+/g, "");
    const line = lineOf(m.index);
    let i = skipSpace(src, m.index + m[0].length);
    if (cmd === "appendix") { tokens.push({ type: "appendix", line }); continue; }
    if (cmd === "input" || cmd === "include" || cmd === "subfile") {
      const g = group(src, i, "{", "}");
      if (g && g.body.trim()) tokens.push({ type: "include", target: g.body.trim(), line });
      continue;
    }
    if (cmd === "end{frame}") {
      openFrame = null;
      continue;
    }
    if (cmd === "begin{frame}") {
      // \begin{frame}<overlay>[options]{Title}{Subtitle}
      if (src[i] === "<") { const g = group(src, i, "<", ">"); if (g) i = skipSpace(src, g.end); }
      if (src[i] === "[") { const g = group(src, i, "[", "]"); if (g) i = skipSpace(src, g.end); }
      const g = group(src, i, "{", "}");
      const title = g ? outlineTitle(g.body) : "";
      openFrame = { at: tokens.length, line, titled: !!title };
      if (title) tokens.push({ type: "heading", entry: { kind: "frame", level: LEVEL.frame, title, file, line, starred: false } });
      continue;
    }
    if (cmd === "frametitle") {
      if (src[i] === "<") { const g = group(src, i, "<", ">"); if (g) i = skipSpace(src, g.end); }
      if (src[i] === "[") { const g = group(src, i, "[", "]"); if (g) i = skipSpace(src, g.end); }
      const g = group(src, i, "{", "}");
      const title = g ? outlineTitle(g.body) : "";
      if (title && openFrame && !openFrame.titled) {
        tokens.splice(openFrame.at, 0, { type: "heading", entry: { kind: "frame", level: LEVEL.frame, title, file, line: openFrame.line, starred: false } });
        openFrame.titled = true;
      } else if (title && !openFrame) {
        tokens.push({ type: "heading", entry: { kind: "frame", level: LEVEL.frame, title, file, line, starred: false } });
      }
      continue;
    }
    // A heading: \section*[short]{Long title}. Skip definitions like \renewcommand{\section}.
    const kind = cmd as OutlineKind;
    let shortTitle: string | null = null;
    if (src[i] === "[") {
      const g = group(src, i, "[", "]");
      if (!g) continue;
      shortTitle = g.body;
      i = skipSpace(src, g.end);
    }
    const g = group(src, i, "{", "}");
    if (!g) continue;
    const title = outlineTitle(g.body) || (shortTitle ? outlineTitle(shortTitle) : "");
    if (!title) continue;
    tokens.push({ type: "heading", entry: { kind, level: LEVEL[kind], title, file, line, starred: !!m[2] } });
  }
  return tokens;
}

/** Headings of a single file (no includes followed). */
export const parseOutline = (text: string, file: string): OutlineEntry[] =>
  numberOutline(scanOutline(text, file));

const ROMAN: [number, string][] = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
const roman = (n: number) => { let s = ""; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const letter = (n: number) => (n <= 26 ? String.fromCharCode(64 + n) : `${n}`);

/**
 * Number headings the way the standard classes do: sections (or chapters,
 * when there are any) count up through the document, deeper levels reset
 * under their parent, starred headings and paragraphs aren't numbered, and
 * after \appendix the top level counts A, B, C.
 */
export function numberOutline(tokens: OutlineToken[]): OutlineEntry[] {
  const headings = tokens.flatMap((t) => (t.type === "heading" ? [t.entry] : []));
  const hasChapters = headings.some((e) => e.kind === "chapter");
  const top = hasChapters ? 1 : 2;
  const counters = [0, 0, 0, 0, 0, 0];
  let appendix = false;
  const out: OutlineEntry[] = [];
  for (const t of tokens) {
    if (t.type === "appendix") { appendix = true; counters[top] = 0; for (let l = top + 1; l < 6; l++) counters[l] = 0; continue; }
    if (t.type !== "heading") continue;
    const e = { ...t.entry, appendix: appendix || undefined };
    if (e.kind === "frame" || e.kind === "paragraph" || e.starred) {
      out.push(e);
      continue;
    }
    if (e.kind === "part") {
      counters[0]++;
      e.number = `Part ${roman(counters[0])}`;
      out.push(e);
      continue;
    }
    counters[e.level]++;
    for (let l = e.level + 1; l < 6; l++) counters[l] = 0;
    const parts: string[] = [];
    for (let l = top; l <= e.level; l++) {
      const n = counters[l];
      parts.push(l === top && appendix ? letter(n) : String(n));
    }
    e.number = parts.join(".");
    out.push(e);
  }
  return out;
}
