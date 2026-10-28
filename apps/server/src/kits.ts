import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { DATA_DIR } from "./config.ts";
import { HttpError } from "./storage.ts";

/**
 * Official style files for venues whose formats aren't in TeX Live (NeurIPS,
 * ICML, ICLR, *ACL, CVPR, USENIX). They aren't ours to redistribute, so the
 * server downloads them from the venue the first time someone picks the
 * template, keeps a copy, and copies them into each new project.
 */

interface Kit {
  url: string;
  /** Files to keep: path inside the zip (or "" for a single file) → name in the project. */
  files: Record<string, string>;
}

export const KITS: Record<string, Kit> = {
  neurips: {
    url: "https://media.neurips.cc/Conferences/NeurIPS2025/Styles.zip",
    files: { "Styles/neurips_2025.sty": "neurips_2025.sty" },
  },
  icml: {
    url: "https://media.icml.cc/Conferences/ICML2025/Styles/icml2025.zip",
    files: {
      "icml2025/icml2025.sty": "icml2025.sty",
      "icml2025/icml2025.bst": "icml2025.bst",
      "icml2025/algorithm.sty": "algorithm.sty",
      "icml2025/algorithmic.sty": "algorithmic.sty",
      "icml2025/fancyhdr.sty": "fancyhdr.sty",
    },
  },
  iclr: {
    url: "https://github.com/ICLR/Master-Template/raw/master/iclr2026.zip",
    files: {
      "iclr2026/iclr2026_conference.sty": "iclr2026_conference.sty",
      "iclr2026/iclr2026_conference.bst": "iclr2026_conference.bst",
      "iclr2026/math_commands.tex": "math_commands.tex",
      "iclr2026/fancyhdr.sty": "fancyhdr.sty",
      "iclr2026/natbib.sty": "natbib.sty",
    },
  },
  acl: {
    url: "https://github.com/acl-org/acl-style-files/archive/refs/heads/master.zip",
    files: { "acl-style-files-master/acl.sty": "acl.sty", "acl-style-files-master/acl_natbib.bst": "acl_natbib.bst" },
  },
  cvpr: {
    url: "https://github.com/cvpr-org/author-kit/archive/refs/heads/main.zip",
    files: { "author-kit-main/cvpr.sty": "cvpr.sty", "author-kit-main/ieeenat_fullname.bst": "ieeenat_fullname.bst" },
  },
  usenix: {
    url: "https://www.usenix.org/sites/default/files/usenix-2020-09.sty",
    files: { "": "usenix-2020-09.sty" },
  },
};

const MAX_BYTES = 20 * 1024 * 1024;
const inflight = new Map<string, Promise<Record<string, Uint8Array>>>();

export const kitDir = (id: string, root = path.join(DATA_DIR, "kits")) => path.join(root, id);

async function download(id: string, kit: Kit): Promise<Record<string, Uint8Array>> {
  const res = await fetch(kit.url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("download too large");
  const out: Record<string, Uint8Array> = {};
  if (kit.files[""]) {
    out[kit.files[""]] = buf;
  } else {
    const wanted = new Set(Object.keys(kit.files));
    const entries = unzipSync(buf, { filter: (f) => wanted.has(f.name) });
    for (const [inZip, name] of Object.entries(kit.files)) {
      if (!entries[inZip]) throw new Error(`${inZip} is missing from the download`);
      out[name] = entries[inZip];
    }
  }
  return out;
}

/** The kit's files (downloading them once, then from the local copy). */
export async function kitFiles(id: string, root?: string): Promise<Record<string, Uint8Array>> {
  const kit = KITS[id];
  if (!kit) return {};
  const dir = kitDir(id, root);
  const names = Object.values(kit.files);
  const cached = await Promise.all(names.map((n) => readFile(path.join(dir, n)).catch(() => null)));
  if (cached.every(Boolean)) return Object.fromEntries(names.map((n, i) => [n, new Uint8Array(cached[i]!)]));

  if (!inflight.has(id)) {
    inflight.set(id, (async () => {
      let files: Record<string, Uint8Array>;
      try {
        files = await download(id, kit);
      } catch (err) {
        throw new HttpError(502, `Couldn't download the official style files from ${new URL(kit.url).host} (${(err as Error).message}). Try again, or pick another template.`);
      }
      // Write to a temporary folder and swap it in, so a half-finished download never looks complete.
      const tmp = `${dir}.tmp-${process.pid}`;
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      for (const [name, data] of Object.entries(files)) await writeFile(path.join(tmp, name), data);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      return files;
    })().finally(() => inflight.delete(id)));
  }
  return inflight.get(id)!;
}
