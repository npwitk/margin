import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { PaperReview, ReviewResult, ReviewSkill, Session } from "@margin/shared";
import { DATA_DIR, SKILLS_DIR } from "../config.ts";
import { getProject, projectDir } from "../storage.ts";
import { FALLBACK, MODEL, clientFor, describeApiError } from "./client.ts";
import { flattenPaper, locateQuote, textFiles, textOf } from "./paper.ts";

// ── Skills (rubrics) ──────────────────────────────────────────────────────

interface Skill extends ReviewSkill { body: string }

export async function listSkills(): Promise<Skill[]> {
  const names = (await readdir(SKILLS_DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort();
  return Promise.all(names.map(async (n) => {
    const raw = await readFile(path.join(SKILLS_DIR, n), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const meta = Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => l.split(/:\s*(.*)/s).slice(0, 2).map((s) => s.trim())));
    return { id: n.slice(0, -3), name: meta.name || n.slice(0, -3), description: meta.description || "", body: (m?.[2] ?? raw).trim() };
  }));
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

/** Start a review in the background; poll getReview for the result. */
export async function startReview(projectId: string, session: Session, skillId: string, goalOverride?: string): Promise<StoredReview> {
  const skill = (await listSkills()).find((s) => s.id === skillId);
  if (!skill) throw new Error("Unknown review skill");
  const client = await clientFor(session); // fail fast without a key
  const project = await getProject(projectId);
  const goal = goalOverride?.trim() || project.goal || "Not specified - assess general readiness for peer review.";
  const review: StoredReview = { id: crypto.randomUUID(), skill: skill.id, goal, by: session.name, at: new Date().toISOString(), status: "running" };
  await saveReview(projectId, review);

  void (async () => {
    try {
      const paper = await flattenPaper(projectId);
      const bibs = (await textFiles(projectId)).filter((f) => f.path.endsWith(".bib"));
      const bibText = (await Promise.all(bibs.map(async (b) => `%%%%% file ${b.path}\n${await textOf(projectId, b.path)}`))).join("\n\n");

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
