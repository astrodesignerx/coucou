// Choom Flow: structured plans from typed requests. Pure queue logic, no
// microphone, no network and no Tauri calls. Exact-once step ids, dependency
// ordering, receipts and generation ownership live here so the voice deck and
// the native runner share one model. A model response never becomes
// executable code: only a validated typed request reaches a plan, and only a
// registered capability dispatches. With a FlowCapabilityRegistry the queue
// enforces each capability's readiness, approval and verification policy; the
// executors themselves are bound at adapter registration, so this file never
// grows a switch per adapter.

import {
  defaultFlowContext,
  type FlowCapability,
  type FlowCapabilityContext,
  type FlowCapabilityRegistry,
} from "./flowRegistry";

type FlowVerificationPolicy = FlowCapability["verification"];

/** The six stable Flow ids that existed before the capability registry.
 *  Registration adds media and routine ids; unknown ids never plan. */
export const FLOW_STEP_KINDS = [
  "note.create",
  "note.rename",
  "app.launch",
  "folder.open",
  "browser.search",
  "browser.open",
] as const;

export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

export function isFlowStepKind(kind: string): kind is FlowStepKind {
  return (FLOW_STEP_KINDS as readonly string[]).includes(kind);
}

/**
 * Receipt state for one step. Pending is pre-dispatch, running is in flight.
 * Completed carries destination proof. Dispatched means the action was sent but
 * no destination proof was available, so it is never reported as a verified
 * success. Awaiting is waiting for an explicit click; it is never a memoized
 * terminal execution, so a later Run click resumes without repeating steps.
 */
export type FlowStepState =
  | "pending"
  | "running"
  | "completed"
  | "dispatched"
  | "awaiting"
  | "failed"
  | "cancelled";

/** One validated typed step request. `after` names dependencies by step id. */
export interface FlowStepRequest {
  id?: string;
  kind: string;
  target: string;
  value?: string;
  after?: string[];
}

/** A planned step: kind validated against the registry, ordered, with a
 *  stable exact-once id. The kind is a registered capability id, which may be
 *  one of the six stable ids or any later registered capability. */
export interface FlowPlanStep {
  id: string;
  kind: string;
  target: string;
  value: string | null;
  after: string[];
}

export interface FlowPlanRequest {
  generation: number;
  steps: FlowStepRequest[];
}

export interface FlowPlan {
  generation: number;
  steps: FlowPlanStep[];
  createdAtMs: number;
}

export interface FlowStepReceipt {
  id: string;
  kind: string;
  state: FlowStepState;
  message: string;
  /** Destination evidence such as a written path. Null when the dispatch ran
   *  without proof, which pairs with verified false. */
  evidence: string | null;
  /** True only when the dispatch returned destination proof. A resolved
   *  dispatch promise on its own never sets this. */
  verified: boolean;
}

export interface FlowPlanReceipt {
  generation: number;
  steps: FlowStepReceipt[];
  /** True when cancellation stopped the run before every step dispatched. */
  stopped: boolean;
  finishedAtMs: number;
}

export interface FlowPlanResult {
  plan: FlowPlan | null;
  error: string | null;
}

/** Bounded plan size: a spoken or typed request never runs unbounded work. */
export const MAX_FLOW_STEPS = 12;
/** Plans waiting for or holding the single execution slot on one session.
 * Speech, routines, typed commands and media all share it, so this is the
 * bound on everything the session can have outstanding at once. */
export const MAX_QUEUED_PLANS = 8;

/** Receipt for a plan refused at admission. Every step is named, so the
 * card shows exactly what did not run instead of a silent drop. */
function refusedReceipt(plan: FlowPlan, finishedAtMs: number): FlowPlanReceipt {
  return {
    generation: plan.generation,
    stopped: false,
    finishedAtMs,
    steps: plan.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      state: "failed" as const,
      message: "Too many actions are waiting. Stop and try again.",
      evidence: null,
      verified: false,
    })),
  };
}

/** Step id limit mirrors the backend id contract. */
const MAX_ID_LEN = 32;

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && id.length <= MAX_ID_LEN;
}

