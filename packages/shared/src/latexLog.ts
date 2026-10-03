import type { Diagnostic } from "./types.ts";

/**
 * Normalise a path from a TeX log into a project-relative path.
 * Returns undefined for files that live outside the project (system packages).
 */
export function toProjectPath(raw: string, workDir?: string): string | undefined {
  let p = raw.trim();
  if (workDir) {
    const prefix = workDir.endsWith("/") ? workDir : workDir + "/";
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/\.\//g, "/");
  if (p.startsWith("/") || p.startsWith("..")) return undefined;
  return p;
}

const FILE_LINE_ERROR = /^(.+?\.(?:tex|sty|cls|bib|bbl|def|cfg|ltx)):(\d+): (.*)$/;
const LATEX_ERROR = /^! (.*)$/;
const LATEX_WARNING = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/;
const BOX_WARNING = /^((?:Over|Under)full \\[hv]box .*?)(?: (?:in paragraph|in alignment|detected) at lines? (\d+)(?:--\d+)?)?$/;
const INPUT_LINE = /on input line (\d+)\.?/;

/**
 * Best-effort parser for TeX/LaTeX logs (written with -file-line-error and a
 * large max_print_line so lines aren't wrapped at 79 columns).
 */
export function parseLatexLog(log: string, workDir?: string): Diagnostic[] {
  const lines = log.split(/\r?\n/);
  const out: Diagnostic[] = [];
  const fileStack: string[] = [];
  const seen = new Set<string>();

  const push = (d: Diagnostic) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  const currentFile = () => {
    for (let i = fileStack.length - 1; i >= 0; i--) {
      const f = toProjectPath(fileStack[i], workDir);
      if (f) return f;
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && /^\s*==> Fatal error/.test(fle[3])) continue; // TeX's summary of the error above
    if (fle) {
      push({
        severity: "error",
        file: toProjectPath(fle[1], workDir) ?? undefined,
        line: Number(fle[2]),
        message: withContext(fle[3], lines, i),
      });
      continue;
    }

    const le = LATEX_ERROR.exec(line);
    if (le && !line.startsWith("! ==>")) {
      // Look ahead for "l.<n>" to recover a line number.
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = /^l\.(\d+)/.exec(lines[j]);
        if (m) { lineNo = Number(m[1]); break; }
      }
      push({ severity: "error", file: currentFile(), line: lineNo, message: withContext(le[1], lines, i) });
      continue;
    }

    const lw = LATEX_WARNING.exec(line);
    if (lw) {
      // Package warnings continue on following lines prefixed with "(pkg)".
      let message = lw[3];
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j]); j++) {
        message += " " + lines[j].replace(/^\(\S+\)\s+/, "");
        i = j;
      }
      const pkg = lw[1] ?? lw[2];
      const m = INPUT_LINE.exec(message);
      push({
        // Shell escape is deliberately off in the sandbox; that's expected, not a problem.
        severity: /Shell escape feature is not enabled/.test(message) ? "info" : "warning",
        file: currentFile(),
        line: m ? Number(m[1]) : undefined,
        message: (pkg ? `[${pkg}] ` : "") + message.replace(/\s+/g, " ").trim(),
      });
      continue;
    }

    const bw = BOX_WARNING.exec(line);
    if (bw) {
      push({ severity: "info", file: currentFile(), line: bw[2] ? Number(bw[2]) : undefined, message: bw[1] });
      continue;
    }

    trackFiles(line, fileStack);
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function withContext(message: string, lines: string[], i: number): string {
  // TeX prints the offending source after "l.<n>"; include it for readability.
  for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
    const m = /^l\.\d+\s?(.*)$/.exec(lines[j]);
    if (m) return m[1].trim() ? `${message} — ${m[1].trim()}` : message;
  }
  return message;
}

/** Maintain a stack of open files from TeX's "(file ... )" notation. */
function trackFiles(line: string, stack: string[]) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") {
      const rest = line.slice(i + 1);
      const m = /^([^\s()]+\.[A-Za-z0-9]+)/.exec(rest);
      if (m && (m[1].startsWith("/") || m[1].startsWith("./") || m[1].includes("/"))) {
        stack.push(m[1]);
        i += m[1].length;
      } else {
        stack.push("");
      }
    } else if (ch === ")") {
      stack.pop();
    }
  }
}
