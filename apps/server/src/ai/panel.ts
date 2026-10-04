import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ContributionRating, PanelResult, Recommendation, ReviewCriterion, ReviewIssue, ReviewResult } from "@margin/shared";
import { FALLBACK, MODEL } from "./client.ts";

/**
 * Panel reviews: several specialist reviewers (from a skill file) read the
 * same paper in parallel; Margin then consolidates their findings into one
 * scored report. The prompts follow Claes Bäckman's AI-research-feedback
 * skills (MIT), generalised to any field.
 */

export interface Lens { id: string; title: string; weight: number; effort: "low" | "medium" | "high"; role: "standard" | "referee" | "advocate" | "skeptic"; body: string }
export interface PanelSkill { preamble: string; lenses: Lens[]; triage: string[]; report: string; scoring: "venue" | "defects"; credit?: string }

export function parsePanel(body: string, meta: Record<string, string>): PanelSkill {
  const parts = body.split(/^## lens:\s*/m);
  const lenses = parts.slice(1).map((chunk) => {
    const [header, ...rest] = chunk.split("\n");
    const [id, title, ...attrs] = header.split("|").map((s) => s.trim());
    const kv = Object.fromEntries(attrs.map((a) => a.split(/\s+/)).map(([k, v]) => [k, v]));
    return {
      id, title, weight: Number(kv.weight ?? 1),
      effort: (["low", "medium", "high"].includes(kv.effort) ? kv.effort : "high") as Lens["effort"],
      role: (["standard", "referee", "advocate", "skeptic"].includes(kv.role) ? kv.role : "standard") as Lens["role"],
      body: rest.join("\n").trim(),
    };
  });
  return {
    preamble: parts[0].trim(), lenses,
    triage: (meta.triage ?? "").split(/\s+/).filter(Boolean),
    report: meta.report || "REVIEW",
    scoring: meta.scoring === "defects" ? "defects" : "venue",
    credit: meta.credit,
  };
}

export const LensOutput = z.strictObject({
  score: z.number().int().describe("1-10 for your area"),
  summary: z.string().describe("Your assessment in a few paragraphs (Markdown allowed)"),
  issues: z.array(z.strictObject({
    severity: z.enum(["critical", "major", "minor"]),
    quote: z.string().describe("Verbatim passage from the paper, or empty for whole-paper issues"),
    location: z.string().describe("Section or paragraph"),
    problem: z.string(),
    fix: z.string(),
  })),
  rating: z.enum(["transformative", "significant", "incremental", "insufficient", "none"]).describe("Contribution rating; only for the advocate, skeptic or a referee asked to rate it, otherwise none"),
  rating_justification: z.string(),
  recommendation: z.enum(["send to referees", "revise before sending", "desk reject", "none"]).describe("Only for the referee, otherwise none"),
  questions: z.array(z.string()).describe("Pointed questions to the authors (referee only)"),
});
export type LensResult = z.infer<typeof LensOutput>;

export const Coordinator = z.strictObject({
  overall_assessment: z.string().describe("3-4 sentences: what the paper does, where the contribution stands, and the single most critical issue"),
  synthesis: z.string().describe("One paragraph reconciling the advocate and skeptic: where they agree, the crux of disagreement, and the single change that would most strengthen the contribution"),
  crux: z.string().describe("The judgment call the authors must win, in one sentence, or empty"),
  strengths: z.array(z.string()).describe("3-5 genuine strengths reported by the reviewers"),
});

const PANEL_SYSTEM = "You are an expert reviewer of academic papers, working as one member of a review panel. Follow your panel role's instructions exactly and return only the requested structured result.";

const RATING_SCORE: Record<ContributionRating, number> = { transformative: 9.5, significant: 7.5, incremental: 5, insufficient: 2.5 };
const TAG = { critical: "CRITICAL", major: "MAJOR", minor: "MINOR" } as const;
const SEV = { critical: "high", major: "medium", minor: "low" } as const;

export interface PanelRun {
  client: Anthropic;
  paperBlock: Anthropic.Beta.BetaTextBlockParam;
  goal: string;
  title: string;
  onProgress(done: string[], running: string[]): void;
  /** Find a quoted passage in the project. */
  locate(quote: string): Promise<{ file: string; line: number } | null>;
}

async function runLens(r: PanelRun, skill: PanelSkill, lens: Lens, onStart?: () => void): Promise<LensResult> {
  const stream = r.client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: PANEL_SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: lens.effort, format: betaZodOutputFormat(LensOutput) },
    ...FALLBACK,
    messages: [{
      role: "user",
      content: [
        r.paperBlock,
        { type: "text", text: `<panel_instructions>\n${skill.preamble}\n</panel_instructions>\n\n<your_role name="${lens.title}">\n${lens.body}\n</your_role>\n\n<goal>${r.goal}</goal>\n\nWrite your review.` },
      ],
    }],
  });
  if (onStart) stream.on("streamEvent", (e) => { if (e.type === "message_start") onStart(); });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("declined");
  if (message.stop_reason === "max_tokens") throw new Error("output cut off");
  const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  return LensOutput.parse(JSON.parse(text));
}