function clean(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Deterministic exact-once id from declaration position. The same request
 *  always plans the same ids, and no two steps in a plan collide. */
export function flowStepId(index: number): string {
  return `f${index + 1}`;
}

/**
 * Builds an ordered plan from a typed request. Steps keep their declared
 * order, `after` edges only reorder around real dependencies, and unknown or
 * unregistered kinds, invalid parameters, empty targets, dangling or cyclic
 * dependencies all fail the whole plan with an actionable message instead of
 * a partial run. With a registry, a step must name a registered capability
 * and pass its parameter validator.
 */
export function planFromRequest(
  request: FlowPlanRequest,
  nowMs = Date.now(),
  registry: FlowCapabilityRegistry | null = null,
): FlowPlanResult {
  const raw = Array.isArray(request?.steps) ? request.steps : [];
  if (raw.length === 0) {
    return { plan: null, error: "That request has no steps to run." };
  }
  if (raw.length > MAX_FLOW_STEPS) {
    return { plan: null, error: `A request can hold at most ${MAX_FLOW_STEPS} steps.` };
  }
  if (!Number.isFinite(request.generation) || request.generation < 0) {
    return { plan: null, error: "That request has no valid turn." };
  }

  const steps: FlowPlanStep[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rawStep = raw[i];
    const kind = typeof rawStep?.kind === "string" ? rawStep.kind.trim() : "";
    if (registry) {
      // With a registry the queue only plans registered capabilities, each
      // validated by its own parameter validator. Unknown ids never plan.
      const capability = registry.get(kind);
      if (!capability) {
        return { plan: null, error: `Step ${i + 1} uses an unsupported action.` };
      }
      const target = clean(rawStep?.target);
      const value = clean(rawStep?.value);
      const check = capability.validate({ target: target ?? "", value });
      if (check.ok === false) {
        return { plan: null, error: `Step ${i + 1} (${capability.label}) is invalid: ${check.reason}` };
      }
    } else if (!isFlowStepKind(kind)) {
      return { plan: null, error: `Step ${i + 1} uses an unsupported action.` };
    }
    const target = clean(rawStep?.target);
    if (!target) {
      return { plan: null, error: `Step ${i + 1} has no target.` };
    }
    const declared = clean(rawStep?.id);
    const id = declared ?? flowStepId(i);
    if (!isValidId(id)) {
      return { plan: null, error: `Step ${i + 1} has an invalid id.` };
    }
    if (seen.has(id)) {
      return { plan: null, error: `Step id "${id}" is used twice.` };
    }
    seen.add(id);
    steps.push({ id, kind, target, value: clean(rawStep?.value), after: [] });
  }

  // Resolve `after` edges against declared ids only. A step may name itself
  // only through a real cycle, which the ordering below rejects.
  for (let i = 0; i < raw.length; i++) {
    const after = raw[i]?.after;
    const edges: string[] = Array.isArray(after) ? after : [];
    for (const ref of edges) {
      const dep = typeof ref === "string" ? ref.trim() : "";
      if (!dep || !seen.has(dep)) {
        return { plan: null, error: `Step ${i + 1} waits on a step that is not in the request.` };
      }
      if (dep === steps[i].id) {
        return { plan: null, error: `Step ${i + 1} cannot wait on itself.` };
      }
      if (!steps[i].after.includes(dep)) steps[i].after.push(dep);
    }
  }

  const ordered = orderSteps(steps);
  if (!ordered) {
    return { plan: null, error: "Those steps wait on each other in a loop." };
  }
  return { plan: { generation: request.generation, steps: ordered, createdAtMs: nowMs }, error: null };
}

/**
 * Deterministic topological order: Kahn's algorithm with declaration order as
 * the tie-break, so independent steps keep the order the user spoke or typed.
 * Returns null when a dependency loop remains.
 */
export function orderSteps(steps: FlowPlanStep[]): FlowPlanStep[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const orderIndex = new Map(steps.map((s, i) => [s.id, i]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.after.length);
    for (const dep of step.after) {
      if (!byId.has(dep)) return null;
      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }
  const ready = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const out: FlowPlanStep[] = [];
  while (ready.length > 0) {
    // Among runnable steps, take the one the user declared first, so an
    // independent step never jumps ahead of earlier spoken work.
    let pick = 0;
    for (let i = 1; i < ready.length; i++) {
      if ((orderIndex.get(ready[i]) ?? 0) < (orderIndex.get(ready[pick]) ?? 0)) pick = i;
    }
    const id = ready.splice(pick, 1)[0];
    const step = byId.get(id);
    if (!step) return null;
    out.push(step);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return out.length === steps.length ? out : null;
}

/** Late plans and receipts never act on a newer turn. */
export function isFlowStale(currentGeneration: number, planGeneration: number): boolean {
  return currentGeneration !== planGeneration;
}

/**
 * A dependency is satisfied once its step was dispatched, with or without
 * destination proof. The action was actually sent, so a dependent may proceed,
 * but a dispatched dependency is never reported as a verified success.
 */
export function dependencySatisfied(state: FlowStepState): boolean {
  return state === "completed" || state === "dispatched";
}

/** Counts for the card and the settings summary. Every step lands in exactly
 *  one bucket, so the receipt always accounts for the whole plan. */
export function planSummary(receipt: FlowPlanReceipt): {
  completed: number;
  dispatched: number;
  awaiting: number;
  pending: number;
  failed: number;
  cancelled: number;
  total: number;
} {
  const counts = {
    completed: 0,
    dispatched: 0,
    awaiting: 0,
    pending: 0,
    failed: 0,
    cancelled: 0,
    total: receipt.steps.length,
  };
  for (const step of receipt.steps) {
    if (step.state === "completed") counts.completed++;
    else if (step.state === "dispatched") counts.dispatched++;
    else if (step.state === "awaiting") counts.awaiting++;
    else if (step.state === "failed") counts.failed++;
    else if (step.state === "cancelled") counts.cancelled++;
    else counts.pending++;
  }
  return counts;
}

/** One line of card copy for a plan receipt, bounded and single line. An
 *  unverified dispatch is named as such, never folded into a success, and a
 *  step waiting for a click is named as waiting, never as a failure. */
export function formatPlanReceipt(receipt: FlowPlanReceipt, maxChars = 140): string {
  const s = planSummary(receipt);
  if (s.failed > 0) {
    const first = receipt.steps.find((step) => step.state === "failed");
    return `Stopped at ${first?.id ?? "a step"}: ${first?.message ?? "a step failed."}`
      .slice(0, maxChars);
  }
  if (receipt.stopped) {
    return `${s.completed} done, ${s.cancelled} stopped by you.`.slice(0, maxChars);
  }
  if (s.awaiting > 0) {
    return `${s.completed} done, ${s.awaiting} waiting for your click.`.slice(0, maxChars);
  }
  if (s.dispatched > 0) {
    return `${s.completed} done, ${s.dispatched} sent without proof.`.slice(0, maxChars);
  }
  return `Ran ${s.completed} of ${s.total} step(s).`.slice(0, maxChars);
}

/**
 * Dispatches one planned step and returns destination evidence, or null when
 *  the action ran but no proof of the destination is available. Throws on a
 *  real failure; the runner records that as a failed receipt. A runner that
 *  carries a registry is capability driven: the queue runs the capability's
 *  readiness and approval checks and calls its bound executor, and dispatch
 *  stays only as the fallback for registry-less test runners.
 */
export interface FlowRunner {
  /** Fallback executor for runners that carry no registry. */
  dispatch?: (step: FlowPlanStep, generation: number) => Promise<string | null>;
  /** True once this generation was cancelled or superseded. */
  cancelled: (generation: number) => boolean;
  /** The capability registry this run validates and executes against. */
  registry?: FlowCapabilityRegistry;
  /** Readiness context. Without it the queue skips readiness checks. */
  context?: () => FlowCapabilityContext | null;
  /** True when the user explicitly approved this step (a Run click). */
  approved?: (step: FlowPlanStep) => boolean;
  onStep?: (step: FlowPlanStep, receipt: FlowStepReceipt | null) => void;
}

/** A settled or in-flight execution for one step inside one generation. */
interface FlowStepRecord {
  id: string;
  /** Set once the dispatch settles; the memoized receipt to reuse. */
  receipt: FlowStepReceipt | null;
  /** Shared promise while a dispatch is in flight, so a concurrent caller
   *  joins this execution instead of starting a second one. */
  inflight: Promise<FlowStepReceipt> | null;
}

/** Step identity for memoization: generation owns the map, and id plus kind
 *  plus target distinguishes two different steps that share a short id. */
function stepKey(step: FlowPlanStep): string {
  return `${step.id}\u0000${step.kind}\u0000${step.target}`;
}

/**
 * A resolved dispatch with no proof is an unverified dispatch, not a success.
 * A capability whose verification policy is dispatch never reports verified,
 * even if its executor returned a string: app and browser dispatch alone is
 * not destination proof. Readback capabilities report completed only with
 * real evidence such as the bytes read back from a written note.
 */
function verdictFor(
  step: FlowPlanStep,
  proof: string | null,
  verification: FlowVerificationPolicy | null,
): FlowStepReceipt {
  if (proof != null && proof.length > 0 && verification !== "dispatch") {
    return {
      id: step.id,
      kind: step.kind,
      state: "completed",
      message: "Done.",
      evidence: proof,
      verified: true,
    };
  }
  return {
    id: step.id,
    kind: step.kind,
    state: "dispatched",
    message: "Sent, not verified.",
    evidence: null,
    verified: false,
  };
}

function failureFor(step: FlowPlanStep, err: unknown): FlowStepReceipt {
  return {
    id: step.id,
    kind: step.kind,
    state: "failed",
    message: String(err).replace(/^Error:\s*/, ""),
    evidence: null,
    verified: false,
  };
}

function cancelledFor(step: FlowPlanStep, message: string): FlowStepReceipt {
  return {
    id: step.id,
    kind: step.kind,
    state: "cancelled",
    message,
    evidence: null,
    verified: false,
  };
}

/** Waiting for an explicit click. Never memoized, so the click later resumes
 *  the plan without repeating steps that already ran. */
function awaitingFor(step: FlowPlanStep): FlowStepReceipt {
  return {
    id: step.id,
    kind: step.kind,
    state: "awaiting",
    message: "Waiting for your click.",
    evidence: null,
    verified: false,
  };
}

/**
 * The one error that supports "stopped before it ran". An executor throws
 * this only when it cancelled itself before sending any side effect, checked
 * immediately before dispatch. Any other error, even one raised after Stop
 * landed, stays a failure: the queue can never claim work did not happen when
 * all it saw was a generic throw.
 */
export class FlowPreDispatchCancelled extends Error {
  readonly preDispatchCancelled = true;
  constructor(message = "Stopped before it ran.") {
    super(message);
    this.name = "FlowPreDispatchCancelled";
  }
}

export function isFlowPreDispatchCancelled(err: unknown): boolean {
  return !!err && typeof err === "object"
    && (err as { preDispatchCancelled?: boolean }).preDispatchCancelled === true;
}

/**
 * Session-owned execution tracking. One session holds every generation's step
 * receipts, so replaying or extending a plan reuses what already ran instead of
 * dispatching it twice. A fresh session starts empty and resets cleanly. Keys
 * are per generation, so a new turn may reuse ids like f1 without colliding.
 */
export class FlowSession {
  private generations = new Map<number, Map<string, FlowStepRecord>>();
  private readonly defaultRegistry: FlowCapabilityRegistry | null;
  /** Ordered admission for this session. Every plan that runs here goes
   * through one queue, so continuous speech, routines, typed commands, media
   * and direct tool routes all share the same ordering instead of running at
   * the same time. It is a gate, not a second executor: the plan still runs
   * below exactly as before, once admitted. */
  private admission: Promise<void> = Promise.resolve();
  private admitted = 0;

  /** The default registry is used by runs whose runner carries none. */
  constructor(defaultRegistry: FlowCapabilityRegistry | null = null) {
    this.defaultRegistry = defaultRegistry;
  }

  /** Plans waiting for or holding the single execution slot. */
  get queued(): number {
    return this.admitted;
  }

  private recordsFor(generation: number): Map<string, FlowStepRecord> {
    let records = this.generations.get(generation);
    if (!records) {
      records = new Map();
      this.generations.set(generation, records);
    }
    return records;
  }

  /** Receipt for a step if it already ran in this generation, else null. */
  receiptFor(generation: number, step: FlowPlanStep): FlowStepReceipt | null {
    return this.generations.get(generation)?.get(stepKey(step))?.receipt ?? null;
  }

  /** Forget one generation. Other generations and the session survive. */
  resetGeneration(generation: number): void {
    this.generations.delete(generation);
  }

  /** Forget every generation: a brand new session's state. */
  reset(): void {
    this.generations.clear();
  }

  /** Memoized receipt states of one generation, keyed by step id. A spoken
   *  correction uses this to tell a pending step from one that already ran. */
  statesFor(generation: number): Record<string, FlowStepState> {
    const out: Record<string, FlowStepState> = {};
    const records = this.generations.get(generation);
    if (!records) return out;
    for (const record of records.values()) {
      if (record.receipt) out[record.receipt.id] = record.receipt.state;
      else out[record.id] = "running";
    }
    return out;
  }

  /**
   * Runs one step through its capability executor when the run is capability
   *  driven, else through the runner's fallback dispatch. Returns the proof
   *  string plus the capability's verification policy so the verdict can
   *  stay honest about what was proven.
   */
  private async dispatch(
    step: FlowPlanStep,
    generation: number,
    runner: FlowRunner,
    capability: Pick<FlowCapability, "verification" | "execute"> | null,
    context: FlowCapabilityContext,
  ): Promise<{ proof: string | null; verification: FlowVerificationPolicy | null }> {
    if (capability?.execute) {
      const proof = await capability.execute(step, context, generation);
      return { proof, verification: capability.verification };
    }
    if (!runner.dispatch) {
      throw new Error("That action has no executor wired up on this device.");
    }
    const proof = await runner.dispatch(step, generation);
    return { proof, verification: null };
  }

  private async execute(
    step: FlowPlanStep,
    generation: number,
    runner: FlowRunner,
    capability: Pick<FlowCapability, "verification" | "execute"> | null,
    context: FlowCapabilityContext,
  ): Promise<FlowStepReceipt> {
    try {
      const outcome = await this.dispatch(step, generation, runner, capability, context);
      return verdictFor(step, outcome.proof, outcome.verification);
    } catch (err) {
      // Only the executor's own pre-dispatch cancellation signal may claim the
      // step never ran. A generic error, even one raised after Stop landed
      // while verifying work that was already sent, stays a failed receipt
      // that is memoized and never auto-replayed.
      if (runner.cancelled(generation) && isFlowPreDispatchCancelled(err)) {
        return cancelledFor(step, "Stopped before it ran.");
      }
      return failureFor(step, err);
    }
  }

  /**
   * Runs a plan in dependency order under one generation, reusing this
   * session's receipts. A step whose dependency neither completed nor
   * dispatched is cancelled without dispatching, so a failure never cascades
   * into blind work. A step already run, or running now, is reused rather than
   * dispatched again. Cancellation stops future dispatches at the next
   * boundary; an already dispatched step reports what actually happened.
   */
  /**
   * Admits a plan to the session's single execution slot and runs it there.
   *
   * Admission is ordered and bounded: one plan executes at a time, so a spoken
   * command, a routine and a typed action can never interleave their side
   * effects. A concurrent replay of the SAME plan is not a second execution:
   * once admitted it finds its steps already memoized and reuses their
   * receipts. Going past the bound is refused with an honest failed receipt
   * rather than an unbounded promise chain.
   */
  run(
    plan: FlowPlan,
    runner: FlowRunner,
    nowMs = Date.now,
  ): Promise<FlowPlanReceipt> {
    // Nothing is running: start now. The gate must not add a scheduling hop
    // to an idle session, so the first plan executes exactly as it did before
    // admission existed. It still claims the slot, and it publishes the gate
    // that the NEXT plan will chain on, so a later caller cannot slip past it.
    if (this.admitted === 0) {
      let release: () => void = () => {};
      this.admission = new Promise<void>((resolve) => { release = resolve; });
      this.admitted += 1;
      return this.runAdmitted(plan, runner, nowMs).finally(() => {
        this.admitted -= 1;
        release();
      });
    }
    const gate = this.admission;
    let release: () => void = () => {};
    this.admission = new Promise<void>((resolve) => { release = resolve; });
    this.admitted += 1;
    if (this.admitted > MAX_QUEUED_PLANS) {
      this.admitted -= 1;
      release();
      const at = typeof nowMs === "function" ? nowMs() : Date.now();
      return Promise.resolve(refusedReceipt(plan, at));
    }
    return gate
      .then(() => this.runAdmitted(plan, runner, nowMs))
      .finally(() => {
        this.admitted -= 1;
        release();
      });
  }

  private async runAdmitted(
    plan: FlowPlan,
    runner: FlowRunner,
    nowMs = Date.now,
  ): Promise<FlowPlanReceipt> {
    const records = this.recordsFor(plan.generation);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    // Per-run cancellations and approvals are computed fresh and never
    // memoized, so a later run whose dependency now succeeds, or whose click
    // arrived, is not stuck behind an old skip.
    const overrides = new Map<string, FlowStepReceipt>();
    const registry = runner.registry ?? this.defaultRegistry;
    const context = runner.context?.() ?? defaultFlowContext();
    let stopped = false;

    for (const step of plan.steps) {
      if (runner.cancelled(plan.generation)) {
        stopped = true;
        overrides.set(step.id, cancelledFor(step, "Stopped before this step ran."));
        continue;
      }
      const blockedBy = step.after.find((depId) => {
        const dep = byId.get(depId);
        const state = dep ? this.receiptFor(plan.generation, dep)?.state : undefined;
        return state == null || !dependencySatisfied(state);
      });
      if (blockedBy) {
        overrides.set(step.id, cancelledFor(step, "Skipped because an earlier step did not finish."));
        continue;
      }
      const key = stepKey(step);
      const existing = records.get(key);
      if (existing?.receipt) {
        // Already ran in this session: reuse it, never dispatch twice.
        continue;
      }
      if (existing?.inflight) {
        // Concurrent replay joins the shared dispatch instead of repeating it.
        await existing.inflight;
        if (runner.cancelled(plan.generation)) stopped = true;
        continue;
      }
      // Capability driven runs resolve the capability before any side effect.
      // An unregistered action fails here, before dispatch, never partway.
      let capability = null as ReturnType<FlowCapabilityRegistry["get"]>;
      if (registry) {
        capability = registry.get(step.kind);
        if (!capability) {
          overrides.set(step.id, failureFor(step, new Error("That action is not a registered capability.")));
          continue;
        }
        // Offline is per capability, independent of any speech engine: only
        // capabilities that need the network become unavailable.
        if (!context.online && !capability.offline) {
          overrides.set(
            step.id,
            failureFor(step, new Error(`${capability.label} needs an internet connection.`)),
          );
          continue;
        }
        // Readiness surfaces missing or broken configuration as an honest
        // unavailable failure instead of a blind dispatch.
        if (runner.context) {
          const readiness = capability.readiness(context, step);
          if (!readiness.ready) {
            overrides.set(
              step.id,
              failureFor(step, new Error(readiness.reason || `${capability.label} is not ready.`)),
            );
            continue;
          }
        }
        // An explicit-approval step without its click waits; the wait is not
        // a terminal execution, so a later Run click resumes the plan.
        if (capability.approval === "explicit" && !(runner.approved?.(step) ?? false)) {
          overrides.set(step.id, awaitingFor(step));
          continue;
        }
      }
      const running: FlowStepRecord = { id: step.id, receipt: null, inflight: null };
      records.set(key, running);
      runner.onStep?.(step, null);
      const execution = this.execute(
        step,
        plan.generation,
        runner,
        capability
          ? { verification: capability.verification, execute: capability.execute }
          : null,
        context,
      );
      running.inflight = execution;
      const receipt = await execution;
      const record = records.get(key);
      if (record) {
        record.receipt = receipt;
        record.inflight = null;
      }
      runner.onStep?.(step, receipt);
      if (runner.cancelled(plan.generation)) stopped = true;
    }

    const steps: FlowStepReceipt[] = plan.steps.map((step) => {
      const settled = this.receiptFor(plan.generation, step);
      if (settled) return settled;
      const override = overrides.get(step.id);
      if (override) return override;
      return cancelledFor(step, "Did not run.");
    });
    return { generation: plan.generation, steps, stopped, finishedAtMs: nowMs() };
  }
}

/** Runs a plan against a session. Without an explicit session a fresh one is
 *  used, which runs the whole plan; pass a shared session to make replay and
 *  cumulative speech plans reuse what already ran. */
export async function runFlowPlan(
  plan: FlowPlan,
  runner: FlowRunner,
  nowMs = Date.now,
  session: FlowSession = new FlowSession(),
): Promise<FlowPlanReceipt> {
  return session.run(plan, runner, nowMs);
}
