// Ported from PCS-Web's cheat-sheet editor.
// Obsidian-style "live preview" for CodeMirror 6: the document stays plain
// Markdown, but formatting renders in place and the syntax markers are only
// revealed on lines the cursor touches.
import { EditorSelection, Prec, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder as placeholderExt, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import katex from 'katex';

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-md-math cm-md-math-display' : 'cm-md-math';
    el.innerHTML = katex.renderToString(this.tex, {
      displayMode: this.display,
      throwOnError: false,
    });
    return el;
  }

  // Let clicks through so the editor moves the cursor here, revealing the source.
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-checkbox';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // TaskMarker is "[ ]" / "[x]"; the state character sits at pos + 1.
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-md-bullet';
    el.textContent = '•';
    return el;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-md-hr';
    return el;
  }
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

const hidden = Decoration.replace({});
const markClass: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  Link: 'cm-md-link',
};
const hiddenMarks = new Set(['EmphasisMark', 'StrikethroughMark', 'LinkMark', 'URL', 'LinkTitle']);
const codeNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);

// $$…$$ (may span lines) or $…$ on a single line, matching remark-math.
const MATH_RE = /\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])([^\n$]+?)(?<!\s)\$(?!\d)/g;

function selectionTouches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(r => r.from <= to && r.to >= from);
}

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  // Lines touched by any selection range show raw Markdown.
  const activeLines = new Set();
  for (const r of state.selection.ranges) {
    const last = doc.lineAt(r.to).number;
    for (let n = doc.lineAt(r.from).number; n <= last; n++) activeLines.add(n);
  }
  const isActive = (pos: number) => activeLines.has(doc.lineAt(pos).number);

  // Code spans/blocks, so we don't look for math inside them.
  const codeRanges: [number, number][] = [];
  tree.iterate({
    enter(node) {
      if (codeNodes.has(node.name)) {
        codeRanges.push([node.from, node.to]);
        return false;
      }
    },
  });
  const inCode = (from: number, to: number) => codeRanges.some(([a, b]) => from < b && to > a);

  // Math first: tree decorations inside a math range are skipped, since the
  // Markdown parser knows nothing about $ and may see emphasis in `$a*b*c$`.
  const mathRanges: [number, number][] = [];
  const text = doc.toString();
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (inCode(from, to)) continue;
    mathRanges.push([from, to]);
    if (selectionTouches(state, from, to)) continue;

    const display = m[1] !== undefined;
    const tex = (display ? m[1] : m[2]).trim();
    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to);
    if (startLine.number !== endLine.number) {
      // Multi-line $$ blocks can only be replaced whole-line (block widget).
      if (from === startLine.from && to === endLine.to) {
        decos.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(from, to));
      }
    } else {
      decos.push(Decoration.replace({ widget: new MathWidget(tex, display) }).range(from, to));
    }
  }
  const inMath = (from: number, to: number) => mathRanges.some(([a, b]) => from >= a && to <= b);

  const lineDeco = (from: number, to: number, cls: string) => {
    const last = doc.lineAt(to).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) {
      decos.push(Decoration.line({ class: cls }).range(doc.line(n).from));
    }
  };

  // Hide a marker plus the single space after it (e.g. "## ", "> ").
  const hideWithSpace = (from: number, to: number) => {
    const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
    if (end > from) decos.push(hidden.range(from, end));
  };

  tree.iterate({
    enter(node) {
      const { name, from, to } = node;
      if (inMath(from, to)) return false;

      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
      if (heading) {
        lineDeco(from, to, `cm-md-h${heading[1]}`);
        return;
      }

      if (name === 'HeaderMark') {
        const parent = node.node.parent;
        if (parent && parent.name.startsWith('ATX') && !isActive(from)) hideWithSpace(from, to);
        return;
      }

      if (name === 'Blockquote') {
        lineDeco(from, to, 'cm-md-quote');
        return;
      }

      if (name === 'QuoteMark') {
        if (!isActive(from)) hideWithSpace(from, to);
        return;
      }

      if (name === 'FencedCode' || name === 'CodeBlock') {
        lineDeco(from, to, 'cm-md-codeblock');
        return false;
      }

      if (name === 'HorizontalRule') {
        if (!isActive(from)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
        return;
      }

      if (name === 'ListMark') {
        if (isActive(from)) return;
        const item = node.node.parent;
        const isTask = item && item.getChild('Task');
        if (isTask) {
          // The checkbox replaces the bullet, as in Obsidian.
          hideWithSpace(from, to);
        } else if (item && item.parent && item.parent.name === 'BulletList') {
          decos.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
        }
        return;
      }

      if (name === 'TaskMarker') {
        if (isActive(from)) return;
        const checked = /x/i.test(doc.sliceString(from, to));
        decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, from) }).range(from, to));
        if (checked) {
          const line = doc.lineAt(from);
          if (to < line.to) decos.push(Decoration.mark({ class: 'cm-md-done' }).range(to, line.to));
        }
        return;
      }

      if (markClass[name]) {
        decos.push(Decoration.mark({ class: markClass[name] }).range(from, to));
        if (name === 'InlineCode') {
          if (!isActive(from)) {
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'CodeMark') decos.push(hidden.range(c.from, c.to));
            }
          }
          return false;
        }
        return;
      }

      if (hiddenMarks.has(name)) {
        const parent = node.node.parent;
        // Only hide link syntax for inline [text](url) links, not autolinks/images.
        if ((name === 'LinkMark' || name === 'URL' || name === 'LinkTitle') && (!parent || parent.name !== 'Link')) return;
        if (!isActive(from) && to > from) decos.push(hidden.range(from, to));
      }
    },
  });

  return Decoration.set(decos, true);
}

