import { useCallback, useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { citeLabels, type CiteCard, type SyncTexForward } from "@margin/shared";
import { CiteCards, type CiteActions } from "./CiteCard.tsx";
import { Icon } from "./Icon.tsx";
import { bindTextLayer } from "../lib/pdfSelection.ts";

GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  url: string | null;
  /** Where to scroll and flash after a forward search. */
  highlight?: SyncTexForward & { key: number };
  /** ⌘/Ctrl-click → source location. Coordinates are PDF points from the page's top-left. */
  onInverse?(page: number, x: number, y: number): void;
  emptyMessage?: string;
  /** A newly loaded PDF is on screen (not re-renders for zoom or resizing). */
  onRendered?(): void;
  /** What each printed citation points to; hovering one shows its card. */
  citations?: CiteCard[];
  citeActions?: CiteActions;
}

/** The text character under a point, if the point really is over text. */
function textAt(x: number, y: number): { node: Text; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | undefined, offset = 0;
  if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); node = p?.offsetNode; offset = p?.offset ?? 0; }
  else if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); node = r?.startContainer; offset = r?.startOffset ?? 0; }
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest(".textLayer")) return null;
  const r = node.parentElement.getBoundingClientRect();
  if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return null;
  return { node: node as Text, offset };
}

/**
 * The citation under the pointer: a numeric group like "[3, 7]" (the one
 * number under the pointer, or the whole group when it's on a bracket or
 * comma), or an author-year citation like "Vaswani et al., 2017".
 */
function citationAt(x: number, y: number, cards: CiteCard[]): { cards: CiteCard[]; rect: DOMRect } | null {
  const hit = textAt(x, y);
  if (!hit) return null;
  const span = hit.node.parentElement!;
  // pdf.js may split "[", "4" and "]" across neighbouring spans.
  const prev = span.previousElementSibling?.tagName === "SPAN" ? span.previousElementSibling.textContent ?? "" : "";
  const next = span.nextElementSibling?.tagName === "SPAN" ? span.nextElementSibling.textContent ?? "" : "";
  const text = prev + (hit.node.textContent ?? "") + next;
  const pos = prev.length + hit.offset;
  const rect = span.getBoundingClientRect();

  for (const p of [pos, pos - 1]) {
    const open = text.lastIndexOf("[", p), shut = text.indexOf("]", p);
    if (open < 0 || shut < 0 || open < p - 40 || shut > p + 40 || text.slice(open, p).includes("]") || text.slice(p, shut).includes("[")) continue;
    let end = shut + 1;
    const more = /^\s*[–—-]\s*\[[^\]]*\]/.exec(text.slice(end));
    if (more) end += more[0].length;
    const group = text.slice(open, end);
    const labels = citeLabels(group);
    // The number under the pointer, if it's on one.
    let a = p, b = p;
    while (a > open && /\d/.test(text[a - 1])) a--;
    while (b < end && /\d/.test(text[b])) b++;
    const one = b > a ? text.slice(a, b) : null;
    const pick = one && labels.includes(one) ? [one] : labels;
    const found = pick.flatMap((l) => cards.filter((c) => c.label === l && !c.authorYear));
    if (found.length) return { cards: found.slice(0, 6), rect };
  }
  for (const c of cards) {
    if (!c.authorYear) continue;
    const name = c.authorYear.split(/[\s,]/)[0], year = /\d{4}[a-z]?/.exec(c.authorYear)?.[0];
    if (!name || !year) continue;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const y = text.indexOf(year, at);
      if (y < 0 || y - at > 60) continue;
      if (pos >= at && pos <= y + year.length) return { cards: [c], rect };
    }
  }
  return null;
}