/** Run every reviewer, then consolidate. */
export async function runPanel(r: PanelRun, skill: PanelSkill): Promise<{ result: ReviewResult; markdown: string }> {
  const results = new Map<string, LensResult>();
  const failed: string[] = [];
  const running = new Set<string>();
  const report = () => r.onProgress([...results.keys(), ...failed].map((id) => skill.lenses.find((l) => l.id === id)!.title), [...running].map((id) => skill.lenses.find((l) => l.id === id)!.title));

  const one = async (lens: Lens, onStart?: () => void) => {
    running.add(lens.id);
    report();
    try {
      results.set(lens.id, await runLens(r, skill, lens, onStart));
    } catch (err) {
      console.error(`panel lens ${lens.id}:`, err);
      failed.push(lens.id);
    } finally {
      running.delete(lens.id);
      report();
    }
  };

  // Start one reviewer first so the paper is cached, then the rest (a few at a time).
  const [first, ...rest] = skill.lenses;
  let started!: () => void;
  const warmed = new Promise<void>((res) => { started = res; setTimeout(res, 20_000); });
  const firstRun = one(first, started);
  await warmed;
  const queue = [...rest];
  await Promise.all([firstRun, ...Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await one(queue.shift()!);
  })]);
  if (!results.size) throw new Error("No reviewer returned a result. Check your API key and try again.");
  return consolidate(r, skill, results, failed, async (digest, top) => {
    const msg = await r.client.beta.messages.stream({
      model: MODEL, max_tokens: 8000, system: "You consolidate a review panel's findings. Use only material from the reviewers' outputs; do not add judgments of your own.",
      thinking: { type: "adaptive" }, output_config: { effort: "medium", format: betaZodOutputFormat(Coordinator) }, ...FALLBACK,
      messages: [{ role: "user", content: `Paper: ${r.title}\nGoal: ${r.goal}\n\n${digest}\n\nThe most critical issue overall: ${top}.` }],
    }).finalMessage();
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    return Coordinator.parse(JSON.parse(text));
  });
}

type Coord = z.infer<typeof Coordinator>;

/**
 * Turn reviewers' results into one scored review and a Markdown report. The
 * same code scores panels run through the API and through your own agent.
 */