const livePreviewField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Formatting commands (shared by the keymap and the toolbar)
// ---------------------------------------------------------------------------

function runLength(doc: EditorState['doc'], pos: number, ch: string, dir: number) {
  let n = 0;
  while (true) {
    const at = dir < 0 ? pos - n - 1 : pos + n;
    if (at < 0 || at >= doc.length || doc.sliceString(at, at + 1) !== ch) return n;
    n++;
  }
}

// Wrap each selection in before/after, or unwrap it if it's already wrapped.
export function toggleWrap(view: EditorView, before: string, after = before) {
  const { state } = view;
  const doc = state.doc;
  // For repeated-char markers ("*", "**", "~~", "`") look at the whole run so
  // italic on **bold** wraps to ***bold*** instead of stripping one star.
  const repeated = before === after && /^(.)\1*$/.test(before);

  view.dispatch(state.changeByRange(range => {
    const { from, to } = range;
    let wrapped: boolean;
    if (repeated) {
      const ch = before[0];
      const L = before.length;
      const left = runLength(doc, from, ch, -1);
      const right = runLength(doc, to, ch, 1);
      wrapped = left >= L && right >= L && (L !== 1 || left % 2 === 1);
    } else {
      wrapped = doc.sliceString(from - before.length, from) === before &&
        doc.sliceString(to, to + after.length) === after;
    }

    if (wrapped) {
      return {
        changes: [
          { from: from - before.length, to: from },
          { from: to, to: to + after.length },
        ],
        range: EditorSelection.range(from - before.length, to - before.length),
      };
    }
    return {
      changes: [{ from, insert: before }, { from: to, insert: after }],
      range: EditorSelection.range(from + before.length, to + before.length),
    };
  }));
  view.focus();
  return true;
}

