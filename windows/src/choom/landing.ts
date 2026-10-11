// Landing instances: A open invitation (home), B live companion (activity),
// C small launchpad (intentional shortcuts). Mode selection only, no DOM.
// The overview keeps the padded lead mascot and the existing rail; Home shows
// A despite active music, rail choices show B or C deliberately, and urgent
// permission surfaces bypass landing through shouldBypassLanding.

import { State } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { MUSIC_ID } from "./focus";
import { JOBS_ID, UTILITY_ID, jobRadarRows, resolveLeadJob } from "./quickAdditions";
import { TOOLS_ID } from "./tools";

export type LandingMode = "home" | "activity" | "launchpad";

/** B shows real current content for these rail destinations. */
export const ACTIVITY_IDS: readonly string[] = [MUSIC_ID, JOBS_ID, UTILITY_ID] as const;

/** C reuses the configured Tools shortcuts and routines. */
export const LAUNCHPAD_ID = TOOLS_ID;

let mode: LandingMode = "home";
let activityId: string | null = null;

export function getLandingMode(): LandingMode {
  return mode;
}

export function getLandingActivityId(): string | null {
  return activityId;
}

export function isLandingHome(): boolean {
  return mode === "home";
}

/**
 * Effective landing visibility: Home shows only when no urgent runtime
 * permission or error surface claims the island. Geometry and the overview
 * both key off this, so bypassed approval cards never inherit the home
 * height or suppress their own sizing.
 */
export function isHomeVisible(): boolean {
  return mode === "home" && !shouldBypassLanding();
}

/**
 * Effective launchpad visibility: the intentional instance shows only when
 * no urgent runtime permission or error surface claims the island.
 */
export function isLaunchpadVisible(): boolean {
  return mode === "launchpad" && !shouldBypassLanding();
}

/** Ordinary Home openings land on the overview, with zero or many tasks. */
export function homeIslandView(): IslandViewName {
  return "overview";
}

/** Default to the open invitation. Focus and pins are left untouched. */
export function showHome(): void {
  mode = "home";
}

/** Deliberate rail choice: B for activity ids, C for Tools, else B generic. */
export function showActivity(id: string): void {
  if (id === LAUNCHPAD_ID) {
    mode = "launchpad";
    activityId = id;
    return;
  }
  mode = "activity";
  activityId = id;
}

export function showLaunchpad(): void {
  mode = "launchpad";
  activityId = LAUNCHPAD_ID;
}

/** Finishing or dismissing an intentional instance returns to A. */
export function dismissToHome(): void {
  mode = "home";
}

/**
 * A deliberate rail selection updates the instance without resetting focus
 * handling: the caller still calls State.setFocus separately so approvals,
 * pins and manual holds keep their existing sticky behavior.
 */
export function noteFocusSelected(id: string): void {
  showActivity(id);
}

/**
 * Urgent runtime permission surfaces keep priority over landing: approval
 * cards, error badges and error states render their existing content even
 * when the instance is Home.
 */
export function shouldBypassLanding(): boolean {
  if (State.pendingApproval) return true;
  const task = State.focusTask;
  if (!task) return false;
  if (task.pillBadge === "approval" || task.pillBadge === "error") return true;
  if (task.state === "error" || task.state === "approval") return true;
  return false;
}

/** Heading for the open invitation card. */
export const LANDING_INVITATION = "What shall we do?";

/** Approved subline invitation; the heading above keeps its own line. */
export const LANDING_SUBLINE_INVITE = "Say Choom, or tap the mic";

function musicInfo(): string | null {
  const data = State.integrations[MUSIC_ID]?.data as
    | { app?: unknown; title?: unknown; artist?: unknown; playing?: unknown }
    | undefined;
  if (!data || data.playing !== true) return null;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const artist = typeof data.artist === "string" ? data.artist.trim() : "";
  const app = typeof data.app === "string" && data.app.trim() ? data.app.trim() : "Music";
  if (title && artist) return `${app} / ${title} / ${artist}`;
  if (title) return `${app} / ${title}`;
  return `${app} playing`;
}

function jobsInfo(): string | null {
  const { lead } = resolveLeadJob(jobRadarRows(State.tasks));
  if (!lead) return null;
  const live = lead.status === "approval" || lead.status === "error" ||
    lead.status === "working" || lead.status === "thinking" || lead.status === "searching";
  if (!live) return null;
  const detail = lead.detail.trim() || lead.status;
  return `${lead.name} / ${detail}`.slice(0, 80);
}

/**
 * Shared subline rotation lines: invitation first, then one real active line
 * per live source. Quiet means invitation only. No receipts, no diagnostics.
 */
export function sublineLines(): string[] {
  const lines = [LANDING_SUBLINE_INVITE];
  const music = musicInfo();
  if (music) lines.push(music);
  const jobs = jobsInfo();
  if (jobs) lines.push(jobs);
  return lines;
}

/** True while the voice turn owns the subline and rotation must pause. */
export function sublineListening(runtime: string): boolean {
  return runtime === "listening" || runtime === "processing" ||
    runtime === "working" || runtime === "speaking";
}