export async function consolidate(
  r: Pick<PanelRun, "title" | "goal" | "locate">,
  skill: PanelSkill,
  results: Map<string, LensResult>,
  failed: string[],
  coordinator: Coord | ((digest: string, top: string) => Promise<Coord>),
): Promise<{ result: ReviewResult; markdown: string }> {
  // ── Consolidate ─────────────────────────────────────────────────────────
  const get = (role: Lens["role"]) => skill.lenses.filter((l) => l.role === role).map((l) => results.get(l.id)).find(Boolean);
  const referee = get("referee"), advocate = get("advocate"), skeptic = get("skeptic");
  const rating = (x?: LensResult) => (x && x.rating !== "none" ? x.rating : undefined);

  const issues: (ReviewIssue & { _lens: number })[] = [];
  for (const [i, lens] of skill.lenses.entries()) {
    for (const it of results.get(lens.id)?.issues ?? []) {
      issues.push({ quote: it.quote, problem: it.problem, suggestion: it.fix, severity: SEV[it.severity], tag: TAG[it.severity], location: it.location, lens: lens.title, _lens: i });
    }
  }
  // Pin quoted findings to file:line.
  await Promise.all(issues.map(async (it) => {
    const hit = it.quote ? await r.locate(it.quote) : null;
    if (hit) { it.file = hit.file; it.line = hit.line; }
  }));
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const it of issues) counts[it.tag!.toLowerCase() as keyof typeof counts]++;

  // Triage: by severity, then by the skill's lens priority.
  const rank = (it: (typeof issues)[number]) => {
    const t = skill.triage.indexOf(skill.lenses[it._lens].id);
    return (it.tag === "CRITICAL" ? 0 : it.tag === "MAJOR" ? 1 : 2) * 1000 + (t < 0 ? 100 + it._lens : t);
  };
  const triaged = [...issues].sort((a, b) => rank(a) - rank(b));

  // Scores.
  const scored = skill.lenses.filter((l) => l.weight > 0 && results.has(l.id));
  const totalWeight = scored.reduce((n, l) => n + l.weight, 0);
  let base = totalWeight ? scored.reduce((n, l) => n + l.weight * results.get(l.id)!.score, 0) / totalWeight : 5;
  let overall: number;
  if (skill.scoring === "defects") {
    overall = Math.max(1, Math.min(10, 10 - 1.5 * counts.critical - 0.4 * counts.major - 0.1 * counts.minor, base + 1));
  } else {
    const ratings = [rating(advocate), rating(skeptic), skill.lenses.some((l) => l.role === "advocate") ? undefined : rating(referee)].filter((x): x is ContributionRating => !!x);
    const contribution = ratings.length ? ratings.reduce((n, x) => n + RATING_SCORE[x], 0) / ratings.length : undefined;
    overall = contribution === undefined ? base : 0.6 * base + 0.4 * contribution;
    const rec = referee?.recommendation;
    if (rec === "desk reject") overall = Math.min(overall, 4);
    else if (rec === "revise before sending") overall = Math.min(overall, 6.5);
    if (ratings.length >= 2 && ratings.every((x) => x === "insufficient")) overall = Math.min(overall, 3);
    base = Math.round(base);
  }
  overall = Math.max(1, Math.min(10, Math.round(overall)));
  const recommendation = referee && referee.recommendation !== "none" ? (referee.recommendation as Recommendation) : undefined;
  const readiness = skill.scoring === "defects"
    ? (counts.critical ? "major revision" : counts.major > 3 ? "minor revision" : "ready")
    : recommendation === "desk reject" ? "not ready" : recommendation === "revise before sending" ? "major revision" : overall >= 8 ? "ready" : "minor revision";

  // Coordinator: a short synthesis from the reviewers' outputs only.
  let coord: Coord = { overall_assessment: "", synthesis: "", crux: "", strengths: [] };
  try {
    if (typeof coordinator !== "function") coord = coordinator;
    else {
      const digest = skill.lenses.filter((l) => results.has(l.id)).map((l) => {
        const x = results.get(l.id)!;
        return `## ${l.title} (score ${x.score}${x.rating !== "none" ? `, rating ${x.rating}` : ""}${x.recommendation !== "none" ? `, recommendation ${x.recommendation}` : ""})\n${x.summary}\n${x.rating_justification}\nTop issues:\n${x.issues.filter((i) => i.severity !== "minor").slice(0, 6).map((i) => `- [${TAG[i.severity]}] ${i.problem}`).join("\n")}`;
      }).join("\n\n");
      coord = await coordinator(digest, triaged[0] ? `[${triaged[0].tag}] ${triaged[0].problem}` : "none");
    }
  } catch (err) {
    console.error("panel coordinator:", err);
    coord.overall_assessment = referee?.summary.split("\n")[0] ?? "See the reviewers' sections below.";
  }

  const criteria: ReviewCriterion[] = skill.lenses.filter((l) => l.weight > 0 || l.role === "referee").map((l) => {
    const x = results.get(l.id);
    return {
      name: l.title,
      score: x ? Math.max(1, Math.min(10, x.score)) : 0,
      assessment: x ? x.summary : "This reviewer didn't return a result.",
      issues: triaged.filter((it) => it.lens === l.title).map(({ _lens: _l, ...it }) => it),
    };
  });

  const panel: PanelResult = {
    recommendation,
    contribution: advocate || skeptic ? {
      advocate: advocate && rating(advocate) ? { rating: rating(advocate)!, justification: advocate.rating_justification, summary: advocate.summary } : undefined,
      skeptic: skeptic && rating(skeptic) ? { rating: rating(skeptic)!, justification: skeptic.rating_justification, summary: skeptic.summary } : undefined,
      synthesis: coord.synthesis + (coord.synthesis ? " Novelty relative to literature not cited in the paper has not been verified." : ""),
      crux: coord.crux || undefined,
    } : undefined,
    counts,
    questions: referee?.questions ?? [],
    failed: failed.map((id) => skill.lenses.find((l) => l.id === id)!.title),
    credit: skill.credit,
    scoring: skill.scoring,
  };

  const result: ReviewResult = {
    overall_score: overall,
    readiness,
    summary: coord.overall_assessment,
    strengths: coord.strengths,
    top_priorities: triaged.filter((t) => t.tag !== "MINOR").slice(0, 8).map((t) => `[${t.tag}] ${t.problem}${t.suggestion ? ` Fix: ${t.suggestion}` : ""}`),
    criteria,
    panel,
  };
  return { result, markdown: markdownReport(r, skill, result, results, triaged) };
}

