import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Config { url: string; token: string; deviceId: string; home: string }

export const HOME = process.env.MARGIN_CONNECT_HOME ?? path.join(homedir(), ".margin-connect");
const FILE = path.join(HOME, "config.json");

function flags(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) out[m[1]] = m[2] ?? argv[++i] ?? "";
  }
  return out;
}

/** Flags/env win; whatever was used last time is remembered (token file is private to the user). */
export function loadConfig(argv = process.argv.slice(2), env = process.env): Config {
  let saved: Partial<Config> = {};
  try { saved = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* first run */ }
  const f = flags(argv);
  const url = (f.url ?? env.MARGIN_URL ?? saved.url ?? "").replace(/\/$/, "");
  const token = f.token ?? env.MARGIN_TOKEN ?? saved.token ?? "";
  if (!url || !token) {
    throw new Error("margin-connect: pass --url https://your-margin --token mgn_… (create a token in Margin → Local). They're remembered for next time.");
  }
  const config = { url, token, deviceId: saved.deviceId ?? randomUUID(), home: HOME };
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify({ url, token, deviceId: config.deviceId }, null, 2), { mode: 0o600 });
  return config;
}
