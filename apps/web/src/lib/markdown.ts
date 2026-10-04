import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import { marked, type TokenizerAndRendererExtension } from "marked";

/** LaTeX math as KaTeX; a formula KaTeX can't parse shows its source in red instead of breaking the page. */
const tex = (src: string, displayMode: boolean) =>
  katex.renderToString(src, { displayMode, throwOnError: false, strict: "ignore", output: "htmlAndMathml", trust: false, maxExpand: 1000 });

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src) ?? /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/.exec(src);
    if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
  },
  renderer: (t) => `<div class="md-math">${tex(t.text, true)}</div>\n`,
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    // $$…$$ inside a paragraph is display math too.
    let m = /^\$\$([^$]+?)\$\$/.exec(src);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1].trim(), display: true };
    // $…$ like Pandoc: no space just inside the dollars, and no digit right after, so "$5 and $10" stays text.
    m = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: false };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: false };
  },
  renderer: (t) => tex(t.text, !!t.display),
};

marked.use({ gfm: true, breaks: true, extensions: [blockMath, inlineMath] });

/** Render Markdown (with $…$ and $$…$$ math) to sanitized HTML. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
}
