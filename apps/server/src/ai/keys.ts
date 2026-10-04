import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SECRET } from "../config.ts";

/**
 * Members' Anthropic API keys, encrypted at rest (AES-256-GCM with a key
 * derived from MARGIN_SECRET). Keys are only ever decrypted server-side to
 * make API calls and are never sent back to the browser.
 */

interface StoredKey { iv: string; tag: string; data: string; last4: string; savedAt: string }

const FILE = path.join(DATA_DIR, "ai-keys.json");
const cipherKey = () => createHash("sha256").update(`margin-ai-keys:${SECRET}`).digest();

async function load(): Promise<Record<string, StoredKey>> {
  return JSON.parse(await readFile(FILE, "utf8").catch(() => "{}"));
}

async function store(all: Record<string, StoredKey>) {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
  await rename(`${FILE}.tmp`, FILE);
}

export async function saveKey(member: string, apiKey: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([c.update(apiKey, "utf8"), c.final()]);
  const all = await load();
  all[member] = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), last4: apiKey.slice(-4), savedAt: new Date().toISOString() };
  await store(all);
}

export async function deleteKey(member: string) {
  const all = await load();
  delete all[member];
  await store(all);
}

export async function keyInfo(member: string) {
  const k = (await load())[member];
  return k ? { last4: k.last4 } : null;
}

export async function getKey(member: string): Promise<string | null> {
  const k = (await load())[member];
  if (!k) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", cipherKey(), Buffer.from(k.iv, "base64"));
    d.setAuthTag(Buffer.from(k.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(k.data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null; // MARGIN_SECRET changed; the member needs to re-enter it
  }
}
