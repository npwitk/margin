// ── AI (P2) ─────────────────────────────────────────────────────────────────

export interface AiSettings {
  /** The signed-in member has stored their own Anthropic API key. */
  hasKey: boolean;
  last4?: string;
  /** The workspace has a shared key members without their own can use. */
  shared: boolean;
  model: string;
}

/** One step of agent activity shown in the chat transcript. */
export interface ChatToolStep {
  type: "tool";
  name: string;
  /** Human-readable summary, e.g. "Read sections/method.tex". */
  summary: string;
  ok: boolean;
  /** For edits/comments: where the suggestion landed, so the UI can jump to it. */
  path?: string;
  threadId?: string;
}

export type ChatPart = { type: "text"; text: string } | ChatToolStep;

export type ChatEntry =
  | { role: "user"; by: string; text: string; at: string }
  | { role: "assistant"; parts: ChatPart[]; at: string; error?: string };

export interface ChatSummary {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
}

export interface Chat extends ChatSummary {
  entries: ChatEntry[];
}

/** Streamed to the browser while an assistant turn runs (server-sent events). */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string; summary: string }
  | { type: "tool_end"; step: ChatToolStep }
  | { type: "thinking" }
  | { type: "done"; usage?: { input: number; output: number; cacheRead: number } }
  | { type: "error"; message: string };

/** An agent currently working in the project (shown next to human presence). */
export interface AgentActivity {
  chatId: string;
  /** The member the agent is working for. */
  for: string;
  status: string;
  file?: string;
  at: number;
}

// Reviewer

export interface ReviewSkill {
  id: string;
  name: string;
  description: string;
}

export type IssueSeverity = "high" | "medium" | "low";

export interface ReviewIssue {
  /** Exact text from the paper the issue refers to ("" when it's about the paper as a whole). */
  quote: string;
  problem: string;
  suggestion: string;
  severity: IssueSeverity;
  /** Resolved by the server: where the quote is in the project. */
  file?: string;
  line?: number;
}

export interface ReviewCriterion {
  name: string;
  /** 1–10 */
  score: number;
  assessment: string;
  issues: ReviewIssue[];
}

export type Readiness = "not ready" | "major revision" | "minor revision" | "ready";

export interface ReviewResult {
  overall_score: number;
  readiness: Readiness;
  summary: string;
  strengths: string[];
  top_priorities: string[];
  criteria: ReviewCriterion[];
}

export interface PaperReview {
  id: string;
  skill: string;
  goal: string;
  by: string;
  at: string;
  result: ReviewResult;
}

// Citations

export type CitationStatus = "verified" | "likely" | "mismatch" | "not_found" | "error";

export interface CitationMatch {
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
  source: "crossref" | "openalex";
}

export interface CitationCheck {
  key: string;
  file: string;
  line: number;
  title?: string;
  year?: number;
  doi?: string;
  status: CitationStatus;
  /** Why we reached this status, in plain words. */
  note: string;
  similarity?: number;
  match?: CitationMatch;
  cited: boolean;
}

export interface CitationReport {
  checkedAt: string;
  entries: CitationCheck[];
  /** \cite keys with no .bib entry. */
  missing: { key: string; file: string; line: number }[];
}
