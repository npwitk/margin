import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./run.ts";

/**
 * The `svg` package (\includesvg) normally runs Inkscape through shell escape,
 * which the sandbox forbids. Instead, convert every .svg beforehand with
 * librsvg into exactly the files the package looks for:
 * svg-inkscape/<name>_svg-tex.pdf and the matching .pdf_tex wrapper. When they
 * exist and are up to date, the package uses them and never calls Inkscape.
 * (Text in the SVG is drawn by librsvg rather than typeset by LaTeX.)
 */

const SKIP_DIRS = new Set(["_out", "svg-inkscape", ".git", ".margin", "node_modules"]);
const MAX_SVGS = 200;

async function findSvgs(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || out.length >= MAX_SVGS) return out;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await findSvgs(abs, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".svg")) out.push(abs);
  }
  return out;
}

/**
 * The .pdf_tex wrapper the svg package \input's. Inkscape's version places the
 * PDF in a picture sized by \svgwidth / \svgscale; this does the same with
 * \includegraphics, so no page size is needed.
 */
function pdfTex(pdfName: string) {
  return `%% Created by Margin (librsvg) for the svg package, in place of Inkscape.
\\begingroup%
  \\ifx\\svgwidth\\undefined%
    \\ifx\\svgscale\\undefined%
      \\includegraphics{${pdfName}}%
    \\else%
      \\includegraphics[scale=\\svgscale]{${pdfName}}%
    \\fi%
  \\else%
    \\includegraphics[width=\\svgwidth]{${pdfName}}%
  \\fi%
  \\global\\let\\svgwidth\\undefined%
  \\global\\let\\svgscale\\undefined%
\\endgroup%
`;
}

export interface SvgResult { converted: number; failed: string[] }

/** Convert the SVGs under `cwd` (the document's folder) for \includesvg. Cheap when nothing changed. */
export async function prepareSvgs(cwd: string): Promise<SvgResult> {
  const result: SvgResult = { converted: 0, failed: [] };
  const svgs = await findSvgs(cwd);
  if (!svgs.length) return result;
  const outDir = path.join(cwd, "svg-inkscape");
  await mkdir(outDir, { recursive: true });
  for (const svg of svgs) {
    const name = path.basename(svg).replace(/\.svg$/i, "");
    const pdfName = `${name}_svg-tex.pdf`;
    const pdf = path.join(outDir, pdfName);
    const tex = `${pdf}_tex`;
    const [src, out, wrapper] = await Promise.all([stat(svg), stat(pdf).catch(() => null), stat(tex).catch(() => null)]);
    if (out && wrapper && out.mtimeMs >= src.mtimeMs) continue;
    const res = await run("rsvg-convert", ["--format=pdf", `--output=${pdf}`, svg], { cwd, timeoutMs: 20_000 }).catch((err: Error) => ({ code: -1, output: err.message, timedOut: false }));
    const made = res.code === 0 && (await stat(pdf).then((st) => st.size > 0, () => false));
    if (!made) { result.failed.push(path.relative(cwd, svg)); continue; }
    await writeFile(tex, pdfTex(pdfName));
    result.converted++;
  }
  return result;
}
