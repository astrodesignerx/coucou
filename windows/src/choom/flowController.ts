// Flow production controller. Owns the capability registry with its bridge
// executors, one persistent FlowSession for the current listening session and
// the session's note ownership. Adapter closures are bound once at
// registration, so this module never grows a dispatch switch: the queue in
// flow.ts consumes the registry and owns ordering, cancellation, failures and
// receipts. Every native side effect rechecks the generation and session
// fence inside its blocking closure, immediately before dispatch. A stale
// completion is dropped from session context, so a cancelled turn never owns
// a note, while the receipt stays honest about the work already sent.

import { Bridge, type FlowNoteReceipt, type NowPlaying, type RoutineStep } from "../core/bridge";
import { State, type ToolShortcut } from "../core/state";
import {
  FlowPreDispatchCancelled,
  FlowSession,
  planFromRequest,
  type FlowPlan,
  type FlowPlanReceipt,
  type FlowPlanRequest,
  type FlowPlanStep,
  type FlowRunner,
  type FlowStepReceipt,
  type FlowStepState,
} from "./flow";
import { applyFlowCorrection } from "./flowGrammar";
import {
  FLOW_UNAVAILABLE_ADAPTERS,
  SESSION_NOTE_REF,
  createBaseFlowRegistry,
  isFlowMediaAction,
  type FlowCapabilityContext,
  type FlowCapabilityRegistry,
  type FlowMediaAction,
} from "./flowRegistry";

/** The one registry the queue consumes. The six stable Flow ids plus media,
 *  routine, note.open and the read-only context adapters. Executors are bound
 *  below, at adapter registration. */
const registry: FlowCapabilityRegistry = createBaseFlowRegistry();

export function flowRegistry(): FlowCapabilityRegistry {
  return registry;
}

/** The one session that owns the current listening session's Flow work. A new
 *  listening session calls resetSession, which starts clean. */
let session = new FlowSession(registry);

/** Returns the persistent session. Callers must pass this to session.run; the
 *  controller never uses runFlowPlan's implicit fresh session. */
export function flowSession(): FlowSession {
  return session;
}

/** Saved app and folder shortcuts the grammar may resolve launches against. */
export function savedShortcuts(): ToolShortcut[] {
  return State.settings.tools?.shortcuts ?? [];
}

/** Last note path created in this session, so a rename or open targets a note
 *  Flow actually wrote rather than an arbitrary path a model returned. It
 *  survives replay and cumulative turns; only a new session clears it. */
let lastNotePath: string | null = null;

export function notePath(): string | null {
  return lastNotePath;
}

export function clearNotePath(): void {
  lastNotePath = null;
}

/** The last planned request of this session, so a spoken correction applies
 *  to the plan the user is actually editing. */
let lastRequest: FlowPlanRequest | null = null;

export function rememberFlowRequest(request: FlowPlanRequest | null): void {
  lastRequest = request;
}

/** Voice generation fence. The queue's own cancelled flag: cancelFlow
 *  advances it, so queued and late steps read stale. The injected stale check
 *  is the voice turn's own fence; both combine, and the injected callback can
 *  never bypass Stop. */
let voiceGeneration = 0;
let staleCheck: ((gen: number) => boolean) | null = null;

export function setVoiceGeneration(generation: number): void {
  voiceGeneration = generation;
}

export function setStaleCheck(fn: (gen: number) => boolean): void {
  staleCheck = fn;
}

function isVoiceStale(gen: number): boolean {
  if (!State.settings.flowEnabled) return true;
  if (gen !== voiceGeneration) return true;
  if (staleCheck && staleCheck(gen)) return true;
  return false;
}

/** Rechecked inside every executor's blocking closure, immediately before its
 *  side effect, so a Stop that lands after the queue's own check still wins.
 *  This is the explicit pre-dispatch cancellation signal: the queue may only
 *  claim "stopped before it ran" for this, never for a generic error. */
function assertLive(generation: number): void {
  if (isVoiceStale(generation)) throw new FlowPreDispatchCancelled();
}

/** Yields once, then rechecks the fence, then dispatches. The yield gives a
 *  Stop that arrives between the queue's check and the native call a real
 *  chance to be seen here. */
function liveDispatch<T>(generation: number, call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(() => {
    assertLive(generation);
    return call();
  });
}

/** Records the note a completed step produced, unless the turn was cancelled
 *  while the work was in flight: a stale completion is dropped from session
 *  context, so a cancelled turn never owns a note. */
function keepOwnership(path: string, generation: number): void {
  if (!isVoiceStale(generation)) lastNotePath = path;
}

