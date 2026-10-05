import { useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { insertLink, insertText, markdownLivePreview, prefixLines, toggleWrap } from "../lib/mdLivePreview.ts";
import { renderMarkdown } from "../lib/markdown.ts";

/**
 * Jira-style rich text: rendered Markdown until you click it, then a
 * live-preview Markdown editor (from PCS-Web) with a toolbar. Save with
 * ⌘Enter or the button; Esc cancels.
 */
export function MarkdownField({ value, onSave, placeholder = "Add a description…" }: { value: string; onSave(v: string): void; placeholder?: string }) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return value.trim()
      ? <div className="md task-md" title="Click to edit" dangerouslySetInnerHTML={{ __html: renderMarkdown(value).replace(/<input([^>]*?) disabled=""([^>]*type="checkbox")/g, "<input$1$2") }}
          onClick={(e) => {
            const el = e.target as HTMLElement;
            if (el.closest("a")) return;
            // Checklist boxes tick right here, without opening the editor.
            if (el instanceof HTMLInputElement && el.type === "checkbox") {
              e.preventDefault();
              const boxes = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')];
              onSave(toggleTask(value, boxes.indexOf(el)));
              return;
            }
            setEditing(true);
          }} />
      : <button className="md-placeholder" onClick={() => setEditing(true)}>{placeholder}</button>;
  }
  return <MarkdownEditor initial={value} placeholder={placeholder} onCancel={() => setEditing(false)} onSave={(v) => { onSave(v); setEditing(false); }} />;
}

/** Flip the n-th "- [ ]" / "- [x]" in Markdown source. */
function toggleTask(src: string, n: number) {
  let i = -1;
  return src.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm, (m, a, c, b) => (++i === n ? `${a}${c === " " ? "x" : " "}${b}` : m));
}

type Cmd = (view: EditorView) => unknown;
const TOOLS: (["sep"] | [label: string, title: string, cmd: Cmd])[] = [
  ["B", "Bold (⌘B)", (v) => toggleWrap(v, "**")],
  ["I", "Italic (⌘I)", (v) => toggleWrap(v, "*")],
  ["S", "Strikethrough (⌘⇧X)", (v) => toggleWrap(v, "~~")],
  ["</>", "Code (⌘E)", (v) => toggleWrap(v, "`")],
  ["sep"],
  ["H1", "Heading 1", (v) => prefixLines(v, "# ")],
  ["H2", "Heading 2", (v) => prefixLines(v, "## ")],
  ["H3", "Heading 3", (v) => prefixLines(v, "### ")],
  ["sep"],
  ["•", "Bullet list", (v) => prefixLines(v, "- ")],
  ["1.", "Numbered list", (v) => prefixLines(v, "1. ")],
  ["☑", "Checklist", (v) => prefixLines(v, "- [ ] ")],
  ["❝", "Quote", (v) => prefixLines(v, "> ")],
  ["sep"],
  ["Link", "Link (⌘K)", insertLink],
  ["∑", "Inline math $…$", (v) => toggleWrap(v, "$")],
  ["∑∑", "Display math $$…$$", (v) => toggleWrap(v, "$$\n", "\n$$")],
  ["—", "Divider", (v) => insertText(v, "\n---\n")],
];

export function MarkdownEditor({ initial, placeholder, onSave, onCancel, saveLabel = "Save", compact }: {
  initial: string; placeholder: string; onSave(v: string): void; onCancel(): void; saveLabel?: string; compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onSave, onCancel });
  cb.current = { onSave, onCancel };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          Prec.highest(keymap.of([
            { key: "Mod-Enter", run: (ed) => { const v = ed.state.doc.toString(); if (v.trim() || !compact) cb.current.onSave(v); return true; } },
            { key: "Escape", run: () => { cb.current.onCancel(); return true; } },
          ])),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdownLivePreview({ placeholder }),
          EditorView.contentAttributes.of({ "aria-label": "Description" }),
        ],
      }),
    });
    view.current = v;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    return () => { v.destroy(); view.current = null; };
  }, []);

  const run = (cmd: Cmd) => () => { if (view.current) cmd(view.current); };
  return (
    <div className={`md-edit ${compact ? "compact" : ""}`}>
      <div className="md-toolbar" onMouseDown={(e) => e.preventDefault()}>
        {TOOLS.map((t, i) => t[0] === "sep"
          ? <span key={i} className="md-sep" />
          : <button key={i} type="button" title={t[1]} className={`md-tool md-tool-${i}`} onClick={run(t[2]!)}>{t[0]}</button>)}
      </div>
      <div className="md-frame" ref={host} />
      <div className="md-actions">
        <button className="btn primary tight" onClick={() => { const v = view.current?.state.doc.toString() ?? ""; if (v.trim() || !compact) onSave(v); }}>{saveLabel}</button>
        <button className="btn ghost tight" onClick={onCancel}>Cancel</button>
        <span className="muted small">⌘Enter to {saveLabel.toLowerCase()} · Esc to cancel{compact ? "" : " · Markdown and $math$ supported"}</span>
      </div>
    </div>
  );
}
