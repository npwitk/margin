/**
 * Minimal single-region diff between two strings: the common prefix and suffix
 * are kept, the middle is replaced. Enough to apply an external file change
 * (git pull, upload, agent write) onto a live CRDT document without
 * clobbering concurrent edits elsewhere in the file.
 */
export function diffRegion(prev: string, next: string): { start: number; deleteCount: number; insert: string } | null {
  if (prev === next) return null;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length, endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { start, deleteCount: endPrev - start, insert: next.slice(start, endNext) };
}

export interface Hunk {
  /** Offsets in the old text. */
  from: number;
  to: number;
  /** Replacement text. */
  insert: string;
}

/**
 * Line-level diff of `a` → `b` as replacement hunks over `a`, so a file-wide
 * change can be shown as several small suggestions. Falls back to a single
 * region for very large inputs.
 */
export function textHunks(a: string, b: string): Hunk[] {
  if (a === b) return [];
  const A = a.split("\n"), B = b.split("\n");
  // Trim common head/tail lines to keep the DP small.
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail), b2 = B.slice(head, B.length - tail);
  const n = a2.length, m = b2.length;

  const offsets: number[] = [0];
  for (const line of A) offsets.push(offsets.at(-1)! + line.length + 1);
  const off = (i: number) => Math.min(offsets[i], a.length);

  if (n * m > 4_000_000) {
    const d = diffRegion(a, b)!;
    return [{ from: d.start, to: d.start + d.deleteCount, insert: d.insert }];
  }
  // LCS table (suffix form).
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { i++; j++; continue; }
    const si = i, sj = j;
    while ((i < n || j < m) && !(i < n && j < m && a2[i] === b2[j])) {
      if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) i++;
      else j++;
    }
    // Lines a2[si..i) become b2[sj..j).
    const lineFrom = head + si, lineTo = head + i;
    const added = b2.slice(sj, j);
    if (lineFrom === lineTo) {
      // Pure insertion before line lineFrom.
      const at = off(lineFrom);
      const atEnd = lineFrom >= A.length;
      hunks.push({ from: atEnd ? a.length : at, to: atEnd ? a.length : at, insert: atEnd ? "\n" + added.join("\n") : added.join("\n") + "\n" });
    } else {
      const from = off(lineFrom);
      // Replace whole lines, excluding the final newline of the last one.
      const to = lineTo >= A.length ? a.length : Math.max(from, off(lineTo) - 1);
      hunks.push({ from, to, insert: added.join("\n") });
      if (!added.length) {
        // Deleting lines: also swallow one newline so no blank line is left.
        const h = hunks[hunks.length - 1];
        if (h.to < a.length) h.to += 1; else if (h.from > 0) h.from -= 1;
      }
    }
  }
  return hunks;
}

/** Apply hunks (from textHunks) to the old text. */
export function applyHunks(a: string, hunks: Hunk[]): string {
  let out = "", pos = 0;
  for (const h of [...hunks].sort((x, y) => x.from - y.from)) {
    out += a.slice(pos, h.from) + h.insert;
    pos = h.to;
  }
  return out + a.slice(pos);
}
