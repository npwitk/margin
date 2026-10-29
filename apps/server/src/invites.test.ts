import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// An invite-only workspace in workspace mode, like a group's own server.
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-invites-"));
process.env.MARGIN_ADMINS = "alice";
const storage = await import("./storage.ts");
const access = await import("./access.ts");
const workspace = await import("./workspace.ts");

const alice = { name: "Alice", github: "alice" };
const lee = { name: "Prof. Lee", github: "lee" };

test("an admin's advisor link lets a newcomer in as a guest who sees only that paper", async () => {
  const paper = await storage.createProject("Paper", "article", "Alice");
  const other = await storage.createProject("Other", "article", "Alice");
  await access.addOwner(paper.id, alice);
  await access.addOwner(other.id, alice);

  const link = await access.createInvite(paper.id, alice, "advisor", true);
  assert.equal(await workspace.isActiveMember(lee), false);
  // What GitHub sign-in does with a project link when there's no workspace invite.
  const admitting = await access.admittingInvite(paper.id, link.token);
  assert.ok(admitting);
  await workspace.admitGuest({ login: "lee", name: "Prof. Lee" }, admitting.createdBy);
  await access.joinWithInvite(paper.id, lee, link.token);

  assert.equal(await workspace.isActiveMember(lee), true);
  assert.equal(await workspace.isGuest(lee), true);
  assert.equal(await access.canAccess(paper.id, lee), true);
  assert.equal(await access.canAccess(other.id, lee), false);
  assert.equal(await access.roleOf(paper.id, lee), "advisor");
  assert.equal(await access.roleOf(other.id, lee), null);

  // A plain owner's link (not an admin's) doesn't let anyone into the workspace.
  const plain = await access.createInvite(paper.id, alice, "advisor");
  assert.equal(await access.admittingInvite(paper.id, plain.token), null);
});

test("a link's role still applies to someone who opened the paper first", async () => {
  const paper = await storage.createProject("Opened", "article", "Alice");
  await access.addOwner(paper.id, alice);
  const bob = { name: "Bob", github: "bob" };
  await workspace.admit({ login: "bob", name: "Bob" }, (await workspace.createInvite(alice, {})).token);
  await access.getAccess(paper.id, bob); // opened it: counted as an editor
  assert.equal(await access.roleOf(paper.id, bob), "editor");
  const link = await access.createInvite(paper.id, alice, "advisor");
  await access.joinWithInvite(paper.id, bob, link.token);
  assert.equal(await access.roleOf(paper.id, bob), "advisor");
});
