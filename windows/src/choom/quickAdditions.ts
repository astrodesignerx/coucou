// Quick additions: one quiet System entry with a Jobs, PC and Battery
// selector inside its card. Nothing here takes focus on its own: the pill is
// created quietly, sampling only runs while the island is visible and
// enabled, and every warning goes through Focus so pause, permissions, pins,
// file drops and full-screen quiet are respected like any other moment.
//
// Job radar lists at most four code jobs derived from existing hook-driven
// state: Claude Code sessions, Codex sessions and the OpenCode agent pill.
// It never fabricates progress, failures or shell jobs. A row focuses the
// existing session card instead of opening anything new.
//
// PC vitals read native total CPU and memory through two Tauri commands.
// CPU needs two cumulative samples, so the first read stores a baseline and
// reports nothing, never zero. Unknown or failed reads report unavailable,
// never healthy, and never identify a culprit process: only totals exist.
//
// Battery state comes from GetSystemPowerStatus plus native power
// notifications. There is no repeating hidden poll: the card refreshes on
// start, on visible wake, on demand and on native events. Low warnings fire
// once per downward crossing of 20, 10 and 5 percent, stay silent on AC and
// while charging, and allow at most one charging recovery after a prior low.

import { State } from "../core/state";
import type { AgentTask } from "../core/state";
import { Focus } from "./focus";

/** The one quiet utilities pill. Stable once created, never renamed. */
export const UTILITY_ID = "utility_system";
export const UTILITY_NAME = "System";
export const UTILITY_COLOR = "#8E939C";

/** How often total CPU and memory are sampled while visible, in ms. */
export const VITALS_INTERVAL_MS = 5000;
/** Sustained-breach level for CPU and memory warnings, in percent. */
export const VITALS_WARN_PCT = 90;
/** Recovery level. A metric must fall below this before it can warn again. */
export const VITALS_RECOVER_PCT = 85;
/** How long a breach must hold before it warns, in ms. */
export const VITALS_SUSTAIN_MS = 30_000;
/** Quiet time after a warning before the next one may surface, in ms. */
export const VITALS_COOLDOWN_MS = 300_000;

/** Low battery warnings, most urgent last. */
export const BATTERY_LEVELS = [20, 10, 5] as const;
export type BatteryLevel = (typeof BATTERY_LEVELS)[number];

/** Which tab of the System card is showing. Kept here so a card rebuild from
 * views.ts keeps the user's tab instead of resetting it. */
export type UtilityTab = "jobs" | "pc" | "battery";
let utilityTab: UtilityTab = "jobs";

export function getUtilityTab(): UtilityTab {
  return utilityTab;
}

export function setUtilityTab(tab: UtilityTab): void {
  utilityTab = tab;
}

// Job radar.

export type JobKind = "claude" | "codex" | "opencode" | "agent";

export interface JobRow {
  id: string;
  name: string;
  color: string;
  kind: JobKind;
  status: string;
  detail: string;
}

function jobKind(id: string): JobKind {
  if (id === "integration_claude") return "claude";
  if (id === "agent_opencode") return "opencode";
  if (id === "agent_codex" || id.startsWith("agent_codex_")) return "codex";
  return "agent";
}

function jobStatus(task: AgentTask): string {
  if (task.pillBadge === "approval" || task.state === "approval") return "approval";
  if (task.state === "working" || task.state === "thinking" || task.state === "searching") {
    return task.state;
  }
  if (task.state === "error" || task.pillBadge === "error") return "error";
  if (task.state === "finished" || task.pillBadge === "finished") return "finished";
  return "idle";
}

function jobRank(task: AgentTask): number {
  const status = jobStatus(task);
  if (status === "approval") return 0;
  if (status === "working" || status === "thinking" || status === "searching") return 1;
  if (status === "error") return 2;
  if (status === "finished") return 3;
  return 4;
}

/**
 * At most four code jobs from hook-driven state, approvals and live work
 * first, then recent finishes and errors, then idle sessions. Service
 * integrations, music and the System entry itself never appear here.
 */
