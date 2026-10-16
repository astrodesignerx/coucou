// Flow typed command grammar. A bounded, deterministic parser that turns one
// stable utterance into a plan of registered capability ids. It resolves app
// and folder launches only against targets the user already saved, never
// invents a target, and never emits arbitrary commands. An utterance that does
// not match the supported grammar returns null so the caller keeps the old
// dictation and agent path. A mixed request, a negated command or an
// unclosed quoted body is clarified as a whole and runs nothing. This is not
// general natural-language automation.

import {
  FLOW_STEP_KINDS,
  flowStepId,
  type FlowPlanRequest,
  type FlowStepRequest,
  type FlowStepState,
} from "./flow";
import { SESSION_NOTE_REF, type FlowCapabilityRegistry } from "./flowRegistry";

/** A saved shortcut the grammar may resolve a launch against. */
export interface FlowShortcut {
  id: string;
  name: string;
  kind: "app" | "folder";
  target: string;
}

/** What the grammar may rely on: the configured saved targets. */
export interface FlowGrammarContext {
  shortcuts: FlowShortcut[];
  /** False means note steps are refused instead of planned. */
  notesConfigured: boolean;
  /** When given, only registered capabilities are recognized as commands. */
  registry?: FlowCapabilityRegistry | null;
}

/** One parsed clause. `ambiguous` means the name matched several saved targets
 *  and the user must pick; it is never resolved by guessing. */
export type FlowClause =
  | { kind: "step"; step: FlowStepRequest }
  | { kind: "ambiguous"; options: FlowShortcut[]; message: string }
  | { kind: "unclear"; message: string }
  | { kind: "negated" };

/** Clauses chain on these connectors. Bare " and " is deliberately not a
 *  separator so "buy milk and eggs" inside a note body stays one body. */
const CONNECTORS: RegExp = /\s+(?:then|and then|and also)\s+|;\s*/i;

/** A clause that asks not to run a supported command. Negated commands never
 *  execute, and they surface as a clarification instead of silently doing
 *  nothing or falling through to the agent. */
