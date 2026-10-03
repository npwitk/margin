import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

export interface Command {
  id: string;
  label: string;
  section: string;
  icon?: string;
  hint?: string;
  run(): void;
}

/** Subsequence match with a bonus for consecutive and word-start hits. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase(), t = text.toLowerCase();
  let ti = 0, s = 0, streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    s += 1 + streak * 2 + (found === 0 || "/ -_.".includes(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return s - t.length * 0.01;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const results = useMemo(
    () => commands.map((c) => ({ c, s: score(query, `${c.label} ${c.section}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((r) => r.c),
    [commands, query],
  );

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Type a command or search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(results[index]); }
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="palette-list" ref={list}>
          {results.length === 0 && <div className="empty small">Nothing matches “{query}”</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              data-i={i}
              className={`palette-item ${i === index ? "active" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(c)}
            >
              <Icon name={c.icon ?? "command"} size={14} className="muted" />
              <span className="palette-label">{c.label}</span>
              <span className="palette-section">{c.section}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
