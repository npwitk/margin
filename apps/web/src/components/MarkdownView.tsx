import { useEffect, useRef, useState } from "react";
import type { ProjectCollab } from "../lib/collab.ts";
import { api } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.ts";

/** Resolve a link in `from` (a project path) to a project path, or null for external/anchor links. */
function resolveLink(from: string, href: string): string | null {
  if (!href || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return null;
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  if (!clean) return null;
  const parts = (clean.startsWith("/") ? [] : from.split("/").slice(0, -1));
  for (const seg of clean.replace(/^\/+/, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Split leading YAML front matter (--- … ---) into simple key/value pairs. */
export function frontMatter(text: string): { meta: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, "$2"); // quoted: keep as is
    else v = v.replace(/\s+#.*$/, "").trim(); // drop "# comment"
    meta.push([kv[1], v]);
  }
  return { meta, body: text.slice(m[0].length) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function metaHtml(meta: [string, string][]): string {
  if (!meta.length) return "";
  const rows = meta.map(([k, v]) => {
    let value = esc(v);
    if (/^doi$/i.test(k) && v) value = `<a href="https://doi.org/${esc(v)}">${esc(v)}</a>`;
    else if (/^https?:\/\//.test(v)) value = `<a href="${esc(v)}">${esc(v)}</a>`;
    else if (/^(pdf|file|source|tex_source|path)$/i.test(k) && v && !v.includes(" ")) value = `<a href="${esc(v)}">${esc(v)}</a>`;
    else if (/^\[.*\]$/.test(v)) value = v.slice(1, -1).split(",").map((t) => t.trim()).filter(Boolean).map((t) => `<span class="md-tag">${esc(t)}</span>`).join(" ");
    return `<tr><th>${esc(k.replace(/_/g, " "))}</th><td>${value}</td></tr>`;
  }).join("");
  return `<table class="md-meta"><tbody>${rows}</tbody></table>`;
}

/**
 * Rendered, live view of a Markdown file (notes, paper summaries, READMEs).
 * Relative images load from the project; links to other files open them.
 */
export function MarkdownView({ collab, projectId, path, onOpen }: { collab: ProjectCollab; projectId: string; path: string; onOpen(path: string): void }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    setHtml(null);
    collab.open(path).then((p) => {
      if (cancelled) return;
      const text = p.document.getText("content");
      let frame = 0;
      const render = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const { meta, body } = frontMatter(text.toString());
          setHtml(metaHtml(meta) + renderMarkdown(body));
        });
      };
      render();
      text.observe(render);
      off = () => { cancelAnimationFrame(frame); text.unobserve(render); };
    }).catch(() => setHtml("<p><em>Couldn't open this file.</em></p>"));
    return () => { cancelled = true; off(); };
  }, [collab, path]);

  // Point relative images at the project's files.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const target = resolveLink(path, img.getAttribute("src") ?? "");
      if (target) img.src = api.rawUrl(projectId, target);
    });
    ref.current?.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      if (!resolveLink(path, a.getAttribute("href") ?? "")) { a.target = "_blank"; a.rel = "noreferrer"; }
    });
  }, [html, path, projectId]);

  return (
    <div className="md-view" onClick={(e) => {
      const a = (e.target as HTMLElement).closest("a");
      const target = a && resolveLink(path, a.getAttribute("href") ?? "");
      if (target) { e.preventDefault(); onOpen(target); }
    }}>
      {html === null ? <div className="empty small">Loading…</div> : <article className="md md-doc" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}
