import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ConnectAgent } from "./protocol.js";

/**
 * Agents margin-connect can run, each through its ACP adapter. The adapters
 * start the agent from its normal configuration folder (~/.claude, ~/.codex),
 * so the user's sign-in, MCP servers, skills and settings all apply.
 */

export interface AgentSpec extends ConnectAgent {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const require = createRequire(import.meta.url);

function binOf(pkg: string, name: string): string | null {
  try {
    const pj = require.resolve(`${pkg}/package.json`);
    const json = JSON.parse(readFileSync(pj, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof json.bin === "string" ? json.bin : json.bin?.[name];
    return rel ? path.join(path.dirname(pj), rel) : null;
  } catch {
    return null;
  }
}

export function detectAgents(): AgentSpec[] {
  const claude = binOf("@agentclientprotocol/claude-agent-acp", "claude-agent-acp");
  const codex = binOf("@zed-industries/codex-acp", "codex-acp");
  const agents: AgentSpec[] = [
    {
      id: "claude", name: "Claude Code", available: !!claude, command: process.execPath, args: claude ? [claude] : [],
      note: "Uses your Claude Code sign-in and settings (run `claude` once to sign in).",
    },
    {
      id: "codex", name: "Codex", available: !!codex, command: process.execPath, args: codex ? [codex] : [],
      note: "Uses your Codex sign-in (`codex login`) or OPENAI_API_KEY.",
    },
  ];
  // Extra or replacement agents: MARGIN_CONNECT_AGENTS='[{"id":"gemini","name":"Gemini","command":"gemini","args":["--experimental-acp"]}]'
  if (process.env.MARGIN_CONNECT_AGENTS) {
    for (const a of JSON.parse(process.env.MARGIN_CONNECT_AGENTS) as AgentSpec[]) {
      const i = agents.findIndex((x) => x.id === a.id);
      const spec: AgentSpec = { ...a, available: a.available ?? true, args: a.args ?? [] };
      if (i >= 0) agents[i] = spec; else agents.push(spec);
    }
  }
  return agents;
}

export function spawnAgent(spec: AgentSpec, cwd: string): ChildProcess {
  return spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
}

/** The margin-paper-mcp server, attached to every session so agents get Margin's tools. */
export function marginMcpPath(): string | null {
  const p = binOf("margin-paper-mcp", "margin-paper-mcp");
  return p && existsSync(p) ? p : null;
}