// ── Running a review on your own agent (Margin Connect) ──────────────────────

/** One prompt that asks a local agent (Claude Code, Codex…) to run the whole panel and answer in JSON. */
export function agentPanelPrompt(skill: PanelSkill, name: string, goal: string, mainFile: string): string {
  const lensSchema = z.toJSONSchema(LensOutput);
  const coordSchema = z.toJSONSchema(Coordinator);
  return `[Margin review] Run the "${name}" review of the paper in this folder for Margin, the authors' collaborative LaTeX workspace. This is a read-only task: do not create, modify or delete any files.

The paper's main file is ${mainFile}. Read it and every file it \\input/\\includes (recursively); that set is the paper. Ignore anything else in the folder, especially reviews/ folders, previous review reports, notes and old drafts.
Target venue / goal: ${goal}

The panel has ${skill.lenses.length} reviewers. If you can run subagents (for example a Task/Agent tool), run each reviewer as its own independent subagent, all in parallel, giving each one the shared instructions, its role, and the list of paper files. If you can't, do each reviewer's pass yourself, one after another, keeping their judgments independent.

<shared_instructions>
${skill.preamble}
</shared_instructions>

${skill.lenses.map((l) => `<reviewer id="${l.id}" title="${l.title}">\n${l.body}\n</reviewer>`).join("\n\n")}

When every reviewer is done, act as the coordinator: using only the reviewers' outputs, write the overall assessment (3-4 sentences: what the paper does, where the contribution stands, the single most critical issue), a synthesis reconciling the advocate and the skeptic (if present), the crux of their disagreement, and 3-5 genuine strengths.

Finish with your final answer: ONE fenced code block tagged json and nothing after it, shaped exactly like this:
\`\`\`json
{"lenses": [{"id": "<reviewer id>", ...one object per reviewer, matching LensResult...}], "coordinator": {...matching Coordinator...}}
\`\`\`
LensResult JSON Schema: ${JSON.stringify(lensSchema)}
Coordinator JSON Schema: ${JSON.stringify(coordSchema)}
Use "none" for rating and recommendation where they don't apply to a reviewer, and an empty quote for whole-paper issues. Quotes must be copied verbatim from the paper source.`;
}

