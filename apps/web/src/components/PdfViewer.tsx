import { useCallback, useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { SyncTexForward } from "@margin/shared";
import { Icon } from "./Icon.tsx";

GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  url: string | null;
  /** Where to scroll and flash after a forward search. */
  highlight?: SyncTexForward & { key: number };
  /** Double-click → source location. Coordinates are PDF points from the page's top-left. */
  onInverse?(page: number, x: number, y: number): void;
  emptyMessage?: string;
}

type Zoom = "fit" | number;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PdfViewer({ url, highlight, onInverse, emptyMessage }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [scale, setScale] = useState(1);
  const renderToken = useRef(0);
  const scaleRef = useRef(1);

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
    const s = zoom === "fit" ? Math.max(0.3, (scroll.clientWidth - 32) / base.width) : zoom;
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
        await new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render().catch(() => {});
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
    setScale(s);
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

  const onDoubleClick = (e: React.MouseEvent) => {
    const wrap = (e.target as HTMLElement).closest<HTMLDivElement>(".pdf-page");
    if (!wrap || !onInverse) return;
    const rect = wrap.getBoundingClientRect();
    const s = scaleRef.current;
    onInverse(Number(wrap.dataset.page), (e.clientX - rect.left) / s, (e.clientY - rect.top) / s);
  };

  const step = (dir: 1 | -1) => {
    const curr = zoom === "fit" ? scale : zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > curr + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < curr - 0.01);
    if (next) setZoom(next);
  };

  return (
    <div className="pdf">
      <div className="pdf-toolbar">
        <span className="muted">{doc ? `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}` : ""}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => step(-1)} title="Zoom out" disabled={!doc}><Icon name="minus" size={14} /></button>
        <button className={`chip ${zoom === "fit" ? "active" : ""}`} onClick={() => setZoom("fit")} disabled={!doc}>
          {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
        </button>
        <button className="icon-btn" onClick={() => step(1)} title="Zoom in" disabled={!doc}><Icon name="plus" size={14} /></button>
        {url && <a className="icon-btn" href={url} download title="Download PDF"><Icon name="download" size={14} /></a>}
      </div>
      <div className="pdf-scroll" ref={scroller} onDoubleClick={onDoubleClick}>
        {!doc && <div className="empty">{error ? `Couldn't load PDF: ${error}` : emptyMessage ?? "No PDF yet"}</div>}
        <div className="pdf-pages" ref={pagesEl} />
      </div>
    </div>
  );
}
