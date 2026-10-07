// Focus: one place decides which task owns the small pill and the island
// focus while the island is not expanded. The ranking is sticky owners first
// (permission, pin, working agents, music) with short moments borrowing the
// pill in between. Nothing here touches the DOM or timers beyond moment and
// manual-hold expiry, so the ranking stays unit testable through rankOwner.

import { State } from "../core/state";
import type { AgentTask } from "../core/state";
import type { BotStateName } from "../core/layout";

export const MUSIC_ID = "integration_music";
export const IDLE_ID = "integration_claude";
export const CLAUDE_ID = "integration_claude";

/** How long a manual wheel choice beats the ranking before it takes over. */
export const MANUAL_HOLD_MS = 30_000;

/** Queued moments beyond this are dropped, oldest first. */
const MAX_QUEUED = 3;

const WORKING: readonly BotStateName[] = ["working", "thinking", "searching"];

/**
 * Tasks that do code work: Claude Code plus dynamic agent pills. Service
 * integrations and the music pill never rank at agent priority, even when
 * their state reads working (the music pill is working while it plays).
 */
export function isCodeAgent(id: string): boolean {
  return id === CLAUDE_ID || id.startsWith("agent_");
}

export type MomentKind = "track" | "finished" | "failed";

export interface Moment {
  taskId: string;
  kind: MomentKind;
  line1: string;
  line2: string;
  /** How long the moment holds the pill, in ms. */
  ms: number;
}

/** Everything the ranking needs from the app, in one plain object. */
export interface World {
  taskIds: string[];
  approvalTaskId: string | null;
  workingIds: string[];
  musicId: string | null;
  idleId: string;
}

export interface RankInput extends World {
  pinnedId: string | null;
  momentTaskId: string | null;
  manualId: string | null;
  manualUntil: number;
  now: number;
}

const alive = (ids: string[], id: string | null): id is string =>
  id != null && ids.includes(id);

/**
 * One ladder decides the pill owner. A sticky owner keeps the pill until its
 * state ends, a moment borrows it for a few seconds, then the highest sticky
 * owner gets it back. The pin sits just under permission requests, so only an
 * approval can take the pill from a pinned Choom. A manual wheel choice beats
 * the sticky states for a short hold, but news (moments) still peeks through.
 */
export function rankOwner(input: RankInput): string {
  const ids = input.taskIds;
  if (alive(ids, input.approvalTaskId)) return input.approvalTaskId;
  if (alive(ids, input.pinnedId)) return input.pinnedId;
  if (alive(ids, input.momentTaskId)) return input.momentTaskId;
  if (
    input.manualId != null &&
    input.now < input.manualUntil &&
    ids.includes(input.manualId)
  ) {
    return input.manualId;
  }
  for (const id of input.workingIds) {
    if (ids.includes(id)) return id;
  }
  if (alive(ids, input.musicId)) return input.musicId;
  if (ids.includes(input.idleId)) return input.idleId;
  return ids[0] ?? input.idleId;
}

export interface DotTask {
  id: string;
  color: string;
  state: BotStateName;
}

/** Other live activities, for the small dots at the pill edge (max 3). */
export function liveDots(
  tasks: DotTask[],
  ownerId: string | null,
  musicPlaying: boolean,
): DotTask[] {
  const dots: DotTask[] = [];
  for (const t of tasks) {
    if (t.id === ownerId) continue;
    if (t.id === MUSIC_ID) {
      if (musicPlaying) dots.push(t);
    } else if (WORKING.includes(t.state)) {
      dots.push(t);
    }
    if (dots.length >= 3) break;
  }
  return dots;
}

export interface FocusOwner {
  taskId: string;
  moment: Moment | null;
}

export interface FocusWiring {
  readWorld: () => World;
  applyFocus: (id: string) => void;
  /**
   * The actually focused task, for reconciling external focus changes (rail
   * clicks, moment clicks) that bypass applyFocus. Optional in tests, where it
   * falls back to the last applied owner.
   */
  readFocusId?: () => string | null;
  isExpanded: () => boolean;
  now?: () => number;
}

type Listener = () => void;

export class FocusEngine {
  /**
   * Full-screen gate: moments are skipped entirely while it resolves false.
   * Null (plain browser) counts as allowed. Set by the island; empty in tests.
   */
  wakeGate: (() => Promise<boolean | null>) | null = null;

