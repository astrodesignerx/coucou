// Stable-clause tracker for continuous Flow speech.
//
// Continuous capture keeps one microphone open and produces a stream of
// bounded snapshots (live captions) followed by one sealed final per
// utterance. A snapshot is a guess about speech that is still being said, so
// it may only dispatch a command once the same complete clause prefix has
// survived a short correction window across newer snapshots. A final is
// authoritative: it commits complete clauses and can extend what the
// snapshots already dispatched, but it never replays them.
//
// This module is pure and deterministic. It never runs a capability, never
// touches the DOM and never owns a timer: it turns ordered snapshots and
// finals into batches of Flow steps for the existing FlowSession queue, which
// stays the only executor. Everything it refuses, it refuses by asking the
// existing grammar first, so the reason shown to the user is the grammar's
// own wording and never invented here.

import { parseFlowCommand, type FlowGrammarContext } from "./flowGrammar";
import type { FlowStepRequest } from "./flow";

/** How many consecutive newer snapshots must agree on a complete clause
 * prefix before a provisional command is dispatched. Two is the smallest
 * window that can tell a settled clause from a half-spoken one. */
export const SNAPSHOT_STRIKES = 2;

/** One observation from the helper. Utterance and sequence come straight from
 * the native event and are the only identity the tracker trusts. */
export interface ClauseSnapshot {
  utterance: number;
  sequence: number;
  text: string;
}

export type ClauseHoldReason =
  /** Nothing has been said yet in this utterance. */
  | "no-speech"
  /** The snapshot is for an utterance the tracker has already left. */
  | "stale"
  /** The same snapshot arrived twice. */
  | "duplicate"
  /** The clause prefix is not stable across newer snapshots yet. */
  | "unstable"
  /** Every complete clause in this snapshot already ran for this utterance. */
  | "replayed";

interface VerdictStamp {
  utterance: number;
  sequence: number;
  final: boolean;
}

/** What the tracker decided about one snapshot. */
export type ClauseVerdict =
  /** The utterance is not a Flow command at all: dictation or the agent. */
  | ({ kind: "not-flow" } & VerdictStamp)
  /** A provisional or final snapshot that decided nothing yet. */
  | ({ kind: "hold"; reason: ClauseHoldReason } & VerdictStamp)
  /** Work to admit to the queue. */
  | ({
      kind: "dispatch";
      /** Steps in spoken order. The first may re-anchor on the previous
       * batch's last step so a dependency failure still stops the chain. */
      steps: FlowStepRequest[];
      /** The clause text this batch came from, for the receipt line. */
      text: string;
    } & VerdictStamp)
  /** The grammar already decided this request must not run. The message is
   * the grammar's own wording and is shown as it stands. */
  | ({ kind: "refuse"; message: string } & VerdictStamp);

function stamp(snapshot: ClauseSnapshot, final: boolean): VerdictStamp {
  return { utterance: snapshot.utterance, sequence: snapshot.sequence, final };
}

function hold(reason: ClauseHoldReason, snapshot: ClauseSnapshot, final: boolean): ClauseVerdict {
  return { kind: "hold", reason, ...stamp(snapshot, final) };
}

/** A step's identity for prefix comparison: what it does and where it points.
 * The declared id is deliberately excluded, because the tracker assigns one
 * per emission and the grammar does not. */
function stepIdentity(step: FlowStepRequest): string {
  return `${step.kind}|${step.target}|${step.value ?? ""}`;
}

/** True when `previous` is a prefix of `next`, equality included. This is the
 * whole correction window: a clause still being spoken either changes or stops
 * parsing as a step, and only a stable prefix survives. */
function isPrefixOf(next: string[], previous: string[]): boolean {
  if (previous.length > next.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (next[i] !== previous[i]) return false;
  }
  return true;
}

/** True when the snapshot text actually contains `name` as a whole word.
 * This is how a provisional dispatch tells a finished target from a half
 * spoken one: the saved shortcut "Code" is matched by "open co" as a
 * substring, but the speaker has not finished saying the name. */
