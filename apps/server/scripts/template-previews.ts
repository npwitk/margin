/**
 * Compile every gallery template and save its first page as a preview image
 * for the web app (apps/web/public/templates/<id>.jpg). Also a check that
 * every template builds. Needs latexmk and pdftoppm (poppler).
 *
 *   npm run previews -w @margin/server            # all templates
 *   npm run previews -w @margin/server -- neurips  # just some
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
process.env.DATA_DIR ??= await mkdtemp(path.join(tmpdir(), "margin-previews-"));
const { TEMPLATES } = await import("@margin/shared");
const { copyTemplate } = await import("../src/storage.ts");

const OUT = path.resolve(import.meta.dirname, "../../web/public/templates");
const SAMPLE_TITLE = "Private Federated Learning at Scale";
await mkdir(OUT, { recursive: true });

const only = process.argv.slice(2);
const failed: string[] = [];
for (const t of TEMPLATES.filter((x) => !only.length || only.includes(x.id))) {
  const dir = await mkdtemp(path.join(tmpdir(), `tpl-${t.id}-`));
  try {
    await copyTemplate(t.id, dir, SAMPLE_TITLE);
    const engine = t.engine === "xelatex" ? "-xelatex" : t.engine === "lualatex" ? "-lualatex" : "-pdf";
    await run("latexmk", [engine, "-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    const width = t.shape === "slide" ? 640 : t.shape === "poster" ? 640 : 480;
    await run("pdftoppm", ["-jpeg", "-jpegopt", "quality=82", "-f", "1", "-l", "1", "-scale-to-x", String(width), "-scale-to-y", "-1", "-singlefile", "main.pdf", path.join(OUT, t.id)], { cwd: dir });
    console.log(`✓ ${t.id}`);
  } catch (err) {
    failed.push(t.id);
    const e = err as { stdout?: string; message: string };
    const lines = (e.stdout ?? "").split("\n").filter((l) => l.startsWith("!") || /Error/.test(l)).slice(0, 4);
    console.log(`✗ ${t.id}: ${lines.join(" | ") || e.message.slice(0, 300)}`);
  } finally {
    if (!failed.includes(t.id)) await rm(dir, { recursive: true, force: true });
    else console.log(`  kept ${dir}`);
  }
}
if (failed.length) { console.log(`\n${failed.length} failed: ${failed.join(", ")}`); process.exit(1); }
