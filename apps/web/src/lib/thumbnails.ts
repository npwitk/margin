/**
 * First-page previews of compiled documents, for the projects page. Rendered
 * in the browser with pdf.js (loaded only when needed), two at a time, and
 * cached by project + document + last change, so revisits are instant.
 */

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const CACHE_PREFIX = "thumb:";
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

function readCache(key: string) {
  if (memory.has(key)) return memory.get(key)!;
  try { const v = localStorage.getItem(CACHE_PREFIX + key); if (v) memory.set(key, v); return v; } catch { return null; }
}

function writeCache(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(CACHE_PREFIX + key, value);
  } catch {
    // Full: drop old previews and try once more.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      localStorage.setItem(CACHE_PREFIX + key, value);
    } catch { /* memory only */ }
  }
}

/** Forget older previews of the same project + document (they're superseded). */
function prune(prefix: string, keep: string) {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX + prefix) && k !== CACHE_PREFIX + keep) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/** A PNG data URL of page 1, `width` CSS pixels wide, or null if there's no PDF. */
export function pageThumbnail(url: string, cacheKey: string, prefix: string, width = 360): Promise<string | null> {
  const cached = readCache(cacheKey);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;
  const job = slot(async () => {
    const lib = await loadPdfjs();
    const task = lib.getDocument({ url, withCredentials: true, disableAutoFetch: true });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = (width * Math.min(2, window.devicePixelRatio || 1)) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const data = canvas.toDataURL("image/jpeg", 0.82);
      void doc.destroy();
      writeCache(cacheKey, data);
      prune(prefix, cacheKey);
      return data;
    } catch {
      void task.destroy();
      return null;
    }
  }).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, job);
  return job;
}
