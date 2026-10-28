import { useMemo, useState } from "react";
import katex from "katex";
import type { OutlineEntry } from "@margin/shared";
import { Icon, Spinner } from "./Icon.tsx";

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);

/** A heading's text with its $math$ typeset. */
export function titleHtml(title: string) {
  return title.split(/(\$[^$]+\$)/).map((part, i) =>
    i % 2 ? katex.renderToString(part.slice(1, -1), { throwOnError: false, strict: "ignore", output: "html", trust: false, maxExpand: 200 }) : escape(part),
  ).join("");
}

/**
 * Which heading the cursor is under: the last heading at or above it in the
 * open file, or, before the file's first heading, whatever came before that.
 */
export function currentEntry(entries: OutlineEntry[], file: string | null, line: number | null): number {
  if (!file || line == null) return -1;
  let first = -1, at = -1;
  entries.forEach((e, i) => {
    if (e.file !== file) return;
    if (first < 0) first = i;
    if (e.line <= line) at = i;
  });
  if (at >= 0) return at;
  return first > 0 ? first - 1 : -1;
}

/**
 * The document's table of contents, like Pages' or Xcode's: numbered,
 * indented headings; click one to go there in the source and the PDF.
 */
export function Outline({ entries, loading, current, docTitle, onPick }: {
  entries: OutlineEntry[] | null;
  loading: boolean;
  current: number;
  docTitle: string;
  onPick(e: OutlineEntry): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const list = entries ?? [];
  const minLevel = useMemo(() => Math.min(...list.map((e) => e.level), 9), [list]);

  // Hide entries under a collapsed heading (until the next heading at its level or above).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return list.map((e, i) => ({ e, i })).filter(({ e }) => `${e.number ?? ""} ${e.title}`.toLowerCase().includes(q));
    const out: { e: OutlineEntry; i: number }[] = [];
    let hideBelow: number | null = null;
    list.forEach((e, i) => {
      if (hideBelow !== null && e.level > hideBelow) return;
      hideBelow = null;
      out.push({ e, i });
      if (collapsed.has(i)) hideBelow = e.level;
    });
    return out;
  }, [list, collapsed, query]);

  const hasChildren = (i: number) => i + 1 < list.length && list[i + 1].level > list[i].level;
  const toggle = (i: number) => setCollapsed((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });

  if (!entries) return <div className="outline-empty">{loading ? <Spinner /> : null}</div>;
  if (!list.length) {
    return (
      <div className="outline-empty">
        <Icon name="outline" size={22} />
        <p>No sections yet</p>
        <span>Headings like <code>\section&#123;…&#125;</code> in {docTitle} appear here.</span>
      </div>
    );
  }
  return (
    <div className="outline">
      {list.length > 12 && (
        <div className="outline-search">
          <Icon name="search" size={13} />
          <input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      <div className="outline-list" role="tree">
        {visible.map(({ e, i }) => (
          <div key={`${e.file}:${e.line}:${i}`} role="treeitem" aria-selected={i === current}
            className={`outline-row k-${e.kind} ${i === current ? "current" : ""}`}
            style={{ paddingLeft: 6 + (e.level - minLevel) * 14 }}>
            {hasChildren(i) && !query
              ? <button className="outline-chev" onClick={() => toggle(i)} aria-label={collapsed.has(i) ? "Expand" : "Collapse"}>
                  <Icon name="chevron" size={10} className={`chev ${collapsed.has(i) ? "" : "open"}`} />
                </button>
              : <span className="outline-chev" />}
            <button className="outline-pick" onClick={() => onPick(e)} title={`${e.file}:${e.line}`}>
              {e.number && <span className="outline-num">{e.number}</span>}
              <span className="outline-title" dangerouslySetInnerHTML={{ __html: titleHtml(e.title) }} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