const NEGATED_COMMAND = /^(?:(?:don't|do not|dont|never|no need to)\s+)(?:open|launch|start|run|create|make|write|rename|retitle|search|google|look\s+up|find|visit|play|pause|stop|next|previous)\b/i;

const LAUNCH_VERB = /^(?:open|launch|start|run)\s+/i;
const NOTE_CREATE = /^(?:create|make|write|new)\s+(?:a\s+)?note\b/i;
const NOTE_RENAME = /^(?:rename|retitle)\s+(?:the\s+)?(?:current\s+)?note\b/i;
/** "open the note" targets this session's own note in the configured editor. */
const OPEN_NOTE = /^(?:open|show|edit)\s+(?:the\s+)?(?:current\s+)?note\b/i;
const SEARCH_VERB = /^(?:search|google|look\s+up|find)\s+(?:for\s+)?/i;
const OPEN_URL = /^(?:open|go\s+to|visit)\s+/i;

/** Trims an optional leading article so "the notes app" reads as "notes app". */
function stripArticle(text: string): string {
  return text.replace(/^(?:the|a|an|my|your)\s+/i, "").replace(/[.!?]+$/, "").trim();
}

/** Saved-target matches for one name. Exact name wins; otherwise a unique
 *  substring match resolves; several matches are ambiguous, never guessed. */
function matchShortcuts(
  raw: string,
  kind: "app" | "folder",
  ctx: FlowGrammarContext,
): FlowShortcut[] {
  const want = stripArticle(raw).toLocaleLowerCase();
  if (!want) return [];
  const pool = ctx.shortcuts.filter((s) => s.kind === kind);
  const exact = pool.filter((s) => s.name.trim().toLocaleLowerCase() === want);
  if (exact.length > 0) return exact;
  return pool.filter((s) => s.name.trim().toLocaleLowerCase().includes(want) && want.length > 1);
}

/** Maps a saved shortcut kind to the Flow step kind it dispatches. Folder
 *  launches are folder.open, not folder.launch, so the plan stays inside the
 *  six supported kinds the planner accepts. */
function launchKindFor(kind: "app" | "folder"): string {
  return kind === "folder" ? "folder.open" : "app.launch";
}

/** An exact saved-name match in either kind beats any substring match in the
 *  other, so "open Notes" picks the Notes app even when a folder name merely
 *  contains "notes". Only when neither kind has an exact match do substrings
 *  decide, and then one match each across kinds stays ambiguous. */
function resolveLaunch(
  rest: string,
  ctx: FlowGrammarContext,
): FlowClause | null {
  const literal = rest.trim().toLocaleLowerCase();
  const literalMatches = ctx.shortcuts.filter((s) => s.name.trim().toLocaleLowerCase() === literal);
  if (literalMatches.length === 1) {
    const hit = literalMatches[0];
    return { kind: "step", step: { kind: launchKindFor(hit.kind), target: hit.target } };
  }
  if (literalMatches.length > 1) {
    return { kind: "ambiguous", options: literalMatches, message: `Which saved target named "${rest.trim()}"?` };
  }
  const want = stripArticle(rest).toLocaleLowerCase();
  const isExact = (s: FlowShortcut) => s.name.trim().toLocaleLowerCase() === want;
  const exactApps = matchShortcuts(rest, "app", ctx).filter(isExact);
  const exactFolders = matchShortcuts(rest, "folder", ctx).filter(isExact);
  // Exact matches take priority across both kinds.
  const exactAll = [...exactApps, ...exactFolders];
  if (exactAll.length === 1) {
    const hit = exactAll[0];
    return { kind: "step", step: { kind: launchKindFor(hit.kind), target: hit.target } };
  }
  if (exactAll.length > 1) {
    return {
      kind: "ambiguous",
      options: exactAll,
      message: `Which one: ${exactAll.map((h) => h.name).join(" or ")}?`,
    };
  }
  // No exact match: decide by substring, never by guessing among several.
  const folders = matchShortcuts(rest, "folder", ctx);
  const apps = matchShortcuts(rest, "app", ctx);
  if (folders.length === 1 && apps.length === 1) {
    return {
      kind: "ambiguous",
      options: [...folders, ...apps],
      message: `Which one: the ${apps[0].name} app or the ${folders[0].name} folder?`,
    };
  }
  const folderClause = clauseFromMatches(folders, "folder");
  if (folderClause) return folderClause;
  const appClause = clauseFromMatches(apps, "app");
  if (appClause) return appClause;
  return {
    kind: "unclear",
    message: `You have no saved app or folder named "${stripArticle(rest)}". Save it in Tools first.`,
  };
}

/** Turns saved-target matches into a clause. A single match becomes a step;
 *  several become an ambiguity the user resolves by saying the full name. */
function clauseFromMatches(
  matches: FlowShortcut[],
  kind: "app" | "folder",
): FlowClause | null {
  if (matches.length === 1) {
    return { kind: "step", step: { kind: launchKindFor(kind), target: matches[0].target } };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      options: matches,
      message: `Which one: ${matches.map((h) => h.name).join(" or ")}?`,
    };
  }
  return null;
}

/** Pull "titled X", "named X", "called X" out of a note clause. The marker
 *  may sit at the string start once an earlier marker was stripped, so this
 *  matches at position zero as well as after whitespace. */
function extractTitle(rest: string): { head: string; title: string | null } {
  const m = rest.match(/(?:^|\s)(?:titled|named|called)\s+(.+)$/i);
  if (m) return { head: rest.slice(0, m.index).trim(), title: stripArticle(m[1].trim()) };
  return { head: rest.trim(), title: null };
}

/** Pull an optional body: "with body X", "that says X", "saying X". A
 *  quoted body runs to its closing quote, so connectors inside quotes can
 *  never split into accidental commands. An unclosed quote is flagged for a
 *  clarification instead of being guessed at. */
function extractBody(rest: string): { head: string; body: string | null; unclosed?: boolean } {
  const m = rest.match(/\s+(?:with\s+body|that\s+says|saying|reading)\s+(.+)$/i);
  if (!m) return { head: rest.trim(), body: null };
  const raw = m[1].trim();
  if (raw.startsWith("\"")) {
    const end = raw.indexOf("\"", 1);
    if (end < 0) return { head: rest.trim(), body: null, unclosed: true };
    const trailing = raw.slice(end + 1).trim();
    if (trailing) return { head: rest.trim(), body: null };
    return { head: rest.slice(0, m.index).trim(), body: raw.slice(1, end).trim() };
  }
  return { head: rest.slice(0, m.index).trim(), body: raw };
}

/** Parses one clause into a single step, ambiguity or an unclear message. */
export function parseFlowClause(rawClause: string, ctx: FlowGrammarContext): FlowClause | null {
  const clause = rawClause.trim();
  if (!clause) return null;

  // Browser open: an explicit link is unambiguous and needs no saved target.
  const urlMatch = clause.match(OPEN_URL);
  if (urlMatch) {
    const rest = clause.slice(urlMatch[0].length).trim();
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(rest)) {
      const url = /^www\./i.test(rest) ? `https://${rest}` : rest;
      return { kind: "step", step: { kind: "browser.open", target: url } };
    }
  }

  // Search: the whole remainder is the query, no saved target involved.
  const searchMatch = clause.match(SEARCH_VERB);
  if (searchMatch) {
    const query = clause.slice(searchMatch[0].length).trim();
    if (query) return { kind: "step", step: { kind: "browser.search", target: query } };
    return { kind: "unclear", message: "Say what you want to search for." };
  }

  // Rename: an explicit session-note reference. "rename note to X" or
  // "rename the note to X". The step targets this session's own note; the
  // adapter refuses any other target, so nothing can rename an arbitrary path.
  const renameMatch = clause.match(NOTE_RENAME);
  if (renameMatch) {
    if (!ctx.notesConfigured) {
      return { kind: "unclear", message: "Pick a notes folder in Settings first." };
    }
    const rest = clause.slice(renameMatch[0].length).trim();
    const toMatch = rest.match(/^to\s+(.+)$/i);
    if (!toMatch) {
      return {
        kind: "unclear",
        message: "Rename the note from this turn, like: rename note to Trip plan.",
      };
    }
    const newTitle = stripArticle(toMatch[1].trim());
    if (!newTitle) return { kind: "unclear", message: "Say the new note name." };
    return {
      kind: "step",
      step: { kind: "note.rename", target: SESSION_NOTE_REF, value: newTitle },
    };
  }

  // Open this session's note in the configured editor. Checked before the
  // launch verb so "open the note" never becomes an app lookup.
  const openNoteMatch = clause.match(OPEN_NOTE);
  if (openNoteMatch) {
    if (!ctx.notesConfigured) {
      return { kind: "unclear", message: "Pick a notes folder in Settings first." };
    }
    return { kind: "step", step: { kind: "note.open", target: SESSION_NOTE_REF } };
  }

  // Create: "create a note titled X (with body Y)". The body may be
  // quoted so quoted text never splits into commands of its own.
  const createMatch = clause.match(NOTE_CREATE);
  if (createMatch) {
    if (!ctx.notesConfigured) {
      return { kind: "unclear", message: "Pick a notes folder in Settings first." };
    }
    let rest = clause.slice(createMatch[0].length).trim();
    const withBody = extractBody(rest);
    if (withBody.unclosed) {
      return {
        kind: "unclear",
        message: "Close the quote around the note text, or use: that says ...",
      };
    }
    rest = withBody.head;
    const titled = extractTitle(rest);
    const title = titled.title;
    if (!title) {
      return { kind: "unclear", message: "Say the note name, like: create a note titled Groceries." };
    }
    return {
      kind: "step",
      step: { kind: "note.create", target: title, value: withBody.body ?? "" },
    };
  }

  // Launch: app or folder, resolved only against saved targets.
  const launchMatch = clause.match(LAUNCH_VERB);
  if (launchMatch) {
    const rest = clause.slice(launchMatch[0].length).trim();
    if (!rest) return { kind: "unclear", message: "Say which app or folder to open." };
    return resolveLaunch(rest, ctx);
  }

  return null;
}