  private readonly readWorld: () => World;
  private readonly applyFocus: (id: string) => void;
  private readonly readFocusId: () => string | null;
  private readonly isExpanded: () => boolean;
  private readonly clock: () => number;

  private queue: Moment[] = [];
  private active: Moment | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private gating = false;
  private pinnedId: string | null = null;
  private manualId: string | null = null;
  private manualUntil = 0;
  private manualTimer: ReturnType<typeof setTimeout> | null = null;
  private currentId = "";
  private lastKey = "";
  /** Last owner handed to applyFocus; collapsing reapplies on change only. */
  private lastAppliedId = "";
  private applying = false;
  private disposed = false;
  private started = false;
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;

  constructor(wiring: FocusWiring) {
    this.readWorld = wiring.readWorld;
    this.applyFocus = wiring.applyFocus;
    this.readFocusId = wiring.readFocusId ?? (() => this.lastAppliedId);
    this.isExpanded = wiring.isExpanded;
    this.clock = wiring.now ?? (() => performance.now());
  }

  /**
   * The current owner: task id plus the moment presentation, but only when the
   * moment actually owns the pill. A moment blocked by a permission request or
   * a pin never lends its text to the peek and never redirects pill clicks.
   */
  get owner(): FocusOwner {
    const moment = this.active != null && this.currentId === this.active.taskId
      ? this.active
      : null;
    return { taskId: this.currentId, moment };
  }

  get pinned(): string | null {
    return this.pinnedId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * A moment borrows the pill, queued behind the one showing, if any. A moment
   * for a task that a permission request or a pin currently suppresses expires
   * at once instead of queuing stale news behind a sticky owner.
   */
  moment(m: Moment): void {
    if (this.disposed) return;
    if (this.suppressed(m.taskId)) return;
    this.queue = this.queue.filter((q) => q.taskId !== m.taskId);
    this.queue.push(m);
    while (this.queue.length > MAX_QUEUED) this.queue.shift();
    this.pump();
  }

  pin(id: string | null): void {
    this.pinnedId = id;
    this.recompute();
  }

  togglePin(id: string): void {
    this.pin(this.pinnedId === id ? null : id);
  }

  /** Wheel over the small pill: step through live tasks, hold 30 s. */
  cycle(direction: 1 | -1): void {
    const world = this.readWorld();
    const seen = new Set<string>();
    const candidates: string[] = [];
    const push = (id: string | null) => {
      if (id != null && world.taskIds.includes(id) && !seen.has(id)) {
        seen.add(id);
        candidates.push(id);
      }
    };
    push(world.approvalTaskId);
    for (const id of world.workingIds) push(id);
    push(world.musicId);
    push(world.idleId);
    if (candidates.length === 0) return;
    const at = candidates.indexOf(this.currentId);
    const next = candidates[(at < 0 ? 0 : at + direction + candidates.length) % candidates.length];
    this.manualId = next;
    this.manualUntil = this.clock() + MANUAL_HOLD_MS;
    if (this.manualTimer != null) clearTimeout(this.manualTimer);
    const remaining = this.manualUntil - this.clock();
    this.manualTimer = setTimeout(() => {
      this.manualTimer = null;
      this.manualId = null;
      this.recompute();
    }, Math.max(0, remaining));
    this.recompute();
  }

  /** Idempotent: connect to the state and compute the first owner. */
  start(subscribe: (fn: () => void) => () => void): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribe = subscribe(() => this.recompute());
    this.recompute();
  }

