import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle, StreamLanguage, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { CiteOptions } from "@margin/shared";
import type { ProjectCollab } from "../lib/collab.ts";
import { reviewDecorations } from "../lib/review.ts";

export interface EditorHandle {
  /** Resolve once the server has every local edit. */
  flush(): Promise<void>;
  /** Drop per-file state after rename/delete. */
  forget(path: string): void;
  /** The current selection, or null if nothing is selected. */
  selection(): { from: number; to: number; text: string } | null;
  /** Select and scroll to a range. */
  select(from: number, to: number): void;
}

interface Props {
  collab: ProjectCollab;
  path: string;
  revealAt?: { line: number; key: number };
  onCompile(): void;
  onForwardSync(path: string, line: number): void;
  onCursor(line: number): void;
  onComment(): void;
  onThreadClick(id: string): void;
  onError(message: string): void;
  /** References for \cite completion: the paper's own, then the library's. */
  citeOptions?(): Promise<CiteOptions>;
  /** A library reference was picked: put it in the paper; resolves to the key to cite. */
  onLibraryCite?(refId: string, key: string): Promise<string>;
}

const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "var(--syn-command)" },
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.atom, t.bool], color: "var(--syn-atom)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.string, t.special(t.variableName)], color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.bracket, t.squareBracket, t.brace], color: "var(--syn-bracket)" },
  { tag: [t.variableName, t.meta], color: "var(--syn-meta)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px", backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 20px 0 12px" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--text-faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
  // Translucent, so the selection (drawn underneath the text) stays visible on the cursor's line.
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)", borderRadius: "2px" },
  ".cm-selectionLayer .cm-selectionBackground": { borderRadius: "2px" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-foldGutter span": { color: "var(--text-faint)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px" },
  // Teammates' cursors (y-codemirror).
  ".cm-ySelectionInfo": {
    fontFamily: "var(--font)", fontSize: "10.5px", fontWeight: "600", padding: "1px 5px", borderRadius: "4px 4px 4px 0",
    top: "-1.35em", opacity: "1", transitionDelay: "0s",
  },
  ".cm-ySelectionCaret": { borderLeftWidth: "2px" },
});

/** basicSetup minus its history: undo/redo comes from Yjs so it only undoes *your* edits. */
const setup = [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), foldGutter(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
  rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, ...yUndoManagerKeymap, indentWithTab]),
];

const CITE_OPEN = /\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]\n]*\]\s*){0,2}\{[^}\n]*$/;
const PAPER = { name: "In this paper", rank: 0 };
const LIBRARY = { name: "From library", rank: 1 };

/** Completions inside \cite{…}, \citep{…}, \parencite{…} etc. */
function citeCompletions(get: () => Props) {
  return async (ctx: CompletionContext) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    if (!CITE_OPEN.test(line.text.slice(0, ctx.pos - line.from))) return null;
    const word = ctx.matchBefore(/[^{},\s]*/);
    const load = get().citeOptions;
    if (!load || !word) return null;
    let opts: CiteOptions;
    try { opts = await load(); } catch { return null; }
    if (ctx.aborted) return null;
    const short = (s: string) => (s.length > 60 ? `${s.slice(0, 58)}…` : s);
    const options: Completion[] = [
      ...opts.paper.map((o) => ({ label: o.key, detail: short(o.title), info: o.byline || undefined, section: PAPER, type: "text", boost: 1 })),
      ...opts.library.map((o) => ({
        label: o.key, detail: short(o.title), info: o.byline ? `${o.byline} · adds it to this paper` : "Adds it to this paper", section: LIBRARY, type: "text",
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          view.dispatch({ changes: { from, to, insert: o.key }, selection: { anchor: from + o.key.length } });
          const onPick = get().onLibraryCite;
          if (!onPick || !o.refId) return;
          void onPick(o.refId, o.key).then((key) => {
            // The paper may already have this reference under another key.
            if (key === o.key) return;
            const at = view.state.sliceDoc(from, from + o.key.length) === o.key ? from : -1;
            if (at >= 0) view.dispatch({ changes: { from: at, to: at + o.key.length, insert: key } });
          }).catch(() => {});
        },
      })),
    ];
    return { from: word.from, options, validFor: /^[^{},\s]*$/, filter: true };
  };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef<string | null>(null);
  const undo = useRef(new Map<string, Y.UndoManager>());
  const selections = useRef(new Map<string, EditorSelection>());
  const pendingReveal = useRef<number | null>(null);
  const p = useRef(props);
  p.current = props;
  // One stable source: CodeMirror drops pending results when the source's identity changes.
  const [citeData] = useState(() => {
    const data = [{ autocomplete: citeCompletions(() => p.current) }];
    return EditorState.languageData.of(() => data);
  });

  const reveal = (line: number) => {
    const v = view.current;
    if (!v) return;
    const target = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    v.focus();
  };

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const path = props.path;
    (async () => {
      let provider;
      try {
        provider = await props.collab.open(path);
      } catch (err) {
        if (!cancelled) p.current.onError((err as Error).message);
        return;
      }
      if (cancelled || !view.current) return;
      const v = view.current;
      if (current.current) selections.current.set(current.current, v.state.selection);

      const ytext = provider.document.getText("content");
      let um = undo.current.get(path);
      if (!um) {
        um = new Y.UndoManager(ytext);
        undo.current.set(path, um);
      }
      const doc = ytext.toString();
      const saved = selections.current.get(path);
      const selection = saved && saved.main.head <= doc.length ? saved : undefined;

      v.setState(EditorState.create({
        doc,
        selection,
        extensions: [
          setup,
          StreamLanguage.define(stex),
          citeData,
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          yCollab(ytext, provider.awareness, { undoManager: um }),
          reviewDecorations(provider.document, (id) => p.current.onThreadClick(id)),
          Prec.highest(keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
            { key: "Mod-Enter", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
            { key: "Mod-Alt-m", preventDefault: true, run: () => { p.current.onComment(); return true; } },
            {
              key: "Mod-j", preventDefault: true, run: (ev) => {
                p.current.onForwardSync(path, ev.state.doc.lineAt(ev.state.selection.main.head).number);
                return true;
              },
            },
          ])),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) p.current.onCursor(u.state.doc.lineAt(u.state.selection.main.head).number);
          }),
        ],
      }));
      current.current = path;
      if (pendingReveal.current) {
        reveal(pendingReveal.current);
        pendingReveal.current = null;
      } else {
        if (selection) v.dispatch({ effects: EditorView.scrollIntoView(selection.main.head, { y: "center" }) });
        v.focus();
      }
    })();
    return () => { cancelled = true; };
  }, [props.collab, props.path]);

  useEffect(() => {
    if (!props.revealAt) return;
    if (current.current === props.path) reveal(props.revealAt.line);
    else pendingReveal.current = props.revealAt.line;
  }, [props.revealAt]);

  useImperativeHandle(ref, () => ({
    flush: () => p.current.collab.flush(),
    forget(path) {
      undo.current.get(path)?.destroy();
      undo.current.delete(path);
      selections.current.delete(path);
      if (current.current === path) current.current = null;
    },
    selection() {
      const v = view.current;
      const sel = v?.state.selection.main;
      if (!v || !sel || sel.empty) return null;
      return { from: sel.from, to: sel.to, text: v.state.sliceDoc(sel.from, sel.to) };
    },
    select(from, to) {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      v.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) }, effects: EditorView.scrollIntoView(Math.min(from, len), { y: "center" }) });
      v.focus();
    },
  }));

  return <div className="editor" ref={host} />;
});