/** Result of parsing a whole utterance: a plan, or an actionable message, or
 *  null when the utterance is not a Flow command at all. */
export type FlowParseResult =
  | { kind: "plan"; request: FlowPlanRequest }
  | { kind: "ambiguous"; options: FlowShortcut[]; message: string }
  | { kind: "unclear"; message: string }
  | null;/** A note body marker: everything after it is dictated body text. */
const BODY_MARKER: RegExp = /(?:\s|^)(?:with\s+body|that\s+says|saying|reading)\s+/gi;

/** Quote parity per position, so connectors inside quotes never split. */
function quoteMap(text: string): boolean[] {
  const inQuote: boolean[] = new Array(text.length).fill(false);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\"") quoted = !quoted;
    inQuote[i] = quoted;
  }
  return inQuote;
}

/** Splits on connectors outside quotes. With `includeRemainder` false the
 *  trailing partial clause is left out and `lastStart` points at it, so a
 *  clause can be extended through its dictated body. */
function splitOnConnectors(
  text: string,
  inQuote: boolean[],
  includeRemainder = true,
): { parts: string[]; lastStart: number } {
  const parts: string[] = [];
  let cursor = 0;
  let lastStart = 0;
  const re = new RegExp(CONNECTORS.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (inQuote[m.index]) continue;
    parts.push(text.slice(cursor, m.index).trim());
    cursor = m.index + m[0].length;
    lastStart = cursor;
  }
  if (includeRemainder) parts.push(text.slice(cursor).trim());
  return { parts, lastStart };
}

