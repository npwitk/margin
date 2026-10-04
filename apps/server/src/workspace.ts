import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session, WorkspaceInfo, WorkspaceMember } from "@margin/shared";
import { ADMINS, DATA_DIR, GITHUB, INVITE_ONLY } from "./config.ts";

/**
 * Who belongs to this Margin workspace. With MARGIN_ADMINS set the workspace
 * is invite-only: admins (listed by GitHub login) create invite links, and
 * only members can sign in. Membership is checked on every request, so
 * removing someone takes effect immediately.
 */

interface StoredInvite { id: string; hash: string; createdBy: string; createdAt: string; expiresAt: string; maxUses: number; uses: number }
interface Stored { members: WorkspaceMember[]; invites: StoredInvite[] }

const FILE = path.join(DATA_DIR, "workspace.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let cache: Stored | null = null;

async function load(): Promise<Stored> {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8").catch(() => '{"members":[],"invites":[]}')) as Stored;
  return cache;
}

async function store(s: Stored) {
  cache = s;
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  await rename(`${FILE}.tmp`, FILE);
}

const isAdminLogin = (login?: string) => !!login && ADMINS.includes(login.toLowerCase());
const memberKey = (login: string) => login.toLowerCase();

/** Can this session use the workspace right now? (Always true when the workspace isn't invite-only.) */
export async function isActiveMember(s: Pick<Session, "github">): Promise<boolean> {
  if (!INVITE_ONLY) return true;
  if (!s.github) return false;
  if (isAdminLogin(s.github)) return true;
  return (await load()).members.some((m) => m.login === memberKey(s.github!));
}

export async function isAdmin(s: Pick<Session, "github">) {
  if (!s.github) return false;
  if (isAdminLogin(s.github)) return true;
  return (await load()).members.some((m) => m.login === memberKey(s.github!) && m.role === "admin");
}

/**
 * Called after GitHub sign-in. Admins and existing members get in; others
 * need a valid invite token (which is consumed) or the GitHub allowlist.
 */
export async function admit(user: { login: string; name: string; avatar?: string }, inviteToken?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = await load();
  const login = memberKey(user.login);
  const existing = s.members.find((m) => m.login === login);
  if (existing) {
    existing.name = user.name; existing.avatar = user.avatar;
    if (isAdminLogin(login)) existing.role = "admin";
    await store(s);
    return { ok: true };
  }
  const add = async (role: WorkspaceMember["role"], invitedBy?: string) => {
    s.members.push({ login, name: user.name, avatar: user.avatar, role, joinedAt: new Date().toISOString(), invitedBy });
    await store(s);
    return { ok: true as const };
  };
  if (isAdminLogin(login)) return add("admin");
  if (inviteToken) {
    const h = Buffer.from(sha(inviteToken));
    const inv = s.invites.find((i) => timingSafeEqual(Buffer.from(i.hash), h));
    if (inv && Date.parse(inv.expiresAt) > Date.now() && inv.uses < inv.maxUses) {
      inv.uses++;
      return add("member", inv.createdBy);
    }
    return { ok: false, reason: "This invite link has expired or was already used. Ask for a new one." };
  }
  if (!INVITE_ONLY && GITHUB && (GITHUB.allow.includes("*") || GITHUB.allow.includes(login))) return add("member");
  if (INVITE_ONLY && GITHUB?.allow.includes(login)) return add("member");
  return { ok: false, reason: INVITE_ONLY ? "Margin here is invite-only. Ask an admin for an invite link." : `@${user.login} isn't on this workspace's access list.` };
}

/** Check an invite token without using it (for the landing page). */
export async function peekInvite(token: string) {
  const s = await load();
  const h = Buffer.from(sha(token));
  const inv = s.invites.find((i) => timingSafeEqual(Buffer.from(i.hash), h));
  return !!inv && Date.parse(inv.expiresAt) > Date.now() && inv.uses < inv.maxUses;
}

export async function workspaceInfo(s: Session): Promise<WorkspaceInfo> {
  const st = await load();
  const admin = await isAdmin(s);
  const now = Date.now();
  return {
    inviteOnly: INVITE_ONLY,
    admin,
    members: st.members.map((m) => ({ ...m, role: isAdminLogin(m.login) ? "admin" : m.role })),
    invites: admin ? st.invites.filter((i) => Date.parse(i.expiresAt) > now && i.uses < i.maxUses).map(({ hash: _h, ...i }) => i) : [],
    configAdmins: ADMINS,
  };
}

function requireAdmin(ok: boolean) {
  if (!ok) throw Object.assign(new Error("Only workspace admins can do that"), { status: 403 });
}

export async function createInvite(s: Session, opts: { days?: number; maxUses?: number }) {
  requireAdmin(await isAdmin(s));
  const st = await load();
  const token = randomBytes(18).toString("base64url");
  const days = Math.min(30, Math.max(1, opts.days ?? 7));
  const invite: StoredInvite = {
    id: randomBytes(5).toString("hex"), hash: sha(token), createdBy: s.name, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 864e5).toISOString(), maxUses: Math.min(50, Math.max(1, opts.maxUses ?? 1)), uses: 0,
  };
  st.invites.push(invite);
  await store(st);
  return { id: invite.id, token, expiresAt: invite.expiresAt, maxUses: invite.maxUses };
}

export async function revokeInvite(s: Session, id: string) {
  requireAdmin(await isAdmin(s));
  const st = await load();
  st.invites = st.invites.filter((i) => i.id !== id);
  await store(st);
}

export async function removeMember(s: Session, login: string) {
  requireAdmin(await isAdmin(s));
  if (isAdminLogin(login)) throw Object.assign(new Error("Admins listed in MARGIN_ADMINS can only be removed from the server config"), { status: 400 });
  const st = await load();
  st.members = st.members.filter((m) => m.login !== memberKey(login));
  await store(st);
}

export async function setRole(s: Session, login: string, role: WorkspaceMember["role"]) {
  requireAdmin(await isAdmin(s));
  const st = await load();
  const m = st.members.find((x) => x.login === memberKey(login));
  if (!m) throw Object.assign(new Error("No such member"), { status: 404 });
  m.role = role;
  await store(st);
}