export function jobRadarRows(tasks: AgentTask[]): JobRow[] {
  return tasks
    .filter((t) => t.id === "integration_claude" || t.id.startsWith("agent_"))
    .sort((a, b) => jobRank(a) - jobRank(b))
    .slice(0, 4)
    .map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      kind: jobKind(t.id),
      status: jobStatus(t),
      detail: t.steps.at(-1) ?? "",
    }));
}

// Shared monitor plumbing.

export interface VitalsReading {
  cpuPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  memPercent: number | null;
  unavailable: string | null;
}

export interface BatteryReading {
  hasBattery: boolean;
  percent: number | null;
  charging: boolean | null;
  acOnline: boolean | null;
  timeSecs: number | null;
  state: string;
  error: string | null;
}

/** True while an alert may borrow the pill: not paused, no permission card,
 * nothing pinned and no file drop in flight. Hidden islands stay eligible
 * for battery warnings, which wake through the Focus full-screen gate like
 * any other moment. Vitals warnings add their own visibility check. */
export function canWarnNow(): boolean {
  if (State.paused) return false;
  if (State.pendingApproval) return false;
  if (State.isPinned) return false;
  if (State.droppedFile) return false;
  return true;
}

export function utilityEnabled(): boolean {
  const s = State.settings;
  return s.jobRadar !== false || s.pcVitals !== false || s.batteryMonitor !== false;
}

/** Creates the quiet pill when any utility is on, removes it when none are.
 * Never touches focus except to move it off the removed pill. */
export function syncUtilityPill(): void {
  const exists = State.tasks.some((t) => t.id === UTILITY_ID);
  if (utilityEnabled()) {
    if (!exists) State.upsertExternalAgent(UTILITY_ID, UTILITY_NAME, UTILITY_COLOR);
    return;
  }
  if (!exists) return;
  if (State.focusId === UTILITY_ID) State.focusId = "integration_claude";
  delete State.integrations[UTILITY_ID];
  State.removeTask(UTILITY_ID);
}

function storeUtilityData(patch: Record<string, unknown>): void {
  const info = State.integrations[UTILITY_ID] ?? {
    data: {},
    error: null,
    loaded: true,
    configured: true,
  };
  State.integrations[UTILITY_ID] = {
    ...info,
    loaded: true,
    error: null,
    data: { ...info.data, ...patch },
  };
  State.notify();
}

/** Small numbers for the card. One decimal for percent, GB or MB for bytes. */
export function formatPct1(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1_048_576;
  return `${mb.toFixed(1)} MB`;
}

