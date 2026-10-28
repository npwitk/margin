import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TEMPLATES, DOCUMENT_TEMPLATES } from "@margin/shared";
import { TEMPLATES_DIR } from "./config.ts";
import { KITS } from "./kits.ts";

test("every gallery template has files, a title slot and a preview", async () => {
  const preview = path.resolve(import.meta.dirname, "../../web/public/templates");
  for (const t of TEMPLATES) {
    const main = await readFile(path.join(TEMPLATES_DIR, t.id, "main.tex"), "utf8");
    assert.match(main, /\\documentclass/, t.id);
    if (!["blank", "cv"].includes(t.id)) assert.ok(main.includes("{{TITLE}}"), `${t.id} has a {{TITLE}} slot`);
    await stat(path.join(preview, `${t.id}.jpg`));
    assert.equal(!!t.kit, !!KITS[t.id], `${t.id}: kit metadata and download agree`);
    if (t.beside) assert.ok(DOCUMENT_TEMPLATES.some((d) => d.id === t.beside), `${t.id}.beside`);
  }
});

test("each venue maps to one template", () => {
  const seen = new Map<string, string>();
  for (const t of TEMPLATES) for (const v of t.venues ?? []) {
    assert.ok(!seen.has(v.toLowerCase()), `${v} is listed under ${seen.get(v.toLowerCase())} and ${t.id}`);
    seen.set(v.toLowerCase(), t.id);
  }
});