function namesSpokenCompletely(text: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  const hay = text.toLowerCase();
  const isWord = (c: string) => c >= "a" && c <= "z" || c >= "0" && c <= "9";
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 ? " " : hay[at - 1];
    const endAt = at + needle.length;
    const after = endAt >= hay.length ? " " : hay[endAt];
    if (!isWord(before) && !isWord(after)) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/** True when every saved target in the batch was spoken as a complete name.
 *
 * The grammar resolves a saved app or folder by unique substring as well as
 * by exact name, which is right for a sealed utterance but wrong for a live
 * caption: while speech is still arriving, "open co" would claim the saved
 * "Code". A provisional batch therefore has to find the whole name in the
 * text it came from. A sealed final is exempt, because by then the utterance
 * really is over and the transcript is what the user said. */
function targetsSpokenCompletely(
  steps: FlowStepRequest[],
  text: string,
  ctx: FlowGrammarContext,
): boolean {
  for (const step of steps) {
    if (step.kind !== "app.launch" && step.kind !== "folder.open") continue;
    const hit = ctx.shortcuts.find((s) => s.target === step.target);
    if (!hit) return false;
    if (!namesSpokenCompletely(text, hit.name)) return false;
  }
  return true;
}

/** Per-utterance state. Bounded to the utterance the helper has open: a new
 * utterance replaces it wholesale, so memory never grows with session length. */
interface UtteranceState {
  utterance: number;
  /** Steps of this utterance already handed to the queue. */
  emitted: number;
  /** Identities of the last snapshot whose clauses all parsed as steps.
   * Agreement only: a break in the chain clears this and nothing else. */
  lastIdentities: string[] | null;
  /** Identities of the clauses that actually ran. This is the record of what
   * the utterance has already done, and it survives a break in agreement, so
   * a later clause that changed can still be recognised as a change. */
  dispatchedIdentities: string[] | null;
  /** How many consecutive newer snapshots agreed on each clause position.
   * Position i is the agreement count for the i-th complete clause, so a
   * clause that has just appeared starts at zero and must earn its own
   * window instead of inheriting the one before it. */
  strikes: number[];
  /** Every step emitted for this utterance, in spoken order. */
  steps: FlowStepRequest[];
  /** The final for this utterance has already been seen. */
  finished: boolean;
}

/**
 * Tracks one continuous Flow session. One instance per listening session;
 * `begin` and `reset` return it to the state a fresh session must start from.
 */
export class FlowClauseTracker {
  private generation = 0;
  private ctx: FlowGrammarContext | null = null;
  private state: UtteranceState | null = null;
  private lastSequence = 0;

  /** Binds the turn and the configured targets the grammar needs. Saved
   * shortcuts and the notes folder are read once per turn, exactly like the
   * one-shot path does. */
  begin(generation: number, ctx: FlowGrammarContext): void {
    this.generation = generation;
    this.ctx = ctx;
    this.state = null;
    this.lastSequence = 0;
  }

  /** Retires the session. Nothing from before this point may dispatch. */
  reset(): void {
    this.state = null;
    this.lastSequence = 0;
    this.ctx = null;
  }

  /** Steps emitted so far for the utterance the helper has open. */
  emittedSteps(): FlowStepRequest[] {
    return this.state ? this.state.steps.slice() : [];
  }

  /** Handles a live caption. Provisional: it may only dispatch a clause
   * prefix that has survived the correction window. */
  observePartial(snapshot: ClauseSnapshot): ClauseVerdict {
    return this.observe(snapshot, false);
  }

  /** Handles one sealed utterance. Authoritative: it commits every complete
   * clause and extends whatever the snapshots already dispatched. */
  observeFinal(snapshot: ClauseSnapshot): ClauseVerdict {
    return this.observe(snapshot, true);
  }

  private observe(snapshot: ClauseSnapshot, final: boolean): ClauseVerdict {
    const ctx = this.ctx;
    if (!ctx) return hold("no-speech", snapshot, final);

    const utterance = snapshot.utterance;
    const sequence = snapshot.sequence;

    // Identity is checked first, so a malformed or out-of-order observation
    // can never reach the grammar or the queue.
    if (this.state && utterance < this.state.utterance) return hold("stale", snapshot, final);
    if (this.state && utterance === this.state.utterance) {
      if (sequence <= this.lastSequence) return hold("duplicate", snapshot, final);
      if (final && this.state.finished) return hold("duplicate", snapshot, final);
    }
    this.lastSequence = sequence;

    const text = snapshot.text.trim();
    if (!text) return hold("no-speech", snapshot, final);

    const parsed = parseFlowCommand(text, this.generation, ctx);

    // Not a Flow command at all: dictation, chat, or a spoken correction the
    // one-shot path already knows how to apply. The caller falls through.
    // Agreement is reset, so speech that interrupted a matching prefix can
    // never carry that prefix's strikes into what comes next.
    if (!parsed) {
      this.resetAgreement(utterance);
      if (final) this.markFinished(utterance);
      return { kind: "not-flow", ...stamp(snapshot, final) };
    }

    // A refusal is never provisional. A negated command, a mixed unsupported
    // clause, an ambiguous target or an unfinished target must not run, and
    // the grammar's own wording is what the user is told. A live caption
    // that trips this is usually speech still in progress, so it holds
    // quietly and the sealed final is what surfaces the reason.
    if (parsed.kind !== "plan") {
      this.resetAgreement(utterance);
      if (!final) return hold("unstable", snapshot, final);
      this.markFinished(utterance);
      return { kind: "refuse", message: parsed.message, ...stamp(snapshot, final) };
    }

    const steps = parsed.request.steps;
    const state = this.openUtterance(utterance);
    if (!state) return hold("stale", snapshot, final);
    if (steps.length === 0) return hold("unstable", snapshot, final);

    // A clause that has already run and has now CHANGED is not the same
    // instruction twice: re-running it would produce a second side effect for
    // one utterance, and running it under its old receipt would report the
    // wrong thing. The utterance is no longer what was dispatched, so nothing
    // further from it runs and the sealed final says so plainly.
    if (state.emitted > 0 && state.dispatchedIdentities != null) {
      const current = steps.map(stepIdentity);
      for (let i = 0; i < Math.min(state.emitted, current.length); i++) {
        if (current[i] !== state.dispatchedIdentities[i]) {
          if (final) this.markFinished(utterance);
          return {
            kind: "refuse",
            message: "Nothing more ran: that request changed after part of it had already started.",
            ...stamp(snapshot, final),
          };
        }
      }
    }

    if (!final) {
      const identities = steps.map(stepIdentity);
      const previous = state.lastIdentities;
      if (previous == null || !isPrefixOf(identities, previous)) {
        // The clause prefix changed shape. Agreement is counted per clause
        // position: a leading clause that is unchanged keeps the agreement it
        // already earned, while a clause that has just appeared starts at one
        // sighting and has to earn its own window before it may run.
        const carried = previous && isPrefixOf(previous, identities) ? previous.length : 0;
        state.lastIdentities = identities;
        state.strikes = identities.map((_, i) => {
          if (i < carried && previous![i] === identities[i]) return (state.strikes[i] ?? 0) + 1;
          return 1;
        });
      } else {
        state.strikes = identities.map((_, i) => (state.strikes[i] ?? 0) + 1);
      }
      // Only the clauses that have actually settled are dispatched, and only
      // as a contiguous run from what has not run yet. A newly spoken tail
      // clause therefore never rides in on the agreement of the one before it.
      let settledUpTo = state.emitted;
      while (
        settledUpTo < steps.length
        && (state.strikes[settledUpTo] ?? 0) >= SNAPSHOT_STRIKES
      ) settledUpTo += 1;
      if (settledUpTo === state.emitted) {
        // Every clause in this caption already ran: that is a repeat, not a
        // clause still waiting for its window.
        return hold(state.emitted >= steps.length ? "replayed" : "unstable", snapshot, final);
      }
      const candidates = steps.slice(state.emitted, settledUpTo);
      if (!targetsSpokenCompletely(candidates, text, ctx)) {
        return hold("unstable", snapshot, final);
      }
      const batch = this.buildBatch(state, candidates, utterance);
      state.emitted = settledUpTo;
      state.dispatchedIdentities = identities.slice(0, settledUpTo);
      if (final) this.markFinished(utterance);
      return { kind: "dispatch", steps: batch, text, ...stamp(snapshot, final) };
    }

    // A final is authoritative: it commits every complete clause and extends
    // what the snapshots already dispatched, but never replays them.
    const fresh = steps.slice(state.emitted);
    if (fresh.length === 0) {
      this.markFinished(utterance);
      return hold("replayed", snapshot, final);
    }

    const batch = this.buildBatch(state, fresh, utterance);
    state.emitted = steps.length;
    state.lastIdentities = steps.map(stepIdentity);
    state.dispatchedIdentities = state.lastIdentities.slice();
    state.strikes = [];
    this.markFinished(utterance);
    return { kind: "dispatch", steps: batch, text, ...stamp(snapshot, final) };
  }

  /** Include the anchor's dependency closure. Session receipts reuse every
   * earlier step without dispatching it again. */
  private buildBatch(
    state: UtteranceState,
    fresh: FlowStepRequest[],
    utterance: number,
  ): FlowStepRequest[] {
    const batch: FlowStepRequest[] = [];
    let previousId: string | null = null;
    if (state.steps.length > 0) {
      const anchor = state.steps[state.steps.length - 1];
      const needed = new Set<string>();
      const include = (step: FlowStepRequest): void => {
        if (!step.id || needed.has(step.id)) return;
        needed.add(step.id);
        for (const id of step.after ?? []) {
          const dependency = state.steps.find((item) => item.id === id);
          if (dependency) include(dependency);
        }
      };
      include(anchor);
      batch.push(...state.steps.filter((step) => step.id && needed.has(step.id)).map((step) => ({ ...step })));
      previousId = anchor.id ?? null;
    }
    for (const step of fresh) {
      const id = `c${utterance}-${state.steps.length + 1}`;
      const chained: FlowStepRequest = { ...step, id };
      if (previousId != null) chained.after = [previousId];
      else delete chained.after;
      state.steps.push(chained);
      previousId = id;
      batch.push({ ...chained });
    }
    return batch;
  }

  /** Returns the open utterance's state, starting a fresh one when the helper
   * has moved on. The same command spoken in two separate utterances is
   * therefore dispatched once in each, because the state never carries over. */
  private openUtterance(utterance: number): UtteranceState | null {
    if (this.state) {
      if (this.state.utterance === utterance) return this.state;
      if (utterance < this.state.utterance) return null;
    }
    this.state = {
      utterance,
      emitted: 0,
      lastIdentities: null,
      dispatchedIdentities: null,
      strikes: [],
      steps: [],
      finished: false,
    };
    return this.state;
  }

  private markFinished(utterance: number): void {
    if (this.state && this.state.utterance === utterance) this.state.finished = true;
  }

  /** Drops every clause's agreement, and nothing else. Used whenever an
   * observation did not parse as a plan: a refusal, a negation or plain
   * speech all break the chain, so the next matching snapshot has to earn its
   * window from zero. What already ran is untouched. */
  private resetAgreement(utterance: number): void {
    if (!this.state || this.state.utterance !== utterance) return;
    this.state.lastIdentities = null;
    this.state.strikes = [];
  }
}

/** Bounded admission in front of the single FlowSession executor. Decoding
 * and capture keep running while the queue is busy; only the number of
 * commands waiting to be planned is bounded, and going past it is reported
 * honestly rather than dropped. */
export const MAX_PENDING_FLOW_BATCHES = 4;

export interface FlowBatch {
  generation: number;
  steps: FlowStepRequest[];
  text: string;
}

export class FlowAdmission {
  private queue: FlowBatch[] = [];
  /** The generation this queue belongs to. Anything queued from an older
   * turn is dropped, because a superseded turn never dispatches. */
  generation = 0;

  get depth(): number {
    return this.queue.length;
  }

  /** Admits a batch, or returns false when the bound is already reached. */
  admit(batch: FlowBatch): boolean {
    if (this.queue.length >= MAX_PENDING_FLOW_BATCHES) return false;
    this.queue.push(batch);
    return true;
  }

  /** Takes the next batch, oldest first. */
  take(): FlowBatch | null {
    return this.queue.shift() ?? null;
  }

  /** Retires everything: a stop, a routing change or a closed panel clears
   * the queue without running any of it. */
  clear(): void {
    this.queue = [];
  }

  /** Adopts a new turn and drops anything still queued from the old one. */
  setGeneration(generation: number): void {
    if (generation === this.generation) return;
    this.generation = generation;
    this.queue = [];
  }
}
