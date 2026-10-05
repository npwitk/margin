import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Member, ProjectAccess, Session } from "@margin/shared";
import { ACCESS_MODE, DATA_DIR } from "./config.ts";
import { HttpError, projectDir } from "./storage.ts";

/**
 * Who may open a project. Stored outside the project's git repo (DATA_DIR/access)
 * so pushing files can't change it.
 *
 * In "workspace" mode (a group's own server) everyone signed in can open
 * every project; membership is still recorded. In "members" mode (public
 * sign-ups) only members can, and new people join through invite links.
 */

interface Stored { members: Member[]; invites: { id: string; hash: string; createdBy: string; createdAt: string; expiresAt: string }[] }

const INVITE_DAYS = 14;
const file = (projectId: string) => path.join(DATA_DIR, "access", `${path.basename(projectDir(projectId))}.json`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const memberId = (s: Pick<Session, "name" | "github">) => (s.github ? `gh:${s.github.toLowerCase()}` : `name:${s.name.trim().toLowerCase()}`);

async function load(projectId: string): Promise<Stored> {
  const raw = await readFile(file(projectId), "utf8").catch(() => null);
  return raw ? JSON.parse(raw) : { members: [], invites: [] };
}

async function store(projectId: string, a: Stored) {
  const f = file(projectId);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(`${f}.tmp`, JSON.stringify(a, null, 2));
  await rename(`${f}.tmp`, f);
}

const asMember = (s: Session, role: Member["role"]): Member => ({ id: memberId(s), name: s.name, role, avatar: s.avatar, joinedAt: new Date().toISOString() });

export async function addOwner(projectId: string, s: Session) {
  const a = await load(projectId);
  if (!a.members.some((m) => m.id === memberId(s))) a.members.push(asMember(s, "owner"));
  await store(projectId, a);
}

export async function canAccess(projectId: string, s: Session): Promise<boolean> {
  if (ACCESS_MODE === "workspace") return true;
  const a = await load(projectId);
  // Projects created before members mode was switched on have no members yet, so they stay closed until an admin adds someone.
  return a.members.some((m) => m.id === memberId(s));
}

export async function requireAccess(projectId: string, s: Session) {
  if (!(await canAccess(projectId, s))) throw new HttpError(404, "Project not found");
}

export async function getAccess(projectId: string, s: Session): Promise<ProjectAccess> {
  const a = await load(projectId);
  // In workspace mode anyone who opens a project counts as a member.
  if (ACCESS_MODE === "workspace" && !a.members.some((m) => m.id === memberId(s))) {
    a.members.push(asMember(s, a.members.length ? "editor" : "owner"));
    await store(projectId, a);
  }
  const you = a.members.find((m) => m.id === memberId(s));
  const now = Date.now();
  return {
    mode: ACCESS_MODE,
    members: a.members,
    invites: you?.role === "owner" ? a.invites.filter((i) => Date.parse(i.expiresAt) > now).map(({ hash: _h, ...i }) => i) : [],
    you,
  };
}

async function requireOwner(a: Stored, s: Session) {
  if (a.members.find((m) => m.id === memberId(s))?.role !== "owner") throw new HttpError(400, "Only project owners can do that");
}

export async function createInvite(projectId: string, s: Session) {
  const a = await load(projectId);
  await requireOwner(a, s);
  const token = randomBytes(18).toString("base64url");
  const invite = { id: randomBytes(5).toString("hex"), hash: sha(token), createdBy: s.name, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString() };
  a.invites = [...a.invites.filter((i) => Date.parse(i.expiresAt) > Date.now()), invite];
  await store(projectId, a);
  return { id: invite.id, token, expiresAt: invite.expiresAt };
}

export async function revokeInvite(projectId: string, s: Session, inviteId: string) {
  const a = await load(projectId);
  await requireOwner(a, s);
  a.invites = a.invites.filter((i) => i.id !== inviteId);
  await store(projectId, a);
}

export async function joinWithInvite(projectId: string, s: Session, token: string) {
  const a = await load(projectId);
  if (a.members.some((m) => m.id === memberId(s))) return;
  const h = Buffer.from(sha(token));
  const ok = a.invites.some((i) => Date.parse(i.expiresAt) > Date.now() && timingSafeEqual(Buffer.from(i.hash), h));
  if (!ok) throw new HttpError(404, "This invite link is invalid or has expired");
  a.members.push(asMember(s, "editor"));
  await store(projectId, a);
}

export async function removeMember(projectId: string, s: Session, id: string) {
  const a = await load(projectId);
  const self = id === memberId(s);
  if (!self) await requireOwner(a, s);
  const target = a.members.find((m) => m.id === id);
  if (!target) return null;
  if (target.role === "owner" && a.members.filter((m) => m.role === "owner").length === 1) throw new HttpError(400, "A project needs at least one owner");
  a.members = a.members.filter((m) => m.id !== id);
  await store(projectId, a);
  return target;
}

export async function setRole(projectId: string, s: Session, id: string, role: Member["role"]) {
  const a = await load(projectId);
  await requireOwner(a, s);
  const target = a.members.find((m) => m.id === id);
  if (!target) throw new HttpError(404, "No such member");
  if (target.role === "owner" && role !== "owner" && a.members.filter((m) => m.role === "owner").length === 1) throw new HttpError(400, "A project needs at least one owner");
  target.role = role;
  await store(projectId, a);
}
