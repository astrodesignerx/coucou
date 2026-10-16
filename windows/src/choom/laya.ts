// Local Laya frontend policy: the offline decision engine behind the same
// voice turn that uses Jev. Its whole contract is negative on purpose. This
// engine has no cloud mode and no fallback mode, so no outcome of it, and no
// failure of it, may ever reach Jev or a remote agent. Every exit is an
// editable clarification or a visible offline limitation.

import type { DecisionEngine, LayaOutcome, LayaReceipt, LayaStatus } from "../core/bridge";
import type { Settings } from "../core/state";

/** The five labels the worker may return, in the order the manifest lists. */
export const LAYA_LABELS = [
  "answer", "options", "clarify", "supported_local", "unknown",
] as const;
export type LayaLabel = (typeof LAYA_LABELS)[number];

/** Conservative default, deliberately stricter than the Jev one: the local
 *  probabilities are not calibrated against the cloud model, so the default
 *  leans toward abstaining and clarifying rather than guessing. */
export const LAYA_THRESHOLD_DEFAULT = 0.85;
export const LAYA_THRESHOLD_MIN = 0.75;
export const LAYA_THRESHOLD_MAX = 0.95;

export type LayaAction =
  | "clarify"
  | "show_options"
  | "name_saved_target"
  | "offline_limit";

/** Anything that is not exactly the local selector reads as online Jev, so a
 *  corrupt settings value can never quietly turn on a local worker. */
export function normalizeDecisionEngine(engine: string | null | undefined): DecisionEngine {
  return engine === "laya" ? "laya" : "jev";
}

export function isLocalEngine(settings: Settings): boolean {
  return normalizeDecisionEngine(settings.decisionEngine) === "laya";
}

export function clampLayaThreshold(value: number): number {
  if (!Number.isFinite(value)) return LAYA_THRESHOLD_DEFAULT;
  return Math.min(LAYA_THRESHOLD_MAX, Math.max(LAYA_THRESHOLD_MIN, value));
}

export function isValidLayaLabel(label: string): label is LayaLabel {
  return (LAYA_LABELS as readonly string[]).includes(label);
}

/**
 * What one local outcome is allowed to do. Every branch ends the turn locally.
 * There is deliberately no "fallback to the agent" branch: an unsupported or
 * unconfident local answer is a limitation to show, not a reason to call out.
 */
export function layaNextStep(
  outcome: LayaOutcome,
  threshold: number,
  grounded: boolean,
): LayaAction {
  if (!isValidLayaLabel(outcome.route)) return "offline_limit";
  // Any fallback reason is a bounded, fixed explanation of why the local
  // engine abstained: missing runtime, low confidence, timeout, and so on.
  if (outcome.fallbackReason) {
    return outcome.route === "clarify" ? "clarify" : "offline_limit";
  }
  if (!Number.isFinite(outcome.confidence) || outcome.confidence < clampLayaThreshold(threshold)) {
    return "clarify";
  }
  switch (outcome.route) {
    case "clarify":
      return "clarify";
    case "options":
      // Options only reach the user as real saved targets. With none of the
      // named ones saved, the honest answer is a limitation, not a guess.
      return grounded ? "show_options" : "offline_limit";
    case "supported_local":
      // The local model believes a saved capability fits. Only a real saved
      // target the user named can be offered, and only as a click.
      return grounded ? "show_options" : "name_saved_target";
    case "answer":
      // This engine does not answer questions. Saying so is the whole point.
      return "offline_limit";
    default:
      return "offline_limit";
  }
}

/** True when the action resolves to a saved target the user can click. */
export function layaShowsOptions(action: LayaAction): boolean {
  return action === "show_options";
}

/** True when the request should move back into the editable field. */
export function layaShowsClarification(action: LayaAction): boolean {
  return action === "clarify" || action === "name_saved_target";
}

/** The visible offline limitation. Plain words, no jargon, no promise. */
export const LAYA_OFFLINE_LIMIT =
  "Laya works out what to do with this on your computer and cannot do anything online. " +
  "Try naming something you have saved, or switch the engine in Settings.";

/** The visible explanation for an unsure local result. */
export const LAYA_CLARIFY_PROMPT =
  "Laya was not sure what you meant. Say a bit more, or keep talking.";

/** Sanitized one-line receipt for Settings. No request text, ever. */
export function formatLayaReceipt(receipt: LayaReceipt): string {
  const conf = Number.isFinite(receipt.confidence) ? receipt.confidence.toFixed(2) : "0.00";
  const base = `Laya ${receipt.route} (local, ${conf}, ${receipt.latencyMs}ms)`;
  return receipt.fallbackReason ? `${base} fallback: ${receipt.fallbackReason}` : base;
}

/** Sanitized outcome to receipt, dropping the candidate slot and raw text. */
export function outcomeToLayaReceipt(outcome: LayaOutcome, atMs: number): LayaReceipt {
  return {
    route: isValidLayaLabel(outcome.route) ? outcome.route : "unknown",
    confidence: Number.isFinite(outcome.confidence) ? outcome.confidence : 0,
    latencyMs: Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : 0,
    fallbackReason: outcome.fallbackReason ?? null,
    atMs,
  };
}

/** One short readiness line. Never claims Ready from a file on disk. */
export function formatLayaStatus(status: LayaStatus | null): string {
  if (!status) return "Laya status unavailable outside Choom.";
  switch (status.state) {
    case "ready": {
      const load = status.loadMs != null ? ` Load time ${formatSeconds(status.loadMs)}.` : "";
      return `Ready. Laya is loaded and deciding on this computer.${load}`;
    }
    case "loading":
      return "Loading. Laya is set up, and the first request loads it on this computer.";
    case "error":
      return `Not ready. ${status.detail}`;
    default:
      return `Not ready. ${status.detail}`;
  }
}

/** Load time in seconds, so a slow machine reads honestly without a wall of
 *  digits. A load under ten seconds keeps one decimal instead of rounding
 *  down to zero. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Whether the check button may run: only when the local engine is selected. */
export function canCheckLocalEngine(settings: Settings): boolean {
  return isLocalEngine(settings);
}