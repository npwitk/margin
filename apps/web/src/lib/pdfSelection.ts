/**
 * Native-feeling text selection over pdf.js text layers, ported from pdf.js's
 * TextLayerBuilder. A drag that starts in blank space (a margin, the gap above
 * a line) would otherwise anchor at a random span and select half the page;
 * pdf.js avoids that by moving an invisible "endOfContent" box next to the
 * selection's moving end while you drag.
 */
const layers = new Map<HTMLElement, HTMLElement>();
let installed = false;

export function bindTextLayer(div: HTMLElement) {
  const end = document.createElement("div");
  end.className = "endOfContent";
  div.append(end);
  div.addEventListener("mousedown", (e) => {
    div.classList.add("selecting");
    startBlankDrag(e, div);
  });
  layers.set(div, end);
  install();
  return () => { layers.delete(div); };
}

function reset(end: HTMLElement, layer: HTMLElement) {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  layer.classList.remove("selecting");
}

function install() {
  if (installed) return;
  installed = true;
  let pointerDown = false;
  const resetAll = () => {
    for (const [layer, end] of layers) if (!layer.isConnected) layers.delete(layer); else reset(end, layer);
  };
  document.addEventListener("pointerdown", () => { pointerDown = true; });
  document.addEventListener("pointerup", () => { pointerDown = false; resetAll(); });
  window.addEventListener("blur", () => { pointerDown = false; resetAll(); });
  document.addEventListener("keyup", () => { if (!pointerDown) resetAll(); });

  let firefox: boolean | undefined;
  let prev: Range | null = null;
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) { resetAll(); return; }
    const active = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add("selecting");
      else reset(end, layer);
    }
    if (!active.size) return;
    firefox ??= getComputedStyle([...active][0]).getPropertyValue("-moz-user-select") === "none";
    if (firefox) return;

    const range = selection.getRangeAt(0);
    const modifyStart = !!prev && (range.compareBoundaryPoints(Range.END_TO_END, prev) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prev) === 0);
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0 && anchor) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && !anchor.childNodes.length);
    }
    const parent = (anchor as HTMLElement | null)?.parentElement?.closest<HTMLElement>(".textLayer");
    const end = parent && layers.get(parent);
    if (end && anchor && parent) {
      end.style.width = parent.style.width;
      end.style.height = parent.style.height;
      (anchor as HTMLElement).parentElement!.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prev = range.cloneRange();
  });
}

// ── Drags that start in blank space ─────────────────────────────────────────
// Browsers anchor such a selection somewhere arbitrary. Like a native PDF
// viewer, anchor at the nearest character on that line instead, then follow
// the pointer (snapping to the nearest character while it's over blank space).

type Caret = { node: Node; offset: number };

const textSpans = (layer: Element) =>
  [...layer.querySelectorAll<HTMLElement>("span")].filter((s) => s.firstChild?.nodeType === Node.TEXT_NODE && s.textContent);

function caretFromPoint(x: number, y: number): Caret | null {
  const d = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  const p = d.caretPositionFromPoint?.(x, y);
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** The character position in `layer` nearest to (x, y), preferring the same line. */
function nearestCaret(layer: Element, x: number, y: number): Caret | null {
  let best: { caret: Caret; score: number } | null = null;
  for (const span of textSpans(layer)) {
    const r = span.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const text = span.firstChild!;
    const len = text.textContent!.length;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    // Lines first: any span on this line beats one on another line.
    const score = dy * 1000 + dx;
    if (best && score >= best.score) continue;
    let offset: number;
    if (dy > 0) offset = y < r.top ? 0 : len;
    else if (x <= r.left) offset = 0;
    else if (x >= r.right) offset = len;
    else {
      const c = caretFromPoint(x, y);
      offset = c && c.node === text ? c.offset : Math.round(((x - r.left) / r.width) * len);
    }
    best = { caret: { node: text, offset }, score };
  }
  return best?.caret ?? null;
}

const isText = (t: EventTarget | null) => t instanceof HTMLElement && t.tagName === "SPAN" && !!t.closest(".textLayer");

function startBlankDrag(e: MouseEvent, layer: HTMLElement) {
  if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || isText(e.target)) return;
  const anchor = nearestCaret(layer, e.clientX, e.clientY);
  const selection = document.getSelection();
  if (!anchor || !selection) return;
  e.preventDefault();
  selection.collapse(anchor.node, anchor.offset);
  const move = (ev: MouseEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const overLayer = under?.closest(".textLayer") ?? (under?.closest(".pdf-page")?.querySelector(".textLayer")) ?? layer;
    const focus = isText(under) ? caretFromPoint(ev.clientX, ev.clientY) : nearestCaret(overLayer, ev.clientX, ev.clientY);
    if (focus) selection.extend(focus.node, focus.offset);
  };
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