// ── Adapter registration ──────────────────────────────────────────────────
// Bridge-specific executor closures live here, once, never in the queue.

registry.bind("note.create", async (step, _ctx, generation) => {
  const receipt: FlowNoteReceipt = await liveDispatch(generation, () =>
    Bridge.flowNoteCreate(step.target, step.value ?? "", generation));
  keepOwnership(receipt.path, generation);
  return receipt.path;
});

registry.bind("note.rename", async (step, _ctx, generation) => {
  // The step must target this session's own note. The native side enforces
  // the same reference, so nothing can rename an arbitrary path.
  if (step.target !== SESSION_NOTE_REF) {
    throw new Error("There is no note from this turn to rename.");
  }
  const from = lastNotePath;
  if (!from) throw new Error("There is no note from this turn to rename.");
  const receipt: FlowNoteReceipt = await liveDispatch(generation, () =>
    Bridge.flowNoteRename(from, step.value ?? "", generation));
  keepOwnership(receipt.path, generation);
  return receipt.path;
});

registry.bind("note.open", async (step, _ctx, generation) => {
  if (step.target !== SESSION_NOTE_REF) {
    throw new Error("There is no note from this turn to open.");
  }
  const from = lastNotePath;
  if (!from) throw new Error("There is no note from this turn to open.");
  // Opens the owned note in the configured editor. The dispatch is never
  // destination proof, so the receipt stays unverified while the file itself
  // is proven by note readback, not by this action.
  await liveDispatch(generation, () => Bridge.flowNoteOpen(from, generation));
  return null;
});

registry.bind("app.launch", async (step, _ctx, generation) => {
  await liveDispatch(generation, () => Bridge.voiceToolRun("app", step.target, generation, true));
  return null;
});

registry.bind("folder.open", async (step, _ctx, generation) => {
  await liveDispatch(generation, () => Bridge.voiceToolRun("folder", step.target, generation, true));
  return null;
});

registry.bind("browser.search", async (step, _ctx, generation) => {
  await liveDispatch(generation, () => Bridge.flowBrowserSearch(step.target, generation));
  return null;
});

registry.bind("browser.open", async (step, _ctx, generation) => {
  await liveDispatch(generation, () => Bridge.flowBrowserOpen(step.target, generation));
  return null;
});

/** Media is verified only by comparing the actual pre-control and post-control
 *  snapshots. An active snapshot that is unchanged is never proof: pause needs
 *  playing to fall, play needs playing to rise, next and previous need the
 *  track identity (or position) to move, and toggle needs the playing state to
 *  flip. Anything else stays sent without proof, never a success. */
function sameMediaIdentity(a: NowPlaying, b: NowPlaying): boolean {
  return a.title === b.title && a.artist === b.artist && a.app === b.app;
}

async function mediaSnapshotSafe(): Promise<NowPlaying | null> {
  return Bridge.mediaSnapshot().catch(() => null);
}

function mediaVerdict(
  pre: NowPlaying | null,
  post: NowPlaying | null,
  action: FlowMediaAction,
): string | null {
  if (!post || !post.active) return null;
  if (action === "play") {
    return post.playing && (!pre || !pre.playing || !sameMediaIdentity(pre, post))
      ? "Playing." : null;
  }
  if (action === "pause") {
    return !post.playing && !!pre && pre.playing ? "Paused." : null;
  }
  if (action === "toggle") {
    return !!pre && pre.active && pre.playing !== post.playing ? "Playback toggled." : null;
  }
  // next and previous: the track identity or the position must have moved.
  if (pre && pre.active && (!sameMediaIdentity(pre, post) || post.positionMs < pre.positionMs)) {
    return "Track changed.";
  }
  return null;
}

for (const action of ["play", "pause", "next", "previous", "toggle"] as FlowMediaAction[]) {
  registry.bind(`media.${action}`, async (_step, _ctx, generation) => {
    // Snapshot before, fence, control (generation fenced on the watcher
    // thread too), fence, snapshot after: only a real pre/post difference
    // counts as proof.
    const pre = await mediaSnapshotSafe();
    await liveDispatch(generation, () => Bridge.mediaControl(action, undefined, generation));
    const post = await mediaSnapshotSafe();
    if (isVoiceStale(generation)) return null;
    return mediaVerdict(pre, post, action);
  });
}
registry.bind("media.seek", async (step, _ctx, generation) => {
  const ms = Number(step.value ?? step.target);
  const pre = await mediaSnapshotSafe();
  await liveDispatch(generation, () => Bridge.mediaControl("seek", ms, generation));
  const post = await mediaSnapshotSafe();
  if (isVoiceStale(generation)) return null;
  // Proof is the position actually landing near the target, and moving there.
  if (post && post.active && Math.abs(post.positionMs - ms) < 2000
    && (!pre || Math.abs(pre.positionMs - ms) >= 2000)) {
    return "Position set.";
  }
  return null;
});

