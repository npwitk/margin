/**
 * A small, forgiving BibTeX reader: enough to list entries, read common
 * fields and find their line numbers. Not a full BibTeX implementation.
 */
export interface BibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
  /** 1-based line where the entry starts. */
  line: number;
  /** Offsets of the whole entry in the source text. */
  start: number;
  end: number;
}

function lineOf(text: string, offset: number) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Read a balanced {...} or "..." value starting at i; returns [value, nextIndex]. */
function readValue(src: string, i: number): [string, number] {
  const open = src[i];
  if (open === "{") {
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    return [src.slice(i + 1, j), j + 1];
  }
  if (open === '"') {
    let depth = 0, j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      else if (src[j] === '"' && depth === 0) break;
    }
    return [src.slice(i + 1, j), j + 1];
  }
  const m = /^[^,}\s]+/.exec(src.slice(i));
  return [m ? m[0] : "", i + (m ? m[0].length : 0)];
}

export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@([a-zA-Z]+)\s*[{(]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string") continue;
    const start = m.index;
    let i = re.lastIndex;
    const keyMatch = /^\s*([^,\s]+)\s*,/.exec(text.slice(i));
    if (!keyMatch) continue;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    const fields: Record<string, string> = {};
    while (i < text.length) {
      const fm = /^\s*([a-zA-Z_][\w-]*)\s*=\s*/.exec(text.slice(i));
      if (!fm) break;
      i += fm[0].length;
      const parts: string[] = [];
      // Values may be concatenated with #.
      for (;;) {
        const [v, next] = readValue(text, i);
        parts.push(v);
        i = next;
        const hash = /^\s*#\s*/.exec(text.slice(i));
        if (!hash) break;
        i += hash[0].length;
      }
      fields[fm[1].toLowerCase()] = parts.join("").replace(/\s+/g, " ").trim();
      const sep = /^\s*,?/.exec(text.slice(i));
      i += sep ? sep[0].length : 0;
    }
    const close = text.slice(i).search(/[})]/);
    const end = close < 0 ? text.length : i + close + 1;
    entries.push({ type, key, fields, line: lineOf(text, start), start, end });
    re.lastIndex = end;
  }
  return entries;
}

/** Strip TeX markup from a field value for display and matching. */
export function plainTex(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every \cite-like key used in a LaTeX source, with its line. */
export function citedKeys(tex: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  const re = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) {
    const before = tex.lastIndexOf("\n", m.index);
    const lineStart = before + 1;
    if (tex.slice(lineStart, m.index).includes("%") && !/\\%/.test(tex.slice(lineStart, m.index))) continue; // commented out
    const line = lineOf(tex, m.index);
    for (const k of m[1].split(",").map((s) => s.trim()).filter(Boolean)) if (k !== "*") out.push({ key: k, line });
  }
  return out;
}

/** Token-set similarity of two titles in [0, 1]. */
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) => plainTex(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}
