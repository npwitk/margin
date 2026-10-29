import { StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import type { AgentActivity } from "@margin/shared";

/** How long an agent's cursor stays after its last action, and how long an edit glows. */
const CURSOR_MS = 2 * 60_000;
const FLASH_MS = 2500;

class AgentCaret extends WidgetType {
  constructor(readonly label: string, readonly status: string) { super(); }
  eq(other: AgentCaret) { return other.label === this.label && other.status === this.status; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-agent-caret";
    el.title = this.status;
    const tag = document.createElement("span");
    tag.className = "cm-agent-tag";
    tag.textContent = this.label;
    el.append(tag);
    return el;
  }
}

/**
 * Where AI agents are working in this file, drawn like a co-author's cursor:
 * a caret with "Claude Code for Alice", and a brief glow over text they just changed.
 */
export function agentCursors(agents: Y.Map<AgentActivity>, path: string) {
  const refresh = StateEffect.define<null>();

  const build = (len: number): DecorationSet => {
    const now = Date.now();
    const ranges = [];
    for (const a of agents.values()) {
      if (a.file !== path || a.from === undefined || now - a.at > CURSOR_MS) continue;
      const from = Math.min(a.from, len), to = Math.min(a.to ?? a.from, len);
      if (a.edited && to > from && now - a.at < FLASH_MS) ranges.push(Decoration.mark({ class: "cm-agent-edit" }).range(from, to));
      ranges.push(Decoration.widget({ widget: new AgentCaret(`${a.agent ?? "Claude"} for ${a.for}`, a.status), side: 1 }).range(to));
    }
    return Decoration.set(ranges, true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private dead = false;
      private frame = 0;
      private timer = 0;
      private unobserve: () => void;

      constructor(readonly view: EditorView) {
        this.decorations = build(view.state.doc.length);
        const onAgents = () => this.schedule();
        agents.observe(onAgents);
        this.unobserve = () => agents.unobserve(onAgents);
        // Fade out glows and stale cursors without waiting for the next change.
        this.timer = window.setInterval(() => this.schedule(), FLASH_MS);
      }

      schedule() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => { if (!this.dead) this.view.dispatch({ effects: refresh.of(null) }); });
      }

      update(u: ViewUpdate) {
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.decorations = build(u.state.doc.length);
        else if (u.docChanged) this.decorations = this.decorations.map(u.changes);
      }

      destroy() {
        this.dead = true;
        cancelAnimationFrame(this.frame);
        window.clearInterval(this.timer);
        this.unobserve();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
