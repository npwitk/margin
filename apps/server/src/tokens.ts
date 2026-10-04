import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

/** Personal access tokens, used as the password for `git clone` / `git push` (and agents later). */
export interface TokenRecord {
  id: string;
  member: string;
  /** GitHub login of the member, when they signed in with GitHub. */
  github?: string;
  label: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

const FILE = path.join(DATA_DIR, "tokens.json");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let cache: TokenRecord[] | null = null;

async function load(): Promise<TokenRecord[]> {
  if (!cache) cache = JSON.parse(await readFile(FILE, "utf8").catch(() => "[]")) as TokenRecord[];
  return cache;
}

async function store(list: TokenRecord[]) {
  cache = list;
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(list, null, 2));
  await rename(`${FILE}.tmp`, FILE);
}

const publicView = ({ hash: _hash, ...rest }: TokenRecord) => rest;

export async function listTokens(member: string) {
  return (await load()).filter((t) => t.member === member).map(publicView);
}

export async function createToken(member: string, label: string, github?: string) {
  const token = `mgn_${randomBytes(24).toString("base64url")}`;
  const rec: TokenRecord = {
    id: randomBytes(6).toString("hex"),
    member,
    github,
    label: label.trim().slice(0, 60) || "Token",
    hash: sha256(token),
    createdAt: new Date().toISOString(),
  };
  await store([...(await load()), rec]);
  return { ...publicView(rec), token };
}

export async function revokeToken(member: string, id: string) {
  const list = await load();
  const next = list.filter((t) => !(t.id === id && t.member === member));
  if (next.length === list.length) return false;
  await store(next);
  return true;
}

/** Returns who a token belongs to, or null. */
export async function verifyToken(token: string): Promise<{ name: string; github?: string } | null> {
  if (!token.startsWith("mgn_")) return null;
  const h = Buffer.from(sha256(token));
  const list = await load();
  const rec = list.find((t) => t.hash.length === h.length && timingSafeEqual(Buffer.from(t.hash), h));
  if (!rec) return null;
  const now = Date.now();
  if (!rec.lastUsedAt || now - Date.parse(rec.lastUsedAt) > 60_000) {
    rec.lastUsedAt = new Date(now).toISOString();
    await store(list);
  }
  return { name: rec.member, github: rec.github };
}