/** Splits an utterance into clauses on connectors. A note body marker opens
 *  dictated text: unquoted, the body runs to the end of the utterance;
 *  quoted, it runs to the closing quote and text after that parses as its own
 *  clauses again. Either way, connectors inside the body never split into
 *  accidental commands. */
export function splitFlowClauses(text: string): string[] {
  const inQuote = quoteMap(text);
  BODY_MARKER.lastIndex = 0;
  let marker: RegExpExecArray | null = null;
  let found: RegExpExecArray | null;
  while ((found = BODY_MARKER.exec(text)) !== null) {
    if (!inQuote[found.index]) {
      marker = found;
      break;
    }
  }
  if (!marker) return splitOnConnectors(text, inQuote).parts.filter((p) => p.length > 0);
  const head = text.slice(0, marker.index);
  const { parts, lastStart } = splitOnConnectors(head, inQuote, false);
  const body = text.slice(marker.index + marker[0].length);
  let endRegion = text.length;
  if (body.startsWith("\"")) {
    const close = body.indexOf("\"", 1);
    if (close >= 0) endRegion = marker.index + marker[0].length + close + 1;
  }
  parts.push(text.slice(lastStart, endRegion).trim());
  if (endRegion < text.length) {
    parts.push(...splitOnConnectors(text.slice(endRegion), quoteMap(text.slice(endRegion))).parts);
  }
  return parts.filter((p) => p.length > 0);
}

/** Splits a stable utterance into clauses and parses each into an ordered plan
 * with dependency edges so steps run in the order they were spoken. Returns
 * null when no clause is a Flow command, which keeps dictation and the agent
 * path untouched. A mixed request, a negated command or an unclear clause is
 * clarified as a whole: a recognized action never runs while another clause
 * is silently dropped. */
