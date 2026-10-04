import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// protocol.ts must stay a types-only copy of the shared definitions.
const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "")
  .replace(/export function[\s\S]*?\n}\n/g, "").replace(/\s+/g, " ").trim();

test("protocol.ts matches packages/shared/src/connect.ts", () => {
  const shared = strip(readFileSync(new URL("../../shared/src/connect.ts", import.meta.url), "utf8"));
  const local = strip(readFileSync(new URL("./protocol.ts", import.meta.url), "utf8"));
  assert.equal(local, shared);
});