export function formatBatteryTime(timeSecs: number | null): string | null {
  if (timeSecs == null || !Number.isFinite(timeSecs)) return null;
  const mins = Math.floor(timeSecs / 60);
  if (mins < 1) return "less than a minute left";
  if (mins < 60) return `${mins} min left`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

// Vitals warnings.

export interface VitalsWarnState {
  cpuMs: number;
  memMs: number;
  cpuLatched: boolean;
  memLatched: boolean;
  cooldownUntil: number;
  lastEval: number | null;
}

export function initialVitalsWarnState(): VitalsWarnState {
  return { cpuMs: 0, memMs: 0, cpuLatched: false, memLatched: false, cooldownUntil: 0, lastEval: null };
}

export type VitalsWarnKind = "cpu" | "mem" | "both";

/**
 * Sustained-breach tracking with cooldown, recovery hysteresis and latching.
 * Only readings at or above 90 add breach time, which must reach 30 s for a
 * warning. Unknown readings and anything below 90 break unlatched
 * accumulation outright. A warning latches: no repeat while the metric stays
 * high. Falling below 85 unlatches. Unknown readings never clear a latch,
 * since missing data proves no recovery.
 */
export function nextVitalsWarn(
  state: VitalsWarnState,
  cpu: number | null,
  mem: number | null,
  now: number,
): { state: VitalsWarnState; warn: VitalsWarnKind | null } {
  const dt = state.lastEval == null ? 0 : Math.max(0, now - state.lastEval);
  const track = (value: number | null, ms: number, latched: boolean) => {
    if (latched) {
      if (value == null) return { ms: 0, latched: true };
      if (value < VITALS_RECOVER_PCT) return { ms: 0, latched: false };
      return { ms: 0, latched: true };
    }
    if (value == null || value < VITALS_WARN_PCT) return { ms: 0, latched: false };
    return { ms: ms + dt, latched: false };
  };
  const cpuT = track(cpu, state.cpuMs, state.cpuLatched);
  const memT = track(mem, state.memMs, state.memLatched);
  const cooled = now >= state.cooldownUntil;
  const cpuDue = !cpuT.latched && cpuT.ms >= VITALS_SUSTAIN_MS && cooled;
  const memDue = !memT.latched && memT.ms >= VITALS_SUSTAIN_MS && cooled;
  if (!cpuDue && !memDue) {
    return {
      state: {
        cpuMs: cpuT.ms,
        memMs: memT.ms,
        cpuLatched: cpuT.latched,
        memLatched: memT.latched,
        cooldownUntil: state.cooldownUntil,
        lastEval: now,
      },
      warn: null,
    };
  }
  const warn: VitalsWarnKind = cpuDue && memDue ? "both" : cpuDue ? "cpu" : "mem";
  return {
    state: {
      cpuMs: cpuDue ? 0 : cpuT.ms,
      memMs: memDue ? 0 : memT.ms,
      cpuLatched: cpuDue ? true : cpuT.latched,
      memLatched: memDue ? true : memT.latched,
      cooldownUntil: now + VITALS_COOLDOWN_MS,
      lastEval: now,
    },
    warn,
  };
}

export interface VitalsMonitorDeps {
  now: () => number;
  snapshot: () => Promise<VitalsReading | null>;
  /** Visible, enabled and unpaused. Skipped ticks freeze the breach timers. */
  isActive: () => boolean;
  /** Warnings on, and no permission, pin, drop or hidden island. */
  canWarn: () => boolean;
  warn: (kind: VitalsWarnKind, cpu: number | null, mem: number | null) => void;
}

/**
 * Samples total CPU and memory on an interval while active. Async snapshots
 * carry a generation token, so a response that lands after stop, disable or
 * hide is dropped instead of surfacing stale numbers. Stopping resets the
 * breach timers but keeps the latch, which still needs real recovery.
 */
export class VitalsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private seq = 0;
  private needsCpuBaseline = true;
  private warnState = initialVitalsWarnState();

  constructor(private readonly deps: VitalsMonitorDeps) {}

  get running(): boolean {
    return this.timer != null;
  }

  start(intervalMs: number = VITALS_INTERVAL_MS): void {
    if (this.timer != null) return;
    this.generation += 1;
    const generation = this.generation;
    this.needsCpuBaseline = true;
    this.timer = setInterval(() => {
      void this.tick(generation);
    }, intervalMs);
    void this.tick(generation);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Hidden, disabled or paused time never counts toward a breach. Latches
    // still need real recovery and the cooldown keeps running on the wall.
    const kept = this.warnState;
    this.warnState = {
      ...initialVitalsWarnState(),
      cpuLatched: kept.cpuLatched,
      memLatched: kept.memLatched,
      cooldownUntil: kept.cooldownUntil,
    };
  }

  /** One on-demand sample for the card refresh button. Never warns. */
  sampleNow(): void {
    void this.tick(this.generation);
  }

  private async tick(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const seq = ++this.seq;
    if (!this.deps.isActive()) {
      // Hidden, disabled or paused time never counts toward a breach: the
      // running timers reset while latches and cooldown survive.
      this.warnState = { ...this.warnState, cpuMs: 0, memMs: 0, lastEval: null };
      return;
    }
    let reading: VitalsReading | null = null;
    try {
      reading = await this.deps.snapshot();
    } catch {
      reading = null;
    }
    // Only the latest overlapping sample stores and evaluates. Older ones
    // resolve into nothing instead of flashing stale numbers.
    if (seq !== this.seq) return;
    if (generation !== this.generation || !this.deps.isActive() || !reading) return;
    if (this.needsCpuBaseline) {
      reading = { ...reading, cpuPercent: null };
      this.needsCpuBaseline = false;
    }
    storeUtilityData({ vitals: { ...reading } });
    const now = this.deps.now();
    const result = nextVitalsWarn(this.warnState, reading.cpuPercent, reading.memPercent, now);
    if (result.warn && !this.deps.canWarn()) {
      // Suppressed, not shown: hold the pre-warning state so the breach
      // rechecks on the next eligible sample instead of latching silently.
      this.warnState = { ...this.warnState, lastEval: now };
      return;
    }
    this.warnState = result.state;
    if (result.warn) {
      this.deps.warn(result.warn, reading.cpuPercent, reading.memPercent);
    }
  }
}

