import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags as t } from "@lezer/highlight";
import { ApiError, api } from "../lib/api.ts";

export interface EditorHandle {
  /** Persist every file with unsaved edits. Resolves false if any save failed. */
  saveAll(): Promise<boolean>;
  hasUnsaved(): boolean;
  /** Drop cached state for a path (after rename/delete). */
  forget(path: string): void;
}

interface Props {
  projectId: string;
  path: string;
  revealAt?: { line: number; key: number };
  onDirtyChange(path: string, dirty: boolean): void;
  onCompile(): void;
  onForwardSync(path: string, line: number): void;
  onError(message: string): void;
}

interface Doc {
  state: EditorState;
  saved: string;
  etag: string;
  dirty: boolean;
}

const AUTOSAVE_MS = 1200;

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
  ".cm-flash-line": { backgroundColor: "var(--accent-soft)", transition: "background-color 1s" },
});

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const docs = useRef(new Map<string, Doc>());
  const current = useRef<string | null>(null);
  const timers = useRef(new Map<string, number>());
  const pendingReveal = useRef<number | null>(null);
  // Latest props for callbacks captured inside CodeMirror extensions.
  const p = useRef(props);
  p.current = props;

  const save = async (path: string): Promise<boolean> => {
    const doc = docs.current.get(path);
    if (!doc) return true;
    window.clearTimeout(timers.current.get(path));
    const text = doc.state.doc.toString();
    if (text === doc.saved) return true;
    try {
      const { etag } = await api.writeFile(p.current.projectId, path, text, doc.etag);
      doc.saved = text;
      doc.etag = etag;
      setDirty(path, doc.state.doc.toString() !== text);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return resolveConflict(path, doc, text);
      p.current.onError(`Couldn't save ${path}: ${(err as Error).message}`);
      return false;
    }
  };

  const resolveConflict = async (path: string, doc: Doc, mine: string): Promise<boolean> => {
    const keepMine = window.confirm(
      `${path} was changed by someone else since you opened it.\n\nOK — overwrite with your version\nCancel — discard yours and load theirs`,
    );
    if (keepMine) {
      const { etag } = await api.writeFile(p.current.projectId, path, mine);
      doc.saved = mine;
      doc.etag = etag;
      setDirty(path, false);
    } else {
      const fresh = await api.readFile(p.current.projectId, path);
      doc.saved = fresh.content;
      doc.etag = fresh.etag;
      doc.state = doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: fresh.content } }).state;
      if (current.current === path) view.current?.setState(doc.state);
      setDirty(path, false);
    }
    return true;
  };

  const setDirty = (path: string, dirty: boolean) => {
    const doc = docs.current.get(path);
    if (!doc || doc.dirty === dirty) return;
    doc.dirty = dirty;
    p.current.onDirtyChange(path, dirty);
  };

  const extensions = useRef<Extension[]>([
    basicSetup,
    StreamLanguage.define(stex),
    syntaxHighlighting(highlight),
    EditorView.lineWrapping,
    theme,
    Prec.highest(keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
      { key: "Mod-Enter", preventDefault: true, run: () => { p.current.onCompile(); return true; } },
      {
        key: "Mod-j", preventDefault: true, run: (v) => {
          if (current.current) p.current.onForwardSync(current.current, v.state.doc.lineAt(v.state.selection.main.head).number);
          return true;
        },
      },
    ])),
    EditorView.updateListener.of((u) => {
      const path = current.current;
      const doc = path ? docs.current.get(path) : undefined;
      if (!path || !doc) return;
      doc.state = u.state;
      if (!u.docChanged) return;
      setDirty(path, u.state.doc.toString() !== doc.saved);
      window.clearTimeout(timers.current.get(path));
      timers.current.set(path, window.setTimeout(() => void save(path), AUTOSAVE_MS));
    }),
  ]);

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
      for (const path of docs.current.keys()) void save(path);
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap documents when the open file changes.
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      let doc = docs.current.get(props.path);
      if (!doc) {
        try {
          const { content, etag } = await api.readFile(props.projectId, props.path);
          if (cancelled) return;
          doc = { state: EditorState.create({ doc: content, extensions: extensions.current }), saved: content, etag, dirty: false };
          docs.current.set(props.path, doc);
        } catch (err) {
          p.current.onError(`Couldn't open ${props.path}: ${(err as Error).message}`);
          return;
        }
      }
      current.current = props.path;
      view.current!.setState(doc.state);
      if (pendingReveal.current) {
        reveal(pendingReveal.current);
        pendingReveal.current = null;
      } else {
        view.current!.focus();
      }
    };
    void open();
    return () => { cancelled = true; };
  }, [props.projectId, props.path]);

  useEffect(() => {
    if (!props.revealAt) return;
    if (current.current === props.path && docs.current.has(props.path)) reveal(props.revealAt.line);
    else pendingReveal.current = props.revealAt.line;
  }, [props.revealAt]);

  useImperativeHandle(ref, () => ({
    async saveAll() {
      const results = await Promise.all([...docs.current.keys()].map(save));
      return results.every(Boolean);
    },
    hasUnsaved() {
      return [...docs.current.values()].some((d) => d.dirty);
    },
    forget(path) {
      window.clearTimeout(timers.current.get(path));
      docs.current.delete(path);
    },
  }));

  return <div className="editor" ref={host} />;
});