registry.bind("routine.run", async (step, ctx, generation) => {
  const routine = ctx.routines.find((r) => r.id === step.target);
  if (!routine) throw new Error("That routine is gone. Pick again.");
  const resolved: RoutineStep[] = [];
  for (const id of routine.steps) {
    const shortcut = ctx.shortcuts.find((s) => s.id === id);
    if (!shortcut) throw new Error("A step no longer exists. Edit the routine first.");
    resolved.push({ id: shortcut.id, kind: shortcut.kind, target: shortcut.target });
  }
  const results = await liveDispatch(generation, () =>
    Bridge.toolsRoutineStart(routine.id, resolved, generation));
  const failed = (results ?? []).find((r) => r.status === "failed");
  if (failed) throw new Error(failed.message || "A routine step failed.");
  const cancelled = (results ?? []).find((r) => r.status === "cancelled");
  if (cancelled) throw new Error("The routine was cancelled before every step ran.");
  return null;
});

// Read-only context adapters: local snapshots whose result is its own proof.
registry.bind("context.window", async (_step, _ctx, generation) => {
  const snapshot = await liveDispatch(generation, () => Bridge.voiceWindowSnapshot());
  if (!snapshot) throw new Error("No window information is available.");
  return `${snapshot.appName}: ${snapshot.title}`.slice(0, 140);
});
registry.bind("context.battery", async (_step, _ctx, generation) => {
  const snapshot = await liveDispatch(generation, () => Bridge.batterySnapshot());
  if (!snapshot) throw new Error("No battery information is available.");
  return JSON.stringify(snapshot).slice(0, 140);
});
registry.bind("context.vitals", async (_step, _ctx, generation) => {
  const snapshot = await liveDispatch(generation, () => Bridge.vitalsSnapshot());
  if (!snapshot) throw new Error("No vitals information is available.");
  return JSON.stringify(snapshot).slice(0, 140);
});

// ── Session and run ───────────────────────────────────────────────────────

/** Starts a fresh listening session: a clean FlowSession, no note ownership
 *  and no remembered request. Session context resets only here, never before
 *  each cumulative run. */
export function resetSession(): FlowSession {
  session = new FlowSession(registry);
  lastNotePath = null;
  lastRequest = null;
  return session;
}

/** The readiness context, built fresh per run from the saved settings. */
export function flowContext(): FlowCapabilityContext {
  const tools = State.settings.tools;
  return {
    settings: {
      flowNotesFolder: State.settings.flowNotesFolder ?? "",
      flowSearchEngine: State.settings.flowSearchEngine ?? "",
      flowBrowser: State.settings.flowBrowser ?? "",
      flowEditor: State.settings.flowEditor ?? "",
    },
    shortcuts: (tools?.shortcuts ?? []).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, target: s.target,
    })),
    routines: (tools?.routines ?? []).map((r) => ({
      id: r.id, name: r.name, steps: [...(r.steps ?? [])],
    })),
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  };
}

/** Runner wired to the registry and the voice fence. Cancellation is the
 *  combined generation check, so a stopped turn never dispatches. */
interface FlowRunOptions {
  approved?: (kind: string) => boolean;
  onStep?: FlowRunner["onStep"];
}

function makeRunner(opts: FlowRunOptions = {}): FlowRunner {
  return {
    registry,
    context: () => flowContext(),
    approved: (step) => opts.approved?.(step.kind) ?? false,
    cancelled: (gen) => isVoiceStale(gen),
    onStep: opts.onStep,
  };
}

/** Runs a plan on the persistent session. The same session is passed on every
 *  run, so replay and cumulative speech plans reuse settled steps. */
export async function runPlan(
  plan: FlowPlan,
  opts: FlowRunOptions = {},
): Promise<FlowPlanReceipt> {
  return session.run(plan, makeRunner(opts));
}

/** Plans and runs one media action through the queue, same receipts and
 *  cancellation as every other capability. */
export async function runMediaFlow(
  action: string,
  generation: number,
): Promise<{ receipt: FlowPlanReceipt | null; error: string | null }> {
  if (!isFlowMediaAction(action)) {
    return { receipt: null, error: "That media action is not supported." };
  }
  const planned = planFromRequest(
    { generation, steps: [{ kind: `media.${action}`, target: action }] },
    Date.now(),
    registry,
  );
  if (!planned.plan) return { receipt: null, error: planned.error ?? "That request cannot run." };
  const receipt = await runPlan(planned.plan);
  return { receipt, error: null };
}

