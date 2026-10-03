export type Engine = "pdflatex" | "xelatex" | "lualatex";

export interface Project {
  id: string;
  name: string;
  mainFile: string;
  engine: Engine;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  /** Project-relative path using forward slashes. */
  path: string;
  type: "file" | "dir";
  size: number;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Project-relative path when the log tells us which file. */
  file?: string;
  line?: number;
}

export interface CompileResult {
  ok: boolean;
  hasPdf: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  log: string;
}

export interface SyncTexForward {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTexInverse {
  file: string;
  line: number;
}

export interface Checkpoint {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface Session {
  name: string;
}

const TEXT_EXTENSIONS = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "def", "cfg", "clo", "ltx",
  "txt", "md", "csv", "tsv", "dat", "json", "yaml", "yml", "toml",
  "py", "r", "m", "jl", "sh", "js", "ts", "gitignore", "latexmkrc",
]);

export function isTextPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : base.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
