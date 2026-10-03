import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseLatexLog, toProjectPath,
  type CompileResult, type Engine, type SyncTexForward, type SyncTexInverse,
} from "@margin/shared";
import { run } from "./run.ts";

export const OUT_DIR = "_out";
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 90_000);

const ENGINE_FLAG: Record<Engine, string> = { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" };

/**
 * TeX hardening. openin/openout "p" (paranoid) stops \input{/etc/passwd} and
 * writes outside the work dir; shell escape is off so \write18 can't run commands.
 * In production this also runs in a non-root, network-less, read-only container.
 */
function texEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    openin_any: "p",
    openout_any: "p",
    shell_escape: "f",
    max_print_line: "10000",
    error_line: "254",
    half_error_line: "238",
  };
}

const stem = (mainFile: string) => mainFile.replace(/\.tex$/, "");

export function pdfPath(workDir: string, mainFile: string) {
  return path.join(workDir, OUT_DIR, `${path.basename(stem(mainFile))}.pdf`);
}

export async function compile(workDir: string, mainFile: string, engine: Engine): Promise<CompileResult> {
  const started = Date.now();
  const dir = await realpath(workDir);
  const args = [
    ENGINE_FLAG[engine], "-norc", "-synctex=1", "-interaction=nonstopmode", "-file-line-error",
    "-no-shell-escape", `-outdir=${OUT_DIR}`, mainFile,
  ];
  const res = await run("latexmk", args, { cwd: dir, env: texEnv(), timeoutMs: TIMEOUT_MS });

  const logFile = path.join(dir, OUT_DIR, `${path.basename(stem(mainFile))}.log`);
  const texLog = await readFile(logFile, "utf8").catch(() => "");
  const log = texLog ? `${texLog}\n\n——— latexmk ———\n${res.output}` : res.output;
  const diagnostics = parseLatexLog(texLog, dir);
  if (res.timedOut) diagnostics.unshift({ severity: "error", message: `Compile timed out after ${TIMEOUT_MS / 1000}s` });
  if (res.code !== 0 && !diagnostics.some((d) => d.severity === "error")) {
    diagnostics.unshift({ severity: "error", message: lastUsefulLine(res.output) ?? "LaTeX failed — see the raw log" });
  }

  // latexmk skips up-to-date builds, so an older PDF is still the current one.
  const pdfStat = await stat(pdfPath(dir, mainFile)).catch(() => null);
  return {
    ok: res.code === 0 && !res.timedOut,
    hasPdf: !!pdfStat,
    durationMs: Date.now() - started,
    diagnostics,
    log,
  };
}

function lastUsefulLine(output: string) {
  return output.split("\n").map((l) => l.trim()).filter(Boolean).reverse()
    .find((l) => /error|fatal|not found|missing/i.test(l));
}

function field(out: string, name: string): string | undefined {
  return new RegExp(`^${name}:(.*)$`, "m").exec(out)?.[1]?.trim();
}

export async function forwardSearch(workDir: string, mainFile: string, file: string, line: number): Promise<SyncTexForward | null> {
  const dir = await realpath(workDir);
  const pdf = pdfPath(dir, mainFile);
  // SyncTeX may have recorded the input as "./x.tex" or as an absolute path; try both.
  for (const input of [`./${file}`, path.join(dir, file)]) {
    const res = await run("synctex", ["view", "-i", `${line}:0:${input}`, "-o", pdf], { cwd: dir, timeoutMs: 10_000 });
    const page = Number(field(res.output, "Page"));
    if (!page) continue;
    const h = Number(field(res.output, "h")), v = Number(field(res.output, "v"));
    const W = Number(field(res.output, "W")), H = Number(field(res.output, "H"));
    return { page, x: h, y: v - H, width: W, height: H };
  }
  return null;
}

export async function inverseSearch(workDir: string, mainFile: string, page: number, x: number, y: number): Promise<SyncTexInverse | null> {
  const dir = await realpath(workDir);
  const res = await run("synctex", ["edit", "-o", `${page}:${x}:${y}:${pdfPath(dir, mainFile)}`], { cwd: dir, timeoutMs: 10_000 });
  const input = field(res.output, "Input");
  const line = Number(field(res.output, "Line"));
  if (!input || !line) return null;
  const file = toProjectPath(input, dir);
  return file ? { file, line } : null;
}
