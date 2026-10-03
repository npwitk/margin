import { useEffect, useState } from "react";
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { listThreads, textOf, threadsOf, type ResolvedThread } from "@margin/shared";
import type { ProjectCollab } from "./collab.ts";

class InsertionWidget extends WidgetType {
  constructor(readonly text: string, readonly id: string) { super(); }
  eq(other: InsertionWidget) { return other.text === this.text && other.id === this.id; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-suggest-ins";
    el.dataset.thread = this.id;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return false; }
}

/**
 * Highlights open comments and shows suggestions inline (old text struck
 * through, new text after it). Clicking one reports its thread id.
 */
export function reviewDecorations(doc: Y.Doc, onClick: (id: string) => void) {
  const refresh = StateEffect.define<null>();

  const build = (len: number): DecorationSet => {
    const ranges = [];
    for (const t of listThreads(doc)) {
      if (t.status !== "open" || t.from === null || t.to === null) continue;
      const from = Math.min(t.from, len), to = Math.min(t.to, len);
      const attrs = { "data-thread": t.id };
      if (t.kind === "suggestion") {
        if (to > from) ranges.push(Decoration.mark({ class: "cm-suggest-del", attributes: attrs }).range(from, to));
        if (t.replacement) ranges.push(Decoration.widget({ widget: new InsertionWidget(t.replacement, t.id), side: 1 }).range(to));
      } else if (to > from) {
        ranges.push(Decoration.mark({ class: "cm-comment-mark", attributes: attrs }).range(from, to));
      }
    }
    return Decoration.set(ranges, true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private dead = false;
      private frame = 0;
      private unobserve: () => void;

      constructor(readonly view: EditorView) {
        this.decorations = build(view.state.doc.length);
        const threads = threadsOf(doc);
        const onThreads = () => this.schedule();
        threads.observe(onThreads);
        this.unobserve = () => threads.unobserve(onThreads);
      }

      /** Rebuild after the current update, once Yjs has caught up with CodeMirror. */
      schedule() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => { if (!this.dead) this.view.dispatch({ effects: refresh.of(null) }); });
      }

      update(u: ViewUpdate) {
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) {
          this.decorations = build(u.state.doc.length);
        } else if (u.docChanged) {
          this.decorations = this.decorations.map(u.changes);
          this.schedule();
        }
      }

      destroy() {
        this.dead = true;
        cancelAnimationFrame(this.frame);
        this.unobserve();
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e) {
          const el = (e.target as HTMLElement).closest<HTMLElement>("[data-thread]");
          if (el?.dataset.thread) onClick(el.dataset.thread);
          return false;
        },
      },
    },
  );
}

/** Threads of one file, kept current as threads change and as text moves under them. */
export function useThreads(collab: ProjectCollab | null, path: string | null) {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [threads, setThreads] = useState<ResolvedThread[]>([]);

  useEffect(() => {
    setDoc(null);
    setThreads([]);
    if (!collab || !path) return;
    let cancelled = false;
    let off = () => {};
    collab.open(path).then((p) => {
      if (cancelled) return;
      const d = p.document;
      const update = () => setThreads(listThreads(d));
      let timer = 0;
      const onText = () => { window.clearTimeout(timer); timer = window.setTimeout(update, 300); };
      const map = threadsOf(d), text = textOf(d);
      map.observe(update);
      text.observe(onText);
      off = () => { map.unobserve(update); text.unobserve(onText); window.clearTimeout(timer); };
      setDoc(d);
      update();
    }).catch(() => {});
    return () => { cancelled = true; off(); };
  }, [collab, path]);

  return { doc, threads };
}