// Battery warnings.

export interface BatteryWarnState {
  lastPercent: number | null;
  warned: [boolean, boolean, boolean];
  hadLow: boolean;
  recoverySent: boolean;
}

export function initialBatteryWarnState(): BatteryWarnState {
  return { lastPercent: null, warned: [false, false, false], hadLow: false, recoverySent: false };
}

export type BatteryEvent = { type: "low"; level: BatteryLevel } | { type: "recovery" };

/**
 * Low warnings fire at exactly 20, 10 and 5 percent, once per episode. A
 * reading at or below a level only warns on a genuine downward step from
 * strictly above that level, and only when the level is not already warned.
 * Jitter below a level (19 to 21 to 19) stays quiet until the battery
 * recovers above the level plus 2, which rearms it. A jump across several
 * levels warns once, for the lowest one. A first sighting at or below 5
 * warns once as genuinely critical; any higher first sighting only sets the
 * baseline, since no crossing can be proven. AC and charging suppress
 * warnings and rearm the levels. At most one recovery notice follows a low
 * episode, never one per cable event. API failures, missing batteries and
 * unknown percentages never warn and never claim state.
 */
export function nextBatteryEvent(
  state: BatteryWarnState,
  reading: BatteryReading,
): { state: BatteryWarnState; event: BatteryEvent | null } {
  const copy = (): BatteryWarnState => ({
    lastPercent: state.lastPercent,
    warned: [state.warned[0], state.warned[1], state.warned[2]],
    hadLow: state.hadLow,
    recoverySent: state.recoverySent,
  });
  if (reading.error != null || !reading.hasBattery) return { state, event: null };
  const percent = reading.percent;
  if (percent == null) return { state, event: null };
  const next = copy();
  const onPower = reading.charging === true || reading.acOnline === true;
  if (onPower) {
    next.lastPercent = percent;
    if (next.hadLow) {
      next.hadLow = false;
      next.warned = [false, false, false];
      if (!next.recoverySent) {
        next.recoverySent = true;
        return { state: next, event: { type: "recovery" } };
      }
      return { state: next, event: null };
    }
    next.warned = [false, false, false];
    return { state: next, event: null };
  }
  for (let i = 0; i < BATTERY_LEVELS.length; i++) {
    if (percent > BATTERY_LEVELS[i] + 2) next.warned[i] = false;
  }
  const last = next.lastPercent;
  next.lastPercent = percent;
  if (last == null) {
    if (percent <= 5) {
      for (let i = 0; i < BATTERY_LEVELS.length; i++) {
        if (percent <= BATTERY_LEVELS[i]) next.warned[i] = true;
      }
      next.hadLow = true;
      next.recoverySent = false;
      return { state: next, event: { type: "low", level: 5 } };
    }
    return { state: next, event: null };
  }
  let hit: BatteryLevel | null = null;
  for (let i = 0; i < BATTERY_LEVELS.length; i++) {
    const level = BATTERY_LEVELS[i];
    if (percent <= level && last >= level && percent < last && !next.warned[i]) {
      next.warned[i] = true;
      hit = level;
    }
  }
  if (hit == null) return { state: next, event: null };
  next.hadLow = true;
  next.recoverySent = false;
  return { state: next, event: { type: "low", level: hit } };
}

export interface BatteryTrackerDeps {
  refresh: () => Promise<BatteryReading | null>;
  /** Feature enabled and island unpaused. Native events still store. */
  isActive: () => boolean;
  canWarn: () => boolean;
  low: (level: BatteryLevel, reading: BatteryReading) => void;
  recovered: (reading: BatteryReading) => void;
}