  /** Recompute the owner from the world. Safe to call from State.subscribe. */
  recompute(): void {
    if (this.disposed || this.applying) return;
    const world = this.readWorld();
    if (this.active && !world.taskIds.includes(this.active.taskId)) {
      this.clearActive();
    }
    if (this.active && this.suppressed(this.active.taskId, world)) {
      this.clearActive();
    }
    if (this.pinnedId && !world.taskIds.includes(this.pinnedId)) {
      this.pinnedId = null;
    }
    if (this.manualId && !world.taskIds.includes(this.manualId)) {
      this.manualId = null;
    }
    // Blocked moments expire; the queue only ever holds showable news.
    if (this.queue.length > 0) {
      this.queue = this.queue.filter(
        (q) => world.taskIds.includes(q.taskId) && !this.suppressed(q.taskId, world),
      );
    }
    const owner = rankOwner({
      ...world,
      pinnedId: this.pinnedId,
      momentTaskId: this.active?.taskId ?? null,
      manualId: this.manualId,
      manualUntil: this.manualUntil,
      now: this.clock(),
    });
    this.currentId = owner;
    const key = `${owner}|${this.active ? `${this.active.kind}:${this.active.line1}` : ""}|${this.pinnedId ?? ""}`;
    const keyChanged = key !== this.lastKey;
    if (keyChanged) this.lastKey = key;
    // While expanded the card already shows everything, so only permission
    // requests move focus there, and those go through the approval flow, not
    // through here. A rail click is the user's own choice. Collapsing applies
    // the ranked owner whenever actual focus drifted (rail or moment clicks
    // bypass applyFocus), even when the presentation key did not change, while
    // repeat applies of the same owner stay deduplicated so State.notify
    // cannot recurse.
    if (!this.isExpanded() && owner !== this.readFocusId()) {
      this.lastAppliedId = owner;
      this.applying = true;
      try {
        this.applyFocus(owner);
      } finally {
        this.applying = false;
      }
    }
    if (keyChanged) {
      for (const fn of [...this.listeners]) fn();
    }
    // The active moment may have been cleared above with nobody left to pump.
    if (!this.active && !this.gating && this.queue.length > 0) this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.clearActive();
    this.queue = [];
    if (this.manualTimer != null) clearTimeout(this.manualTimer);
    this.manualTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  /**
   * Whether a permission request or a pin currently owns the pill over this
   * task's moment. A moment for the suppressing task itself still presents:
   * the pill already shows that Choom.
   */
  private suppressed(taskId: string, world?: World): boolean {
    const w = world ?? this.readWorld();
    if (
      w.approvalTaskId != null &&
      w.approvalTaskId !== taskId &&
      w.taskIds.includes(w.approvalTaskId)
    ) {
      return true;
    }
    return (
      this.pinnedId != null &&
      this.pinnedId !== taskId &&
      w.taskIds.includes(this.pinnedId)
    );
  }

  private pump(): void {
    if (this.disposed || this.active || this.gating) return;
    const next = this.queue.shift();
    if (!next) {
      this.recompute();
      return;
    }
    if (!this.readWorld().taskIds.includes(next.taskId)) {
      this.pump();
      return;
    }
    const gate = this.wakeGate;
    if (!gate) {
      this.show(next);
      return;
    }
    this.gating = true;
    void gate().then(
      (ok) => {
        this.gating = false;
        if (this.disposed) return;
        if (ok === false) {
          // Full screen: skip the moment entirely, try the next one.
          this.pump();
          return;
        }
        this.show(next);
      },
      () => {
        // A rejecting gate establishes nothing: skip this moment and keep the
        // queue moving, never revealing over a possibly full-screen app.
        this.gating = false;
        if (this.disposed) return;
        this.pump();
      },
    );
  }

  private show(next: Moment): void {
    if (!this.readWorld().taskIds.includes(next.taskId)) {
      this.pump();
      return;
    }
    if (this.suppressed(next.taskId)) {
      this.pump();
      return;
    }
    this.active = next;
    if (this.activeTimer != null) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => {
      this.activeTimer = null;
      this.active = null;
      this.pump();
    }, Math.max(0, next.ms));
    this.recompute();
  }

  private clearActive(): void {
    if (this.activeTimer != null) clearTimeout(this.activeTimer);
    this.activeTimer = null;
    this.active = null;
  }
}

function readStateWorld(): World {
  const tasks: AgentTask[] = State.tasks;
  return {
    taskIds: tasks.map((t) => t.id),
    approvalTaskId: State.pendingApproval?.taskId ?? null,
    workingIds: tasks
      .filter((t) => isCodeAgent(t.id) && WORKING.includes(t.state))
      .map((t) => t.id),
    musicId: tasks.some((t) => t.id === MUSIC_ID) ? MUSIC_ID : null,
    idleId: IDLE_ID,
  };
}

/** The shared engine, wired to the app state. Started once by the island. */
export const Focus = new FocusEngine({
  readWorld: readStateWorld,
  applyFocus: (id: string) => State.setFocus(id),
  readFocusId: () => State.focusId,
  isExpanded: () => State.mode === "expanded",
});

/** Connect Focus to the state; idempotent, call once from the island. */
export function startFocus(): void {
  Focus.start((fn) => State.subscribe(fn));
}
