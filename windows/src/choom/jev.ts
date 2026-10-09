// Jev frontend policy: bounded classifier behind voice and typed turns.
// Shadow records without altering execution. Assisted may only choose
// between answering and showing options or clarification. It never invents
// or executes a tool target, shell command, approval or provider switch.

import type { JevCandidate, JevOutcome, JevReceipt } from "../core/bridge";
import type { Settings } from "../core/state";

export const JEV_MODEL = "jev-1.13-free";
export const JEV_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
export const JEV_LABELS = ["answer", "options", "clarify", "supported_local", "unknown"] as const;
export type JevLabel = (typeof JEV_LABELS)[number];
export type JevMode = "off" | "shadow" | "assisted";

export function normalizeJevMode(mode: string): JevMode {
  if (mode === "off") return "off";
  if (mode === "assisted") return "assisted";
  return "shadow";
}

export function clampJevThreshold(value: number): number {
  if (!Number.isFinite(value)) return 0.75;
  // Approved confidence minimum: never below 0.75.
  return Math.min(0.95, Math.max(0.75, value));
}

export function clampJevDeadlineMs(value: number): number {
  if (!Number.isFinite(value)) return 2500;
  return Math.min(8000, Math.max(500, Math.round(value)));
}

export function isValidJevLabel(label: string): label is JevLabel {
  return (JEV_LABELS as readonly string[]).includes(label);
}

/** Network may happen only when explicitly enabled, non-off and configured. */
export function isJevEligible(settings: Settings, configured: boolean): boolean {
  if (!settings.jevEnabled) return false;
  if (normalizeJevMode(settings.jevMode) === "off") return false;
  return configured;
}

/** Local deterministic routes always bypass Jev. Only agent fallback asks. */
export function shouldAskJev(localKind: string): boolean {
  return localKind === "agent";
}

/** Shadow never alters execution: the caller always runs the old path. */
export function shadowPreservesExecution(mode: string): boolean {
  return normalizeJevMode(mode) === "shadow";
}

/**
 * Assisted policy: answer proceeds to the agent, options/clarify and a
 * validated supported_local become explicit user choices, unknown falls
 * back. Never returns a target to execute automatically.
 */
export function assistedNextStep(
  outcome: JevOutcome,
  eligibleIds: string[],
): { action: "answer" | "show_options" | "show_clarify" | "fallback"; candidateId: null } {
  const route = outcome.route;
  if (!isValidJevLabel(route)) return { action: "fallback", candidateId: null };
  if (route === "answer") return { action: "answer", candidateId: null };
  if (route === "options") return { action: "show_options", candidateId: null };
  if (route === "clarify") return { action: "show_clarify", candidateId: null };
  if (route === "supported_local") {
    // Even a validated local id stays an explicit choice, never auto-run.
    const id = outcome.candidateId;
    if (id && eligibleIds.includes(id)) return { action: "show_options", candidateId: null };
    return { action: "show_options", candidateId: null };
  }
  return { action: "fallback", candidateId: null };
}

/** Exact candidate check shared with the backend. */
export function jevCandidateAllowed(candidateId: string | null, eligible: JevCandidate[]): boolean {
  if (!candidateId) return false;
  return eligible.some((c) => c.id === candidateId);
}

/** Sanitized one-line receipt for the card and settings. No raw content. */
export function formatJevReceipt(receipt: JevReceipt): string {
  const conf = Number.isFinite(receipt.confidence) ? receipt.confidence.toFixed(2) : "0.00";
  const base = `Jev ${receipt.route} (${receipt.mode}, ${conf}, ${receipt.latencyMs}ms)`;
  return receipt.fallbackReason ? `${base} fallback: ${receipt.fallbackReason}` : base;
}

/** Sanitized outcome to receipt, dropping any candidate and raw text. */
export function outcomeToReceipt(outcome: JevOutcome, atMs: number): JevReceipt {
  return {
    route: isValidJevLabel(outcome.route) ? outcome.route : "unknown",
    mode: normalizeJevMode(outcome.mode),
    confidence: Number.isFinite(outcome.confidence) ? outcome.confidence : 0,
    latencyMs: Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : 0,
    fallbackReason: outcome.fallbackReason ?? null,
    atMs,
  };
}
