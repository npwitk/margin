import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
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
import type { ProjectCollab } from "../lib/collab.ts";

export interface EditorHandle {
  /** Resolve once the server has every local edit. */
  flush(): Promise<void>;
  /** Drop per-file state after rename/delete. */
  forget(path: string): void;
}

interface Props {
  collab: ProjectCollab;
  path: string;
  revealAt?: { line: number; key: number };
  onCompile(): void;
  onForwardSync(path: string, line: number): void;
  onCursor(line: number): void;
  onError(message: string): void;
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
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
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

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef<string | null>(null);
  const undo = useRef(new Map<string, Y.UndoManager>());
  const selections = useRef(new Map<string, EditorSelection>());
  const pendingReveal = useRef<number | null>(null);
  const p = useRef(props);
  p.current = props;

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
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          yCollab(ytext, provider.awareness, { undoManager: um }),
          Prec.highest(keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
            { key: "Mod-Enter", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
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
  }));

  return <div className="editor" ref={host} />;
});
