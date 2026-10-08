import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { PaperReview, ReviewResult, ReviewSkill, Session } from "@margin/shared";
import { DATA_DIR, SKILLS_DIR } from "../config.ts";
import { getProject, projectDir } from "../storage.ts";
import { resolveDocument } from "../documents.ts";
import { FALLBACK, MODEL, clientFor, describeApiError } from "./client.ts";
import { flattenPaper, locateQuote, textFiles, textOf } from "./paper.ts";
import { agentPanelPrompt, consolidate, parseAgentPanel, parsePanel, runPanel } from "./panel.ts";
import { setReviewHook, startAgentThread } from "../connect/relay.ts";
import { emit } from "../collab.ts";
import { writeText } from "../storage.ts";

/** Save a review report next to the main file, in reviews/, never overwriting (-v2, -v3…). */
async function saveReport(projectId: string, mainFile: string, prefix: string, markdown: string) {
  const dir = path.posix.dirname(mainFile) === "." ? "reviews" : `${path.posix.dirname(mainFile)}/reviews`;
  const date = new Date().toISOString().slice(0, 10);
  for (let v = 1; v < 100; v++) {
    const rel = `${dir}/${prefix}_${date}${v > 1 ? `-v${v}` : ""}.md`;
    if ((await textOf(projectId, rel)) !== null) continue;
    await writeText(projectId, rel, markdown);
    emit(projectId, "filesVersion", Date.now());
    return rel;
  }
  return undefined;
}

// ── Skills (rubrics) ──────────────────────────────────────────────────────

interface Skill extends ReviewSkill { body: string; meta: Record<string, string> }