/** Plans and runs one saved-app or saved-folder launch through the queue,
 *  same receipts, fences and verification policy as every other capability:
 *  a launch is sent, never proven. */
export async function runLaunchFlow(
  kind: "app" | "folder",
  target: string,
  generation: number,
): Promise<{ receipt: FlowPlanReceipt | null; error: string | null }> {
  const planned = planFromRequest(
    { generation, steps: [{ kind: kind === "folder" ? "folder.open" : "app.launch", target }] },
    Date.now(),
    registry,
  );
  if (!planned.plan) return { receipt: null, error: planned.error ?? "That launch cannot run." };
  const receipt = await runPlan(planned.plan);
  return { receipt, error: null };
}

/** Plans and runs one saved routine through the queue on its explicit Run
 *  click. Approval is granted only here, by the click, and the native runner
 *  keeps its own step-by-step cancellation. */
export async function runRoutineFlow(
  routineId: string,
  generation: number,
): Promise<{ receipt: FlowPlanReceipt | null; error: string | null }> {
  const planned = planFromRequest(
    { generation, steps: [{ kind: "routine.run", target: routineId }] },
    Date.now(),
    registry,
  );
  if (!planned.plan) return { receipt: null, error: planned.error ?? "That routine cannot run." };
  const receipt = await runPlan(planned.plan, { approved: (kind) => kind === "routine.run" });
  return { receipt, error: null };
}

/** Receipt states of one generation, keyed by planned step id. A correction
 *  uses this to distinguish a pending step from one that already ran. */
export function flowStepStates(generation: number): Record<string, FlowStepState> {
  return session.statesFor(generation);
}

/** Applies a spoken correction to this session's last planned request. A
 *  pending note step is retitled in place; a completed note gets a distinct
 *  verified rename step; an in-flight step is never rewritten. Returns null
 *  when the utterance is not a correction or there is nothing to correct. */
export function correctFlowTurn(
  clean: string,
): { request: FlowPlanRequest; note: string } | null {
  if (!lastRequest) return null;
  const states = session.statesFor(lastRequest.generation);
  return applyFlowCorrection(lastRequest, clean, states);
}

/** Cancels the current listening session's Flow work by advancing the voice
 *  generation, so queued and late steps read stale and never dispatch. The
 *  native executors recheck this same fence inside their blocking closures. */
export function cancelFlow(): void {
  voiceGeneration += 1;
}

/** One line of card copy for a step, honest about verification. */
export function describeStep(step: FlowStepReceipt): string {
  const name = step.kind.replace(".", " ");
  if (step.state === "completed" && step.verified && step.evidence) {
    return `${name}: ${step.evidence}`;
  }
  if (step.state === "dispatched") {
    return `${name}: sent, not verified`;
  }
  if (step.state === "awaiting") return `${name}: waiting for your click`;
  if (step.state === "failed") return `${name}: ${step.message}`;
  if (step.state === "cancelled") return `${name}: stopped`;
  return name;
}

/** One line of the compact capability view: ready or unavailable with a
 *  precise reason, per capability and per listed unavailable adapter. */
export interface FlowCapabilityLine {
  id: string;
  label: string;
  ready: boolean;
  reason: string;
}

export function flowCapabilityView(): {
  supported: FlowCapabilityLine[];
  unavailable: FlowCapabilityLine[];
} {
  const ctx = flowContext();
  const supported: FlowCapabilityLine[] = [];
  const unavailable: FlowCapabilityLine[] = [];
  for (const capability of registry.list()) {
    let reason = "";
    if (!capability.execute) {
      reason = "Not wired up on this device.";
    } else if (!ctx.online && !capability.offline) {
      reason = "Needs an internet connection.";
    } else if (capability.category !== "routine") {
      // Routines are judged per step when selected: the view probe has no
      // routine id, so its readiness would misreport the capability itself.
      const probe: FlowPlanStep = {
        id: "probe", kind: capability.id, target: "", value: null, after: [],
      };
      const readiness = capability.readiness(ctx, probe);
      if (!readiness.ready) reason = readiness.reason ?? "Not ready.";
    }
    if (reason) unavailable.push({ id: capability.id, label: capability.label, ready: false, reason });
    else supported.push({ id: capability.id, label: capability.label, ready: true, reason: "" });
  }
  for (const adapter of FLOW_UNAVAILABLE_ADAPTERS) {
    unavailable.push({ id: adapter.id, label: adapter.label, ready: false, reason: adapter.reason });
  }
  return { supported, unavailable };
}
