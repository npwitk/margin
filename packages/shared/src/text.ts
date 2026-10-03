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