/**
 * Battery refresh without a hidden poll: startup, visible wake, the card
 * refresh button and native power events. Stale async refreshes are dropped
 * by generation token. Disposing unsubscribes the native listener.
 */
export class BatteryTracker {
  private generation = 0;
  private warnState = initialBatteryWarnState();
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(
    private readonly deps: BatteryTrackerDeps,
    private readonly subscribeNative?: (handler: (reading: BatteryReading) => void) => () => void,
  ) {}

  get listening(): boolean {
    return this.unsubscribe != null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    if (this.subscribeNative) {
      this.unsubscribe = this.subscribeNative((reading) => this.onNative(reading));
    }
    void this.refresh();
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  /** Visible wake or card button: one fresh read, gated on active. */
  refreshNow(): void {
    if (!this.deps.isActive()) return;
    void this.refresh();
  }

  onVisibleWake(): void {
    this.refreshNow();
  }

  onNative(reading: BatteryReading): void {
    if (!this.started) return;
    // A native reading is newer than any in-flight refresh: invalidate the
    // older response so it can never overwrite this one.
    this.generation += 1;
    this.handle(reading);
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    let reading: BatteryReading | null = null;
    try {
      reading = await this.deps.refresh();
    } catch {
      reading = null;
    }
    if (generation !== this.generation || !reading) return;
    if (!this.deps.isActive()) return;
    this.handle(reading);
  }

  private handle(reading: BatteryReading): void {
    storeUtilityData({ battery: { ...reading } });
    const result = nextBatteryEvent(this.warnState, reading);
    if (result.event && !this.deps.canWarn()) {
      // Suppressed, not shown: keep the prior low state untouched so the
      // crossing rechecks on the next eligible reading instead of being
      // consumed quietly or replayed later.
      return;
    }
    this.warnState = result.state;
    if (!result.event) return;
    if (result.event.type === "low") this.deps.low(result.event.level, reading);
    else this.deps.recovered(reading);
  }
}

export type BatteryView = "off" | "starting" | "error" | "unavailable" | "unknown" | "no_battery" | "live";

/**
 * Which battery panel the card shows. Unknown API state renders
 * unavailable, never as no battery: only an explicit no-battery reading
 * earns that line.
 */
export function batteryViewState(reading: BatteryReading | null, enabled: boolean): BatteryView {
  if (!enabled) return "off";
  if (!reading) return "starting";
  if (reading.error != null) return "error";
  if (reading.state === "unavailable") return "unavailable";
  if (reading.state === "unknown") return "unknown";
  if (!reading.hasBattery) return "no_battery";
  if (reading.percent == null) return "unknown";
  return "live";
}

// Wiring ------------------------------------------------------------------------

export interface QuickDeps {
  snapshotVitals: () => Promise<VitalsReading | null>;
  snapshotBattery: () => Promise<BatteryReading | null>;
  subscribeBattery: (handler: (reading: BatteryReading) => void) => () => void;
  /** Tears down or respawns the native power observer. Called on change only. */
  setNativeWatching: (on: boolean) => void;
}

export interface QuickHandles {
  dispose: () => void;
  refreshVitals: () => void;
  refreshBattery: () => void;
}

let activeVitals: VitalsMonitor | null = null;
let activeBattery: BatteryTracker | null = null;

/** Card refresh buttons reach the live monitors without touching Bridge. */
export function refreshVitalsNow(): void {
  activeVitals?.sampleNow();
}

export function refreshBatteryNow(): void {
  activeBattery?.refreshNow();
}

function vitalsText(kind: VitalsWarnKind, cpu: number | null, mem: number | null): [string, string] {
  if (kind === "cpu") return ["PC running hot", `CPU at ${cpu?.toFixed(0) ?? "?"}% for a while`];
  if (kind === "mem") return ["Memory nearly full", `Memory at ${mem?.toFixed(0) ?? "?"}% for a while`];
  return ["PC under load", `CPU ${cpu?.toFixed(0) ?? "?"}%, memory ${mem?.toFixed(0) ?? "?"}%`];
}

/**
 * Starts the utilities wiring. Idempotent per call site: main.ts calls it
 * once, like registerNowPlaying. Everything reacts to State, so settings
 * changes apply without a restart.
 */
export function registerQuickAdditions(deps: QuickDeps): QuickHandles {
  const vitals = new VitalsMonitor({
    now: () => Date.now(),
    snapshot: deps.snapshotVitals,
    isActive: () =>
      State.mode !== "hidden" && State.settings.pcVitals !== false && !State.paused,
    canWarn: () =>
      State.mode !== "hidden" && State.settings.vitalsWarnings !== false && canWarnNow(),
    warn: (kind, cpu, mem) => {
      const [line1, line2] = vitalsText(kind, cpu, mem);
      Focus.moment({ taskId: UTILITY_ID, kind: "warning", line1, line2, ms: 5000 });
    },
  });
  const battery = new BatteryTracker(
    {
      refresh: deps.snapshotBattery,
      isActive: () => State.settings.batteryMonitor !== false && !State.paused,
      canWarn: () => State.settings.batteryWarnings !== false && canWarnNow(),
      low: (level, reading) => {
        const pct = reading.percent ?? level;
        Focus.moment({
          taskId: UTILITY_ID,
          kind: "warning",
          line1: `Battery at ${pct}%`,
          line2: level <= 5 ? "Plug in soon" : "Running on battery",
          ms: 5000,
        });
      },
      recovered: () => {
        Focus.moment({
          taskId: UTILITY_ID,
          kind: "warning",
          line1: "Back on power",
          line2: "Battery recovering",
          ms: 4000,
        });
      },
    },
    deps.subscribeBattery,
  );
  activeVitals = vitals;
  activeBattery = battery;

  let lastMode = State.mode;
  let lastPaused = State.paused;
  let lastBatteryWarnings = State.settings.batteryWarnings !== false;
  let prevBatteryOn: boolean | null = null;
  let lastWarnEligible = canWarnNow();
  const sync = () => {
    syncUtilityPill();
    const visible = State.mode !== "hidden";
    const vitalsOn = State.settings.pcVitals !== false;
    if (visible && vitalsOn && !State.paused) {
      if (!vitals.running) vitals.start();
    } else {
      if (vitals.running) vitals.stop();
    }
    const batteryOn = State.settings.batteryMonitor !== false;
    if (batteryOn && !State.paused) {
      if (!battery.listening) battery.start();
    } else {
      if (battery.listening) battery.stop();
    }
    if (prevBatteryOn !== batteryOn) {
      prevBatteryOn = batteryOn;
      deps.setNativeWatching(batteryOn);
    }
    // Visible wake refreshes the battery card and restarts vitals sampling.
    if (lastMode === "hidden" && State.mode !== "hidden") {
      battery.onVisibleWake();
    }
    // A suppressed crossing is never consumed, so recheck the live state
    // once warnings can surface again. One fresh read, never a replay.
    if (lastPaused && !State.paused) {
      battery.refreshNow();
    }
    const warningsOn = State.settings.batteryWarnings !== false;
    if (!lastBatteryWarnings && warningsOn) {
      battery.refreshNow();
    }
    const warnEligible = canWarnNow();
    const eligibilityRestored = !lastWarnEligible && warnEligible;
    lastWarnEligible = warnEligible;
    if (eligibilityRestored) battery.refreshNow();
    lastMode = State.mode;
    lastPaused = State.paused;
    lastBatteryWarnings = warningsOn;
  };
  const unsubscribe = State.subscribe(sync);
  sync();
  // First paint reads the battery once, without waiting for a power event.
  battery.onVisibleWake();

  return {
    dispose: () => {
      unsubscribe();
      vitals.stop();
      battery.dispose();
      if (activeVitals === vitals) activeVitals = null;
      if (activeBattery === battery) activeBattery = null;
    },
    refreshVitals: () => vitals.sampleNow(),
    refreshBattery: () => battery.refreshNow(),
  };
}
