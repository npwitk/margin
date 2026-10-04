import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { seedUpdate } from "./collab.ts";

test("seeding the same file twice doesn't duplicate text when a stale client reconnects", () => {
  const text = "\\\\documentclass{article}\\n\\\\begin{document}\\nHi\\n\\\\end{document}\\n";
  // Server loads the file, a browser syncs it.
  const server1 = new Y.Doc();
  Y.applyUpdate(server1, seedUpdate("p/main.tex", text));
  const browser = new Y.Doc();
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(server1));
  // Server restarts and lost its state: it seeds again from the same file.
  const server2 = new Y.Doc();
  Y.applyUpdate(server2, seedUpdate("p/main.tex", text));
  // The browser reconnects and syncs its copy.
  Y.applyUpdate(server2, Y.encodeStateAsUpdate(browser));
  assert.equal(server2.getText("content").toString(), text);
});

test("the old random seeding did duplicate (regression guard for the reason above)", () => {
  const text = "abc\\n";
  const a = new Y.Doc(); a.getText("content").insert(0, text);
  const b = new Y.Doc(); b.getText("content").insert(0, text);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(b.getText("content").toString(), text + text);
});