type Zoom = "fit" | number;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MIN_ZOOM = 0.05, MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function PdfViewer({ url, highlight, onInverse, emptyMessage, onRendered, citations, citeActions }: Props) {
  const [cite, setCite] = useState<{ cards: CiteCard[]; rect: DOMRect } | null>(null);
  const citesRef = useRef(citations);
  citesRef.current = citations;
  const citeKey = useRef("");
  const showTimer = useRef(0), hideTimer = useRef(0);
  const hideCite = (delay = 200) => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { setCite(null); citeKey.current = ""; }, delay);
  };
  const onCiteMove = (e: React.PointerEvent) => {
    const cards = citesRef.current;
    if (!cards?.length || e.buttons) return;
    const hit = citationAt(e.clientX, e.clientY, cards);
    const key = hit ? hit.cards.map((c) => c.key).join() : "";
    if (key === citeKey.current) { if (hit) window.clearTimeout(hideTimer.current); return; }
    citeKey.current = key;
    window.clearTimeout(showTimer.current);
    if (!hit) { hideCite(); return; }
    window.clearTimeout(hideTimer.current);
    showTimer.current = window.setTimeout(() => setCite(hit), 250);
  };
  useEffect(() => () => { window.clearTimeout(showTimer.current); window.clearTimeout(hideTimer.current); }, []);
  useEffect(() => { setCite(null); citeKey.current = ""; }, [citations]);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const shownDoc = useRef<PDFDocumentProxy | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [scale, setScale] = useState(1);
  const renderToken = useRef(0);
  const scaleRef = useRef(1);
  /** Scale the pages are shown at right now (ahead of scaleRef while a pinch is in progress). */
  const liveScale = useRef(1);
  const settle = useRef(0);
  const hovering = useRef(false);
  const [page, setPage] = useState(1);

  // The page in the middle of the view, for the "2 of 9" counter.
  useEffect(() => {
    const scroll = scroller.current;
    if (!scroll) return;
    const onScroll = () => {
      const mid = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
      for (const el of scroll.querySelectorAll<HTMLElement>(".pdf-page")) {
        const r = el.getBoundingClientRect();
        if (r.bottom >= mid) { setPage(Number(el.dataset.page)); return; }
      }
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, []);

  // Load (or reload) the document. Keep showing the old one until the new one is ready.
  useEffect(() => {
    if (!url) { setDoc(null); return; }
    let cancelled = false;
    const task = getDocument({ url, withCredentials: true });
    task.promise.then(
      (d) => { if (!cancelled) { setDoc(d); setError(null); } else void d.destroy(); },
      (err) => { if (!cancelled) setError(String(err?.message ?? err)); },
    );
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => () => { void doc?.destroy(); }, [doc]);

  const render = useCallback(async () => {
    const container = pagesEl.current, scroll = scroller.current;
    if (!container || !scroll) return;
    if (!doc) { container.replaceChildren(); return; }
    const token = ++renderToken.current;
    const first = await doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    // Posters (A0) need far less than 30% to fit the pane.
    const s = zoom === "fit" ? Math.max(0.05, (scroll.clientWidth - 32) / base.width) : zoom;
    const dpr = window.devicePixelRatio || 1;

    const fragment = document.createDocumentFragment();
    const jobs: (() => Promise<void>)[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = n === 1 ? first : await doc.getPage(n);
      if (token !== renderToken.current) return;
      const vp = page.getViewport({ scale: s });
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.dataset.page = String(n);
      wrap.dataset.w = String(vp.width / s);
      wrap.dataset.h = String(vp.height / s);
      wrap.style.width = `${vp.width}px`;
      wrap.style.height = `${vp.height}px`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      wrap.appendChild(canvas);
      // Invisible, selectable text over the canvas, so you can drag-select and copy like normal text.
      const text = document.createElement("div");
      text.className = "textLayer";
      wrap.style.setProperty("--scale-factor", String(s));
      wrap.style.setProperty("--total-scale-factor", String(s));
      wrap.appendChild(text);
      fragment.appendChild(wrap);
      jobs.push(async () => {
        await page.render({ canvas, viewport: page.getViewport({ scale: s * dpr }) }).promise;
        await new TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport: vp }).render().catch(() => {});
        bindTextLayer(text);
      });
    }
    // Render off-screen first so recompiles don't flash a blank pane.
    for (const job of jobs) {
      if (token !== renderToken.current) return;
      await job().catch(() => {});
    }
    if (token !== renderToken.current) return;
    const ratio = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    container.replaceChildren(fragment);
    scroll.scrollTop = ratio * scroll.scrollHeight;
    scaleRef.current = s;
    liveScale.current = s;
    setScale(s);
    if (shownDoc.current !== doc) { shownDoc.current = doc; onRenderedRef.current?.(); }
  }, [doc, zoom]);

  useEffect(() => { void render(); }, [render]);

  // Re-fit when the pane is resized.
  useEffect(() => {
    if (zoom !== "fit" || !scroller.current) return;
    let timer = 0;
    let lastWidth = scroller.current.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = scroller.current?.clientWidth ?? 0;
      if (Math.abs(w - lastWidth) < 8) return;
      lastWidth = w;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void render(), 150);
    });
    ro.observe(scroller.current);
    return () => { ro.disconnect(); window.clearTimeout(timer); };
  }, [zoom, render]);

  // Forward search: scroll to the box and flash it.
  useEffect(() => {
    if (!highlight || !pagesEl.current || !scroller.current) return;
    const wrap = pagesEl.current.querySelector<HTMLDivElement>(`[data-page="${highlight.page}"]`);
    if (!wrap) return;
    const s = scaleRef.current;
    const mark = document.createElement("div");
    mark.className = "pdf-flash";
    Object.assign(mark.style, {
      left: `${Math.max(0, highlight.x * s - 4)}px`,
      top: `${Math.max(0, highlight.y * s - 2)}px`,
      width: `${Math.max(highlight.width, 40) * s + 8}px`,
      height: `${Math.max(highlight.height, 8) * s + 4}px`,
    });
    wrap.appendChild(mark);
    scroller.current.scrollTo({ top: wrap.offsetTop + highlight.y * s - scroller.current.clientHeight / 3, behavior: "smooth" });
    const t = window.setTimeout(() => mark.remove(), 1600);
    return () => { window.clearTimeout(t); mark.remove(); };
  }, [highlight]);

  /**
   * Zoom the pages to `next` right away by resizing them (the canvases stretch
   * until the sharp re-render lands), keeping the point under the pointer still.
   */
  const zoomAt = useCallback((next: number, cx?: number, cy?: number) => {
    const scroll = scroller.current, container = pagesEl.current;
    if (!scroll || !container || !doc) return;
    next = clampZoom(next);
    if (Math.abs(next / liveScale.current - 1) < 0.001) return;
    // Pin the point under the pointer: remember where it sits on its page, resize, then scroll it back.
    const box = scroll.getBoundingClientRect();
    const px = box.left + (cx ?? scroll.clientWidth / 2), py = box.top + (cy ?? scroll.clientHeight / 2);
    const pages = [...container.querySelectorAll<HTMLDivElement>(".pdf-page")];
    const target = pages.find((w) => { const r = w.getBoundingClientRect(); return py >= r.top - 6 && py <= r.bottom + 6; }) ?? pages[0];
    const before = target?.getBoundingClientRect();
    const fx = before ? (px - before.left) / before.width : 0, fy = before ? (py - before.top) / before.height : 0;
    for (const wrap of pages) {
      wrap.style.width = `${Number(wrap.dataset.w) * next}px`;
      wrap.style.height = `${Number(wrap.dataset.h) * next}px`;
      wrap.style.setProperty("--scale-factor", String(next));
      wrap.style.setProperty("--total-scale-factor", String(next));
    }
    liveScale.current = next;
    if (target) {
      const after = target.getBoundingClientRect();
      scroll.scrollLeft += after.left + fx * after.width - px;
      scroll.scrollTop += after.top + fy * after.height - py;
    }
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => setZoom(next), 160);
  }, [doc]);

  // Pinch / ⌘-scroll zooms the PDF, never the whole page. Safari sends gesture events instead of ctrl+wheel.
  useEffect(() => {
    const scroll = scroller.current;
    if (!scroll) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = scroll.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!scroll.contains(e.target as Node)) return;
      // Trackpad pinches send many small deltas; a mouse wheel notch is ~100. Cap each event so both feel smooth.
      const delta = Math.max(-30, Math.min(30, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      zoomAt(liveScale.current * Math.exp(-delta * 0.0075), ...local(e));
    };
    let gestureStart = 1;
    const onGestureStart = (e: Event) => { e.preventDefault(); gestureStart = liveScale.current; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (scroll.contains(e.target as Node)) zoomAt(gestureStart * g.scale, ...local(g));
    };
    const block = (e: Event) => e.preventDefault();
    // On the document so pinching anywhere in the app doesn't zoom the browser page.
    document.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("gesturestart", onGestureStart, { passive: false } as AddEventListenerOptions);
    document.addEventListener("gesturechange", onGestureChange, { passive: false } as AddEventListenerOptions);
    document.addEventListener("gestureend", block, { passive: false } as AddEventListenerOptions);
    // ⌘+ / ⌘− / ⌘0 zoom the PDF while the pointer is over it.
    const onKey = (e: KeyboardEvent) => {
      if (!hovering.current || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomAt(liveScale.current * 1.2); }
      else if (e.key === "-") { e.preventDefault(); zoomAt(liveScale.current / 1.2); }
      else if (e.key === "0") { e.preventDefault(); setZoom("fit"); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", onGestureStart);
      document.removeEventListener("gesturechange", onGestureChange);
      document.removeEventListener("gestureend", block);
      window.removeEventListener("keydown", onKey);
    };
  }, [zoomAt]);

  const onClick = (e: React.MouseEvent) => {
    // ⌘/Ctrl-click jumps to the source; plain clicks and double-clicks select text as usual.
    if (!(e.metaKey || e.ctrlKey) || !onInverse) return;
    const wrap = (e.target as HTMLElement).closest<HTMLDivElement>(".pdf-page");
    if (!wrap) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const s = liveScale.current;
    onInverse(Number(wrap.dataset.page), (e.clientX - rect.left) / s, (e.clientY - rect.top) / s);
  };

  const step = (dir: 1 | -1) => {
    const curr = liveScale.current;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > curr + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < curr - 0.01);
    if (next) zoomAt(next);
  };

  return (
    <div className="pdf">
      <div className="pdf-toolbar" hidden={!doc}>
        <button className="icon-btn" onClick={() => step(-1)} title="Zoom out"><Icon name="minus" size={14} /></button>
        <button className={`pdf-zoom ${zoom === "fit" ? "active" : ""}`} onClick={() => setZoom("fit")} title="Fit to width">
          {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
        </button>
        <button className="icon-btn" onClick={() => step(1)} title="Zoom in"><Icon name="plus" size={14} /></button>
        {doc && <span className="pdf-page-count">{page} of {doc.numPages}</span>}
        {url && <a className="icon-btn" href={url} download title="Download PDF"><Icon name="download" size={14} /></a>}
      </div>
      <div className="pdf-scroll" ref={scroller} onClick={onClick} onPointerMove={citations?.length ? onCiteMove : undefined}
        onScroll={() => { if (cite) { setCite(null); citeKey.current = ""; } }}
        onPointerEnter={() => { hovering.current = true; }} onPointerLeave={() => { hovering.current = false; window.clearTimeout(showTimer.current); citeKey.current = ""; if (cite) hideCite(); }}>
        {!doc && <div className="empty">{error ? `Couldn't load PDF: ${error}` : emptyMessage ?? "No PDF yet"}</div>}
        <div className="pdf-pages" ref={pagesEl} />
      </div>
      {cite && citeActions && (() => {
        const below = cite.rect.bottom + 280 < window.innerHeight;
        const style: React.CSSProperties = {
          left: Math.max(8, Math.min(cite.rect.left, window.innerWidth - 388)),
          ...(below ? { top: cite.rect.bottom + 6 } : { bottom: window.innerHeight - cite.rect.top + 6 }),
        };
        return (
          <div className="cite-popover" style={style} role="dialog" aria-label="Cited paper"
            onPointerEnter={() => window.clearTimeout(hideTimer.current)} onPointerLeave={() => hideCite()}>
            <CiteCards cards={cite.cards} actions={{ ...citeActions, onOpenPdf: (c) => { setCite(null); citeActions.onOpenPdf(c); } }} />
          </div>
        );
      })()}
    </div>
  );
}