export async function listSkills(): Promise<Skill[]> {
  const names = (await readdir(SKILLS_DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort();
  const skills = await Promise.all(names.map(async (n): Promise<Skill> => {
    const raw = await readFile(path.join(SKILLS_DIR, n), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const meta = Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => l.split(/:\s*(.*)/s).slice(0, 2).map((s) => s.trim())));
    const body = (m?.[2] ?? raw).trim();
    const kind = meta.kind === "panel" ? "panel" : "rubric";
    return {
      id: n.slice(0, -3), name: meta.name || n.slice(0, -3), description: meta.description || "", body, meta, kind,
      reviewers: kind === "panel" ? (body.match(/^## lens:/gm) ?? []).length : 1, credit: meta.credit,
    };
  }));
  // Panels first: they're the most useful.
  return skills.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "panel" ? -1 : 1));
}

// ── Output schema ─────────────────────────────────────────────────────────

const Issue = z.strictObject({
  quote: z.string().describe("Verbatim passage from the paper source (as written in LaTeX, under ~200 characters, unique enough to find), or empty if the issue is about the paper as a whole"),
  problem: z.string(),
  suggestion: z.string().describe("A concrete fix the authors can make"),
  severity: z.enum(["high", "medium", "low"]),
});

const Review = z.strictObject({
  overall_score: z.number().int().describe("1-10 readiness for the stated goal"),
  readiness: z.enum(["not ready", "major revision", "minor revision", "ready"]),
  summary: z.string().describe("3-5 sentences: what the paper does and the verdict"),
  strengths: z.array(z.string()),
  top_priorities: z.array(z.string()).describe("The few changes that would most improve the paper's chances, most important first"),
  criteria: z.array(z.strictObject({
    name: z.string(),
    score: z.number().int().describe("1-10"),
    assessment: z.string(),
    issues: z.array(Issue),
  })),
});

const SYSTEM = `You are an experienced peer reviewer and writing mentor helping authors before they submit. You receive a review rubric, the authors' publishing goal, and the paper's LaTeX source (with \\input files expanded and marked) plus its bibliography.

Assess the paper against each rubric criterion as a reviewer for that goal would, and score honestly: 5 means a typical submission that would likely be rejected at the stated venue, 8 means competitive there, 10 is rare. Ground every point in the paper's actual text. Prefer the issues that would most change the outcome over minor polish; don't report LaTeX formatting trivia unless readers would see it.

For each issue, quote the passage verbatim from the source so the authors can find it, and give a concrete suggestion. Write in the paper's language.`;

// ── Runs ──────────────────────────────────────────────────────────────────

type StoredReview = Omit<PaperReview, "result"> & { status: "running" | "done" | "error"; error?: string; result?: ReviewResult };

const reviewsDir = (projectId: string) => path.join(DATA_DIR, "reviews", path.basename(projectDir(projectId)));

async function saveReview(projectId: string, r: StoredReview) {
  const file = path.join(reviewsDir(projectId), `${r.id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(r, null, 2));
  await rename(`${file}.tmp`, file);
}

export async function listReviews(projectId: string): Promise<StoredReview[]> {
  const dir = reviewsDir(projectId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const all = await Promise.all(names.map((n) => readFile(path.join(dir, n), "utf8").then((s) => JSON.parse(s) as StoredReview).catch(() => null)));
  return all.filter((r): r is StoredReview => !!r).sort((a, b) => b.at.localeCompare(a.at));
}

export async function getReview(projectId: string, id: string): Promise<StoredReview | null> {
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
  return readFile(path.join(reviewsDir(projectId), `${id}.json`), "utf8").then((s) => JSON.parse(s) as StoredReview).catch(() => null);
}

export interface Runner { deviceId: string; agentId: string }

/** Start a review in the background; poll getReview for the result. */
export async function startReview(projectId: string, session: Session, skillId: string, goalOverride?: string, runner?: Runner, docPath?: string): Promise<StoredReview> {
  const skill = (await listSkills()).find((s) => s.id === skillId);
  if (!skill) throw new Error("Unknown review skill");
  const doc = (await resolveDocument(projectId, docPath)).path;
  const project = { ...(await getProject(projectId)), mainFile: doc };
  const goal = goalOverride?.trim() || project.goal || "Not specified - assess general readiness for peer review.";
  if (runner) return startAgentReview(projectId, session, skill, project, goal, runner);
  const client = await clientFor(session); // fail fast without a key
  const review: StoredReview = { id: crypto.randomUUID(), skill: skill.id, goal, doc, by: session.name, at: new Date().toISOString(), status: "running" };
  await saveReview(projectId, review);

  void (async () => {
    try {
      const paper = await flattenPaper(projectId, doc);
      const bibs = (await textFiles(projectId)).filter((f) => f.path.endsWith(".bib"));
      const bibText = (await Promise.all(bibs.map(async (b) => `%%%%% file ${b.path}\n${await textOf(projectId, b.path)}`))).join("\n\n");

      if (skill.kind === "panel") {
        const spec = parsePanel(skill.body, skill.meta);
        let last = 0;
        const { result, markdown } = await runPanel({
          client, goal, title: project.name,
          paperBlock: { type: "text", text: `<paper title="${project.name}">\n${paper.text}\n</paper>\n\n<bibliography>\n${bibText || "(no .bib files)"}\n</bibliography>`, cache_control: { type: "ephemeral" } },
          locate: (quote) => locateQuote(projectId, quote, paper.files),
          onProgress: (done, running) => {
            review.progress = { done, running, total: spec.lenses.length };
            const now = Date.now();
            if (now - last > 500) { last = now; void saveReview(projectId, review); }
          },
        }, spec);
        result.panel!.report = await saveReport(projectId, project.mainFile, spec.report, markdown);
        await saveReview(projectId, { ...review, progress: undefined, status: "done", result });
        return;
      }

      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 48000,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: betaZodOutputFormat(Review) },
        ...FALLBACK,
        messages: [{
          role: "user",
          content: [
            // Paper first and cached: re-reviewing with another rubric or goal reuses it.
            { type: "text", text: `<paper title="${project.name}">\n${paper.text}\n</paper>\n\n<bibliography>\n${bibText || "(no .bib files)"}\n</bibliography>`, cache_control: { type: "ephemeral" } },
            { type: "text", text: `<rubric name="${skill.name}">\n${skill.body}\n</rubric>\n\n<goal>${goal}</goal>\n\nReview the paper.` },
          ],
        }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") throw new Error("Claude declined to review this paper.");
      if (message.stop_reason === "max_tokens") throw new Error("The review was cut off. Try again.");
      const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
      const result = Review.parse(JSON.parse(text)) as ReviewResult;

      // Pin each quoted issue to a file and line so the UI can jump there or comment on it.
      for (const c of result.criteria) {
        c.score = Math.max(1, Math.min(10, c.score));
        for (const issue of c.issues) {
          const hit = await locateQuote(projectId, issue.quote, paper.files);
          if (hit) { issue.file = hit.file; issue.line = hit.line; }
        }
      }
      result.overall_score = Math.max(1, Math.min(10, result.overall_score));
      await saveReview(projectId, { ...review, status: "done", result });
    } catch (err) {
      console.error("review:", err);
      await saveReview(projectId, { ...review, status: "error", error: describeApiError(err) });
    }
  })();
  return review;
}


// ── Reviews on your own agent (Claude Code, Codex…) through Margin Connect ───

function agentRubricPrompt(skill: Skill, goal: string, mainFile: string) {
  return `[Margin review] Review the paper in this folder for Margin, the authors' collaborative LaTeX workspace. This is a read-only task: do not create, modify or delete any files.

The main file is ${mainFile}. Read it and every file it \\input/\\includes (recursively), plus its .bib files; that is the paper. Ignore reviews/ folders, previous reports, notes and old drafts.

${SYSTEM}

<rubric name="${skill.name}">
${skill.body}
</rubric>

<goal>${goal}</goal>

Finish with your final answer: ONE fenced code block tagged json and nothing after it, matching this JSON Schema exactly:
${JSON.stringify(z.toJSONSchema(Review))}`;
}

async function startAgentReview(projectId: string, session: Session, skill: Skill, project: { name: string; mainFile: string }, goal: string, runner: Runner): Promise<StoredReview> {
  const review: StoredReview = { id: crypto.randomUUID(), skill: skill.id, goal, doc: project.mainFile, by: session.name, at: new Date().toISOString(), status: "running" };
  const prompt = skill.kind === "panel"
    ? agentPanelPrompt(parsePanel(skill.body, skill.meta), skill.name, goal, project.mainFile)
    : agentRubricPrompt(skill, goal, project.mainFile);
  await saveReview(projectId, review);
  try {
    const t = await startAgentThread(session, projectId, runner.deviceId, runner.agentId, `Run review: ${skill.name} (${goal})`, prompt, review.id);
    review.runner = { agent: t.agentName, device: t.deviceName, deviceId: t.deviceId, threadId: t.id };
    review.activity = [];
    await saveReview(projectId, review);
  } catch (err) {
    await saveReview(projectId, { ...review, status: "error", error: (err as Error).message });
    throw err;
  }
  return review;
}

const finished = new Set<string>();
const lastSave = new Map<string, number>();

setReviewHook({
  activity: (t, text) => {
    if (!t.reviewId || finished.has(t.reviewId)) return;
    void getReview(t.projectId, t.reviewId).then((r) => {
      if (!r || r.status !== "running") return;
      r.activity = [...(r.activity ?? []).filter((a) => a !== text), text].slice(-8);
      const now = Date.now();
      if (now - (lastSave.get(r.id) ?? 0) > 400) { lastSave.set(r.id, now); void saveReview(t.projectId, r); }
    });
  },
  failed: (t, message) => {
    if (!t.reviewId || finished.has(t.reviewId)) return;
    finished.add(t.reviewId);
    void getReview(t.projectId, t.reviewId).then((r) => r && saveReview(t.projectId, { ...r, status: "error", error: message }));
  },
  done: (t, answer) => {
    if (!t.reviewId || finished.has(t.reviewId)) return;
    finished.add(t.reviewId);
    void (async () => {
      const r = await getReview(t.projectId, t.reviewId!);
      if (!r) return;
      try {
        const skill = (await listSkills()).find((x) => x.id === r.skill)!;
        const project = { ...(await getProject(t.projectId)), ...(r.doc ? { mainFile: r.doc } : {}) };
        const paper = await flattenPaper(t.projectId, project.mainFile);
        const locate = (quote: string) => locateQuote(t.projectId, quote, paper.files);
        let result: ReviewResult;
        if (skill.kind === "panel") {
          const spec = parsePanel(skill.body, skill.meta);
          const parsed = parseAgentPanel(answer, spec);
          const out = await consolidate({ title: project.name, goal: r.goal, locate }, spec, parsed.results, parsed.failed, parsed.coordinator);
          result = out.result;
          result.panel!.report = await saveReport(t.projectId, project.mainFile, spec.report, out.markdown.replace("**Margin score**", `**Run on**: ${t.agentName} (${t.deviceName})\n**Margin score**`));
        } else {
          const block = [...answer.matchAll(/\`\`\`(?:json)?\s*\n([\s\S]*?)\n\`\`\`/g)].map((m) => m[1]).pop() ?? answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
          result = Review.parse(JSON.parse(block)) as ReviewResult;
          for (const c of result.criteria) for (const issue of c.issues) {
            const hit = await locate(issue.quote);
            if (hit) { issue.file = hit.file; issue.line = hit.line; }
          }
        }
        await saveReview(t.projectId, { ...r, status: "done", result, activity: undefined });
      } catch (err) {
        console.error("agent review:", err);
        await saveReview(t.projectId, { ...r, status: "error", error: (err as Error).message.startsWith("The agent") ? (err as Error).message : `Couldn't read ${t.agentName}'s review: ${(err as Error).message}` });
      }
    })();
  },
});
