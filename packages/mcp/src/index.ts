#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";

/**
 * margin-mcp: lets Claude Code, Codex or any MCP client work in a Margin
 * project as a visible collaborator. The tools are the same ones Margin's
 * built-in assistant uses; they run on the Margin server, so edits land in
 * everyone's live editor (directly or as suggestions, per project) and the
 * agent shows up in presence with its own cursor.
 */

const VERSION = "0.1.0";

const INSTRUCTIONS = `This connects you to a Margin project: LaTeX documents (a paper, and maybe slides, letters, a rebuttal…) that several co-authors edit live in their browsers. You work on the live paper directly: no clone, no commits, nothing to push.

Work like a co-author:
- read_file / search to look around; list_documents shows every document (paper, slides…).
- edit_file to change a passage (copy \`find\` exactly from read_file, one focused change per call); write_file to create or rewrite a whole file; add_section to add a section file to a document; create_folder / move_path / delete_path to organise; create_document for new slides, letters, posters.
- Co-authors watch your cursor and edits appear as you go, and can undo your whole run in one step. If the project is set to "Agents suggest", edits arrive as suggestions instead and file changes are refused; the tool result tells you.
- Use propose_edit when the authors should decide (claims, results, framing); add_comment for questions.
- compile after LaTeX changes that could break the build.
- Board: list_tasks, then claim a task with update_task before working on it; create_task for follow-ups only a person can do (run an experiment, ask the advisor).
- Comments: list_comments / reply_to_comment (resolve: true once addressed).
- When you finish a piece of work, save_version with a one-line summary of what changed, so co-authors and the advisor can follow along.`;

/** Friendly agent name from the MCP client's self-reported name. */
function agentNameFrom(client?: string) {
  const c = (client ?? "").toLowerCase();
  if (c.includes("claude-code") || c.includes("claude code")) return "Claude Code";
  if (c.includes("claude")) return "Claude";
  if (c.includes("codex")) return "Codex";
  if (c.includes("cursor")) return "Cursor";
  if (c.includes("gemini")) return "Gemini";
  return client ? client.slice(0, 40) : "Agent";
}

async function main() {
  const config = loadConfig();
  const server = new Server({ name: "margin", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const agent = () => config.agentName ?? agentNameFrom(server.getClientVersion()?.name);

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${config.url}/api/projects/${config.project}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.token}`, "x-margin-agent": agent(), "content-type": "application/json", "user-agent": `margin-mcp/${VERSION}` },
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Margin rejected the access token. Create a new one in Margin → Local and update MARGIN_TOKEN.");
    if (res.status === 404) throw new Error(`Margin project “${config.project}” not found at ${config.url}.`);
    if (!res.ok) throw new Error(body.error ?? `Margin returned HTTP ${res.status}`);
    return body;
  };

  let tools: Tool[] | null = null;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    tools ??= ((await api("/agent/tools")) as { name: string; description: string; input_schema: Tool["inputSchema"] }[])
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const r = await api(`/agent/tools/${encodeURIComponent(req.params.name)}`, { method: "POST", body: JSON.stringify({ input: req.params.arguments ?? {} }) }) as { content: string; isError?: boolean };
      return { content: [{ type: "text" as const, text: r.content }], isError: !!r.isError };
    } catch (err) {
      return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
    }
  });

  // Leave presence when the agent session ends.
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await api("/agent/activity", { method: "POST", body: JSON.stringify({ done: true }) }).catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", () => void close());
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());

  await server.connect(new StdioServerTransport());
  console.error(`margin-mcp connected to ${config.url} (project ${config.project})`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
