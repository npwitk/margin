import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { conflictBlocks, type ConflictBlock } from "@margin/shared";

/** Plain-language side names: "live edits (Alice, Bob)" → "Alice, Bob's version". */
export function sideName(label: string, fallback: string) {
  const live = /^live edits(?: \((.+)\))?$/.exec(label);
  if (live) return live[1] ? `${live[1]}'s version (live)` : "the live version";
  const pushed = /^pushed by (.+)$/.exec(label);
  if (pushed) return `${pushed[1]}'s version (pushed)`;
  return label ? `${label}'s version` : fallback.toLowerCase();
}

function resolve(view: EditorView, block: ConflictBlock, keep: "ours" | "theirs" | "both") {
  // Re-find the block: the text may have moved since the buttons were drawn.
  const current = conflictBlocks(view.state.doc.toString()).find((b) => b.ours === block.ours && b.theirs === block.theirs) ?? block;
  const text = keep === "ours" ? current.ours : keep === "theirs" ? current.theirs : `${current.ours}${current.theirs}`;
  view.dispatch({ changes: { from: current.from, to: current.to, insert: text }, userEvent: "input.resolve" });
}

class ConflictBar extends WidgetType {
  constructor(readonly block: ConflictBlock, readonly index: number, readonly total: number) { super(); }
  eq(other: ConflictBar) {
    return other.index === this.index && other.total === this.total && other.block.ours === this.block.ours && other.block.theirs === this.block.theirs;
  }
  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-bar";
    const title = document.createElement("span");
    title.className = "cm-conflict-title";
    title.textContent = `Overlapping change${this.total > 1 ? ` ${this.index + 1} of ${this.total}` : ""}: pick what to keep`;
    bar.append(title);
    const ours = sideName(this.block.oursLabel, "First version"), theirs = sideName(this.block.theirsLabel, "Second version");
    for (const [keep, label] of [["ours", `Keep ${ours}`], ["theirs", `Keep ${theirs}`], ["both", "Keep both"]] as const) {
      const b = document.createElement("button");
      b.className = `cm-conflict-btn ${keep}`;
      b.textContent = label;
      b.onmousedown = (e) => { e.preventDefault(); resolve(view, this.block, keep); };
      bar.append(b);
    }
    return bar;
  }
  ignoreEvent() { return true; }
}

/**
 * Shows each conflict block (<<<<<<< … ======= … >>>>>>>) with the two
 * versions tinted and buttons to keep one, the other, or both. Reports the
 * number of blocks left, so the project can stop flagging the file.
 * (Block widgets have to come from a state field, not a view plugin.)
 */
export function conflictMarkers(onCount: (n: number) => void) {
  const build = (state: EditorState) => {
    const text = state.doc.toString();
    const blocks = text.includes("<<<<<<<") ? conflictBlocks(text) : [];
    const ranges: Range<Decoration>[] = [];
    blocks.forEach((block, i) => {
      const start = state.doc.lineAt(block.from);
      ranges.push(Decoration.widget({ widget: new ConflictBar(block, i, blocks.length), side: -1, block: true }).range(start.from));
      // Tint lines: the marker lines, the first version, then the second.
      const sep = block.from + text.slice(block.from, block.to).search(/^={7}$/m);
      for (let pos = block.from; pos < block.to;) {
        const line = state.doc.lineAt(pos);
        const marker = /^(<{7}|={7}|>{7}|\|{7})/.test(line.text);
        ranges.push(Decoration.line({ class: marker ? "cm-conflict-marker" : line.from < sep ? "cm-conflict-ours" : "cm-conflict-theirs" }).range(line.from));
        pos = line.to + 1;
      }
    });
    return { decorations: Decoration.set(ranges, true), count: blocks.length };
  };

  const field = StateField.define<{ decorations: DecorationSet; count: number }>({
    create: (state) => build(state),
    update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  let last = -1;
  const report = (n: number) => { if (n !== last) { last = n; queueMicrotask(() => onCount(n)); } };
  return [
    field,
    ViewPlugin.define((view) => { report(view.state.field(field).count); return { update: (u) => report(u.state.field(field).count) }; }),
  ];
}
