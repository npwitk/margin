import { execFileSync } from "node:child_process";

export interface Config {
  /** e.g. https://paper.example.com */
  url: string;
  project: string;
  token: string;
  /** Overrides the agent name shown to collaborators. */
  agentName?: string;
}

const GIT_REMOTE = /^(https?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/]+)((?:\/[^/]+)*?)\/git\/([a-z0-9-]+)\.git\/?$/;

/** Read --flag value pairs from argv. */
function flags(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? argv[++i] ?? "";
  }
  return out;
}

/** Parse a Margin git remote like https://user:token@host/git/<project>.git */
export function parseRemote(remote: string) {
  const m = GIT_REMOTE.exec(remote.trim());
  if (!m) return null;
  const [, proto, , password, host, base, project] = m;
  return { url: `${proto}://${host}${base}`, project, token: password ? decodeURIComponent(password) : undefined };
}

function gitRemote(cwd: string) {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Configuration from flags, then environment, then the git remote of the
 * current folder (so inside a `git clone` of a Margin project nothing else is needed).
 */
export function loadConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()): Config {
  const f = flags(argv);
  const remote = gitRemote(cwd);
  const fromGit = remote ? parseRemote(remote) : null;
  const url = (f.url ?? env.MARGIN_URL ?? fromGit?.url ?? "").replace(/\/$/, "");
  const project = f.project ?? env.MARGIN_PROJECT ?? fromGit?.project ?? "";
  const token = f.token ?? env.MARGIN_TOKEN ?? fromGit?.token ?? "";
  const missing = [!url && "--url / MARGIN_URL", !project && "--project / MARGIN_PROJECT", !token && "--token / MARGIN_TOKEN"].filter(Boolean);
  if (missing.length) {
    throw new Error(`margin-mcp: missing ${missing.join(", ")}. Run it inside a clone of a Margin project, or pass them explicitly. Create a token in Margin → Local.`);
  }
  return { url, project, token, agentName: f.name ?? env.MARGIN_AGENT_NAME };
}
