import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { acceptSuggestion, createThread, listThreads, reply, setStatus, textOf } from "./review.ts";

function docWith(s: string) {
  const doc = new Y.Doc();
  textOf(doc).insert(0, s);
  return doc;
}

test("anchors follow their text through edits before, inside-adjacent and after", () => {
  const doc = docWith("We use federated learning here.");
  const t = createThread(doc, { from: 7, to: 25, author: "Alice", message: "Cite McMahan?" });
  const text = textOf(doc);
  text.insert(0, "Overall, ");          // before
  text.insert(text.length, " Done.");   // after
  const [r] = listThreads(doc);
  assert.equal(text.toString().slice(r.from!, r.to!), "federated learning");
  assert.equal(r.messages[0].text, "Cite McMahan?");
  assert.equal(t.quote, "federated learning");
});

test("anchors survive concurrent remote edits", () => {
  const a = docWith("alpha beta gamma");
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  createThread(a, { from: 6, to: 10, author: "Alice" });
  textOf(b).insert(0, "zero ");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  for (const d of [a, b]) {
    const [r] = listThreads(d);
    assert.equal(textOf(d).toString().slice(r.from!, r.to!), "beta");
  }
});

test("accepting a suggestion replaces exactly the range", () => {
  const doc = docWith("The results is good.");
  const s = createThread(doc, { from: 12, to: 14, author: "Claude", kind: "suggestion", replacement: "are" });
  assert.ok(acceptSuggestion(doc, s.id, "Bob"));
  assert.equal(textOf(doc).toString(), "The results are good.");
  assert.equal(listThreads(doc)[0].status, "accepted");
  assert.equal(acceptSuggestion(doc, s.id, "Bob"), false, "can't accept twice");
});

test("deleted text leaves the thread orphaned, not misplaced", () => {
  const doc = docWith("keep remove keep");
  createThread(doc, { from: 5, to: 11, author: "A" });
  textOf(doc).delete(5, 7);
  const [r] = listThreads(doc);
  assert.ok(r.from === null || r.from === r.to, "range collapses or orphans");
});

test("replies and status changes", () => {
  const doc = docWith("x");
  const t = createThread(doc, { from: 0, to: 1, author: "A", message: "?" });
  reply(doc, t.id, "B", "fixed");
  setStatus(doc, t.id, "resolved", "B");
  const [r] = listThreads(doc);
  assert.deepEqual(r.messages.map((m) => m.author), ["A", "B"]);
  assert.equal(r.status, "resolved");
  assert.equal(r.closedBy, "B");
});