const LINE_PREFIX_RE = /^(#{1,6} |> |[-*+] \[[ xX]\] |[-*+] |\d+\. )/;
// Leading indentation, kept when a prefix is toggled on a nested list line.
const INDENT_RE = /^[ \t]*/;

function prefixMatcher(prefix: string): (line: string) => boolean {
  if (/^#{1,6} $/.test(prefix)) return (line) => line.startsWith(prefix);
  if (prefix === '1. ') return (line) => /^\d+\. /.test(line);
  if (prefix === '- ') return (line) => /^[-*+] /.test(line) && !/^[-*+] \[[ xX]\] /.test(line);
  if (prefix === '- [ ] ') return (line) => /^[-*+] \[[ xX]\] /.test(line);
  return (line) => line.startsWith(prefix);
}

// Toggle a block prefix (heading, quote, list) on every selected line. An
// existing different prefix is swapped, so H1 -> H2 or bullets -> numbers.
export function prefixLines(view: EditorView, prefix: string) {
  const { state } = view;
  const doc = state.doc;
  const lines: number[] = [];
  for (const r of state.selection.ranges) {
    const last = doc.lineAt(r.to).number;
    for (let n = doc.lineAt(r.from).number; n <= last; n++) {
      if (!lines.includes(n)) lines.push(n);
    }
  }
  const matcher = prefixMatcher(prefix);
  const matches = (text: string) => matcher(text.replace(INDENT_RE, ''));
  const targets = lines.map(n => doc.line(n)).filter(l => l.text.trim() !== '' || lines.length === 1);
  const removing = targets.length > 0 && targets.every(l => matches(l.text));

  const changes = targets.map((line, i) => {
    const start = line.from + INDENT_RE.exec(line.text)![0].length;
    const existing = LINE_PREFIX_RE.exec(line.text.slice(start - line.from));
    const existingLen = existing ? existing[0].length : 0;
    if (removing) return { from: start, to: start + existingLen };
    const insert = prefix === '1. ' ? `${i + 1}. ` : prefix;
    return { from: start, to: start + existingLen, insert };
  });
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
  return true;
}

export function insertText(view: EditorView, text: string) {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
  return true;
}

export function insertLink(view: EditorView) {
  const { state } = view;
  view.dispatch(state.changeByRange(({ from, to }) => {
    const label = state.sliceDoc(from, to);
    const insert = `[${label}](url)`;
    // With a label, select "url" to type over; otherwise put the cursor in [].
    const range = label
      ? EditorSelection.range(from + label.length + 3, from + label.length + 6)
      : EditorSelection.cursor(from + 1);
    return { changes: { from, to, insert }, range };
  }));
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// List nesting: Tab / Shift-Tab on list lines
// ---------------------------------------------------------------------------

// A list line: indentation, marker (-, *, +, 1. or 1)) and the spaces after it.
const LIST_LINE_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/;

const indentWidth = (text: string) => [...text].reduce((w, ch) => w + (ch === '\t' ? 4 - (w % 4) : 1), 0);

function listLine(line: { text: string; number: number; from: number }) {
  const m = LIST_LINE_RE.exec(line.text);
  if (!m) return null;
  const indent = indentWidth(m[1]);
  // Where the item's text starts: a child must be indented at least this far
  // (CommonMark), 2 under "- ", 3 under "1. ".
  return { line, indent, indentLength: m[1].length, contentOffset: indent + m[2].length + indentWidth(m[3]) };
}

function selectedLineNumbers(state: EditorState) {
  const numbers = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

// The nearest list line above `number` whose indent passes `test`, stopping
// at a blank or non-list line (that ends the list).
function listLineAbove(doc: EditorState['doc'], number: number, test: (indent: number) => boolean) {
  for (let n = number - 1; n >= 1; n--) {
    const item = listLine(doc.line(n));
    if (!item) return null;
    if (test(item.indent)) return item;
  }
  return null;
}

// Shifts every selected list line's indentation by the same amount, so a
// selected sub-list keeps its shape. Returns false (Tab then moves focus as
// usual) unless every selected line is a list item.
function shiftListLines(view: EditorView, direction: number) {
  const { state } = view;
  const items = selectedLineNumbers(state).map(n => listLine(state.doc.line(n)));
  if (items.length === 0 || items.some(item => !item)) return false;

  const first = items[0]!;
  let delta = 0;
  if (direction > 0) {
    // Nest under the previous item at the same level, lining up with its text.
    const sibling = listLineAbove(state.doc, first.line.number, indent => indent <= first.indent);
    if (sibling && sibling.indent === first.indent) delta = sibling.contentOffset - first.indent;
  } else if (first.indent > 0) {
    // Back out to the parent's level.
    const parent = listLineAbove(state.doc, first.line.number, indent => indent < first.indent);
    delta = (parent ? parent.indent : 0) - first.indent;
  }
  // Nothing to do (e.g. the first item can't nest), but stay in the editor.
  if (delta === 0) return true;

  const changes = items.map((item) => item!).map(item => ({
    from: item.line.from,
    to: item.line.from + item.indentLength,
    insert: ' '.repeat(Math.max(0, item.indent + delta)),
  }));
  view.dispatch({ changes, scrollIntoView: true, userEvent: direction > 0 ? 'input.indent' : 'delete.dedent' });
  return true;
}

export const indentListItem = (view: EditorView) => shiftListLines(view, 1);
export const outdentListItem = (view: EditorView) => shiftListLines(view, -1);

const formattingKeymap = Prec.high(keymap.of([
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: outdentListItem },
  { key: 'Mod-b', run: view => toggleWrap(view, '**') },
  { key: 'Mod-i', run: view => toggleWrap(view, '*') },
  { key: 'Mod-Shift-x', run: view => toggleWrap(view, '~~') },
  { key: 'Mod-e', run: view => toggleWrap(view, '`') },
  { key: 'Mod-k', run: insertLink },
]));

export function markdownLivePreview({ placeholder }: { placeholder?: string } = {}) {
  return [
    markdown({ extensions: [GFM] }),
    livePreviewField,
    formattingKeymap,
    EditorView.lineWrapping,
    placeholder ? placeholderExt(placeholder) : [],
  ];
}
