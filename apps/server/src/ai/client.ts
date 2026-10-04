import Anthropic from "@anthropic-ai/sdk";
import type { Session } from "@margin/shared";
import { getKey } from "./keys.ts";

export const MODEL = process.env.MARGIN_AI_MODEL ?? "claude-opus-5-5";

/**
 * If a request is declined by a safety classifier, let the API re-run it on
 * Anthropic's recommended fallback model instead of failing.
 */
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

/** A workspace-wide key members can use when they haven't added their own. */
export const SHARED_KEY = process.env.ANTHROPIC_API_KEY || undefined;

export class NoKeyError extends Error {
  constructor() { super("Add your Anthropic API key in AI settings to use Claude."); }
}

/** An API client using the member's own key, else the workspace key. */
export async function clientFor(session: Session): Promise<Anthropic> {
  const apiKey = (await getKey(session.name)) ?? SHARED_KEY;
  if (!apiKey) throw new NoKeyError();
  return new Anthropic({ apiKey, authToken: null, maxRetries: 2 });
}

/** Plain-language message for an API failure (no internals leaked). */
export function describeApiError(err: unknown): string {
  if (err instanceof NoKeyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected. Check it in AI settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? "?"}). Try again.`;
  return (err as Error)?.message ?? "Something went wrong.";
}