/** Pull the JSON answer out of an agent's final message. Lenient about extra text; strict about content. */
export function parseAgentPanel(text: string, skill: PanelSkill): { results: Map<string, LensResult>; failed: string[]; coordinator: Coord } {
  const blocks = [...text.matchAll(/\`\`\`(?:json)?\s*\n([\s\S]*?)\n\`\`\`/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let raw: { lenses?: unknown[]; coordinator?: unknown } | null = null;
  for (const c of candidates) {
    try { raw = JSON.parse(c); if (raw && Array.isArray(raw.lenses)) break; } catch { /* try the next block */ }
    raw = null;
  }
  if (!raw) throw new Error("The agent didn't finish with the review JSON. Try again, or use a different agent.");
  const results = new Map<string, LensResult>();
  const failed: string[] = [];
  for (const lens of skill.lenses) {
    const entry = (raw.lenses as { id?: string }[]).find((x) => x?.id === lens.id);
    const { id: _id, ...rest } = (entry ?? {}) as Record<string, unknown>;
    const parsed = LensOutput.safeParse({ rating: "none", rating_justification: "", recommendation: "none", questions: [], issues: [], ...rest });
    if (parsed.success) results.set(lens.id, parsed.data); else failed.push(lens.id);
  }
  if (!results.size) throw new Error("The agent's review JSON didn't contain any usable reviewer results.");
  const coordinator = Coordinator.safeParse({ overall_assessment: "", synthesis: "", crux: "", strengths: [], ...(raw.coordinator as object ?? {}) });
  return { results, failed, coordinator: coordinator.success ? coordinator.data : { overall_assessment: "", synthesis: "", crux: "", strengths: [] } };
}

/** The consolidated report in the skill's own format, for the project's reviews/ folder. */
function markdownReport(r: Pick<PanelRun, "title" | "goal">, skill: PanelSkill, res: ReviewResult, results: Map<string, LensResult>, triaged: ReviewIssue[]): string {
  const p = res.panel!;
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  const title = skill.report === "PAPER_CHECK" ? "Paper Check" : skill.report === "QUICK_REVIEW" ? "Quick Pre-Submission Check" : "Pre-Submission Referee Report";
  lines.push(`# ${title}`, "", `**Paper**: ${r.title}`, `**Date**: ${date}`, `**Review standard**: ${r.goal}`, `**Margin score**: ${res.overall_score}/10 (${res.readiness})`, "");
  if (p.credit) lines.push(`> ${p.credit}`, "");
  lines.push("---", "", skill.scoring === "defects" ? "## Summary" : "## Overall Assessment", "", res.summary, "");
  if (p.contribution) {
    const a = p.contribution.advocate?.rating, s = p.contribution.skeptic?.rating;
    lines.push(`**Contribution rating**: ${a && s ? (a === s ? a : `${a} (advocate) / ${s} (skeptic)`) : a ?? s ?? "n/a"}${p.contribution.crux ? ` — crux: ${p.contribution.crux}` : ""}`, "");
  }
  if (p.recommendation) lines.push(`**Preliminary recommendation**: ${p.recommendation}`, "");
  lines.push(`**Counts**: ${p.counts.critical} CRITICAL, ${p.counts.major} MAJOR, ${p.counts.minor} MINOR`, "");
  if (p.failed.length) lines.push(`> These reviewers did not return output: ${p.failed.join(", ")}.`, "");
  if (p.contribution) {
    lines.push("---", "", "## Central Contribution", "");
    if (p.contribution.advocate) lines.push("### Advocate's case", "", p.contribution.advocate.summary, "", `**Rating**: ${p.contribution.advocate.rating}. ${p.contribution.advocate.justification}`, "");
    if (p.contribution.skeptic) lines.push("### Skeptic's case", "", p.contribution.skeptic.summary, "", `**Rating**: ${p.contribution.skeptic.rating}. ${p.contribution.skeptic.justification}`, "");
    if (p.contribution.synthesis) lines.push("### Synthesis", "", p.contribution.synthesis, "");
  }
  for (const lens of skill.lenses) {
    if (lens.role === "advocate" || lens.role === "skeptic") continue;
    const x = results.get(lens.id);
    lines.push("---", "", `## ${lens.title}${x ? ` — ${x.score}/10` : ""}`, "");
    if (!x) { lines.push("_This reviewer did not return output._", ""); continue; }
    lines.push(x.summary, "");
    for (const it of x.issues) lines.push(`- **[${TAG[it.severity]}]** ${it.location ? `${it.location} | ` : ""}${it.quote ? `“${it.quote}” | ` : ""}${it.problem}${it.fix ? ` → ${it.fix}` : ""}`);
    if (x.issues.length) lines.push("");
    if (x.questions.length) lines.push("### Questions to the authors", "", ...x.questions.map((q, i) => `${i + 1}. ${q}`), "");
  }
  lines.push("---", "", skill.scoring === "defects" ? "## Fix List" : "## Priority Action Items", "");
  for (const tag of ["CRITICAL", "MAJOR", "MINOR"] as const) {
    const items = triaged.filter((t) => t.tag === tag);
    if (!items.length) continue;
    lines.push(`**${tag}**`, "", ...items.map((t, i) => `${i + 1}. ${t.file ? `\`${t.file}:${t.line}\` ` : t.location ? `${t.location}: ` : ""}${t.problem}${t.suggestion ? ` → ${t.suggestion}` : ""} _(${t.lens})_`), "");
  }
  return lines.join("\n");
}