export function parseFlowCommand(
  text: string,
  generation: number,
  ctx: FlowGrammarContext,
): FlowParseResult {
  const clean = text.trim();
  if (!clean) return null;
  const clauses = splitFlowClauses(clean);
  if (clauses.length === 0) return null;

  const parsed: (FlowClause | null)[] = clauses.map((clause) => {
    if (NEGATED_COMMAND.test(clause)) return { kind: "negated" };
    return parseFlowClause(clause, ctx);
  });

  // No clause is a command: this is dictation or chat, not Flow.
  if (!parsed.some((p) => p != null)) return null;

  // A negated command never runs, and the whole request is clarified instead
  // of executing the clauses that were not negated.
  if (parsed.some((p) => p?.kind === "negated")) {
    return {
      kind: "unclear",
      message: "Nothing ran: that request asked me not to. Say only what you want done.",
    };
  }

  // One unrecognized clause among recognized ones is a mixed request. The
  // whole request is clarified; nothing dispatches, so a dropped request is
  // never silently ignored.
  if (parsed.some((p) => p === null)) {
    return {
      kind: "unclear",
      message: "I understood only part of that, so I ran nothing. Say one supported action at a time.",
    };
  }

  for (const clause of parsed) {
    if (clause?.kind === "ambiguous") {
      return { kind: "ambiguous", options: clause.options, message: clause.message };
    }
    if (clause?.kind === "unclear") {
      return { kind: "unclear", message: clause.message };
    }
  }

  const steps: FlowStepRequest[] = parsed.map((clause) =>
    (clause as { kind: "step"; step: FlowStepRequest }).step);

  // Chain steps so each waits on the previous, preserving spoken order. This
  // reuses the planner's dependency model, so a failure stops the rest.
  for (let i = 1; i < steps.length; i++) {
    steps[i] = { ...steps[i], after: [`f${i}`] };
  }
  return { kind: "plan", request: { generation, steps } };
}

/** Correction phrases that retarget a pending note step. Bounded and explicit. */
const CORRECTION_TO = /^(?:no[,.]?\s+)?(?:actually[,.]?\s+)?(?:make\s+it|call\s+it|name\s+it|rename\s+(?:the\s+)?note\s+to)\s+(.+)$/i;

/** The planned id of a request step: declared ids win, else the planner's
 *  exact-once id by declaration position. */
function requestStepId(step: FlowStepRequest, index: number): string {
  const declared = typeof step?.id === "string" ? step.id.trim() : "";
  return declared || flowStepId(index);
}

/**
 * Applies a spoken correction to the not-yet-run steps of a plan, checking
 * each step's real state. A pending note step may be retitled in place; a
 * step already in flight is never rewritten under its dispatch; and a
 * completed note is never rewritten either. A completed note gets a distinct
 * rename step instead, which the queue then verifies by readback. Returns the
 * corrected request and a note, or null when the correction does not apply.
 */
export function applyFlowCorrection(
  request: FlowPlanRequest,
  correctionText: string,
  states: Record<string, FlowStepState> = {},
): { request: FlowPlanRequest; note: string } | null {
  const clean = correctionText.trim();
  const match = clean.match(CORRECTION_TO);
  if (!match) return null;
  const newTitle = stripArticle(match[1].trim());
  if (!newTitle || /[<>:"/\\|?*]/.test(newTitle)) return null;
  // Find the last note step; earlier ones may already have run.
  const idx = request.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "note.create" || s.kind === "note.rename")
    .pop();
  if (!idx) return null;
  const plannedId = requestStepId(idx.s, idx.i);
  const state = states[plannedId] ?? "pending";
  // A completed note is never rewritten. The correction becomes a distinct
  // rename step that waits on the completed one, so it runs through the queue
  // and is verified by readback like any other rename.
  if (state === "completed" || state === "dispatched") {
    const steps: FlowStepRequest[] = [
      ...request.steps,
      { kind: "note.rename", target: SESSION_NOTE_REF, value: newTitle, after: [plannedId] },
    ];
    return {
      request: { generation: request.generation, steps },
      note: `Renaming the note to ${newTitle}.`,
    };
  }
  // An in-flight step is being dispatched right now; rewriting it under the
  // dispatch would make the receipt a lie.
  if (state === "running") return null;
  // Correct pending operations only: a pending rename retargets its value,
  // which is what the adapter reads, never its target reference.
  const steps = request.steps.map((step, i) => {
    if (i !== idx.i) return step;
    if (step.kind === "note.rename") return { ...step, value: newTitle };
    return { ...step, target: newTitle };
  });
  return {
    request: { generation: request.generation, steps },
    note: `Renaming the note to ${newTitle}.`,
  };
}

/** True when a kind is a registered capability, or one of the six stable ids
 *  when no registry is given. Re-exported so callers do not reach into flow.ts
 *  for the guard. */
export function isSupportedFlowKind(kind: string, registry?: FlowCapabilityRegistry | null): boolean {
  if (registry) return registry.has(kind);
  return (FLOW_STEP_KINDS as readonly string[]).includes(kind);
}
