import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { parse } from "yaml";
import { templateForVenue, type ConferenceEdition } from "@margin/shared";
import type { AppEnv } from "./auth.ts";
import { DATA_DIR } from "./config.ts";

/**
 * Upcoming conference deadlines, from the community-maintained ccf-deadlines
 * list (MIT licensed, github.com/ccfddl/ccf-deadlines). Fetched at most once
 * a day, kept on disk so a restart or an outage still has the last copy.
 */

const SOURCE = process.env.MARGIN_DEADLINES_URL ?? "https://ccfddl.com/conference/allconf.yml";
const CACHE = path.join(DATA_DIR, "cache", "conferences.json");
const DAY = 24 * 60 * 60 * 1000;

const AREAS: Record<string, string> = {
  DS: "Architecture", NW: "Networks", SC: "Security", SE: "Software", DB: "Data", CT: "Theory",
  CG: "Graphics", AI: "AI", HI: "HCI", MX: "Interdisciplinary",
};

interface Raw {
  title: string;
  description?: string;
  sub?: string;
  rank?: { ccf?: string; core?: string };
  confs?: { year: number; link?: string; timezone?: string; date?: string; place?: string; timeline?: { deadline?: string; abstract_deadline?: string; comment?: string }[] }[];
}

/** UTC offset in hours for the zones the list uses ("AoE", "UTC-12", "UTC+8", "PT"…). */
export function offsetHours(tz = "AoE"): number {
  const t = tz.trim().toUpperCase();
  if (t === "AOE") return -12;
  if (t === "PT" || t === "PST" || t === "PDT") return -8;
  if (t === "ET" || t === "EST") return -5;
  if (t === "CET") return 1;
  const m = /^(?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (m) return Number(m[1]) + Math.sign(Number(m[1])) * Number(m[2] ?? 0) / 60;
  return 0;
}

/** "2026-01-15 23:59:59" in the venue's zone → ISO instant, or null for "TBD". */
export function deadlineInstant(local: string | undefined, tz?: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec((local ?? "").trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)) - offsetHours(tz) * 3600_000;
  return new Date(utc).toISOString();
}

/** One entry per conference: its next deadline, or (when none is announced) its latest edition. */
export function editionsFrom(raw: Raw[], now = Date.now()): ConferenceEdition[] {
  const out: ConferenceEdition[] = [];
  for (const c of raw) {
    if (!c?.title || !Array.isArray(c.confs) || !c.confs.length) continue;
    let best: ConferenceEdition | null = null;
    let latest: ConferenceEdition | null = null;
    for (const e of c.confs) {
      for (const t of e.timeline ?? [{}]) {
        const deadline = deadlineInstant(t.deadline, e.timezone);
        const edition: ConferenceEdition = {
          name: c.title,
          description: c.description ?? c.title,
          year: Number(e.year),
          deadline,
          abstractDeadline: deadlineInstant(t.abstract_deadline, e.timezone),
          round: t.comment || undefined,
          timezone: e.timezone,
          date: e.date,
          place: e.place,
          link: e.link?.startsWith("http") ? e.link : undefined,
          area: AREAS[c.sub ?? ""] ?? c.sub,
          rank: c.rank?.core ? `CORE ${c.rank.core}` : c.rank?.ccf ? `CCF ${c.rank.ccf}` : undefined,
          template: templateForVenue(c.title)?.id,
        };
        if (deadline && Date.parse(deadline) >= now && (!best || Date.parse(deadline) < Date.parse(best.deadline!))) best = edition;
        if (!latest || edition.year > latest.year || (edition.year === latest.year && (deadline ?? "") > (latest.deadline ?? ""))) latest = edition;
      }
    }
    const pick = best ?? latest;
    if (pick) out.push(pick);
  }
  return out;
}

let memory: { at: number; editions: ConferenceEdition[]; raw: Raw[] } | null = null;
let loading: Promise<void> | null = null;

async function refresh() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = parse(await res.text(), { maxAliasCount: 100 }) as Raw[];
  if (!Array.isArray(raw)) throw new Error("unexpected format");
  memory = { at: Date.now(), raw, editions: editionsFrom(raw) };
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ at: memory.at, raw }));
}

async function load() {
  if (!memory) {
    const disk = await readFile(CACHE, "utf8").then((t) => JSON.parse(t) as { at: number; raw: Raw[] }).catch(() => null);
    if (disk) memory = { at: disk.at, raw: disk.raw, editions: editionsFrom(disk.raw) };
  }
  if (!memory || Date.now() - memory.at > DAY) {
    loading ??= refresh().catch((err) => console.warn(`conference deadlines: ${(err as Error).message}`)).finally(() => { loading = null; });
    if (!memory) await loading; // first ever load: wait; otherwise refresh in the background
  }
  // Deadlines pass while the list is cached; recompute which edition is next.
  if (memory && Date.now() - memory.at > 60 * 60 * 1000) memory.editions = editionsFrom(memory.raw);
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9&+]+/g, " ").trim();

/**
 * Conferences matching `q` (name first, then description), upcoming
 * deadlines first. With no query: the next deadlines for venues we have a
 * template for.
 */
export async function searchConferences(q: string, limit = 12): Promise<ConferenceEdition[]> {
  await load();
  const all = memory?.editions ?? [];
  const now = Date.now();
  const upcoming = (e: ConferenceEdition) => !!e.deadline && Date.parse(e.deadline) >= now;
  const query = normal(q);
  if (!query) {
    return all.filter((e) => upcoming(e) && e.template).sort((a, b) => a.deadline!.localeCompare(b.deadline!)).slice(0, limit);
  }
  const score = (e: ConferenceEdition) => {
    const name = normal(e.name), desc = normal(e.description);
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (name.split(" ").some((w) => w.startsWith(query))) return 2;
    if (desc.includes(query)) return 3;
    return -1;
  };
  return all
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || Number(upcoming(b.e)) - Number(upcoming(a.e)) || (a.e.deadline ?? "9").localeCompare(b.e.deadline ?? "9"))
    .slice(0, limit)
    .map((x) => x.e);
}

export const conferenceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await searchConferences((c.req.query("q") ?? "").slice(0, 80))));
