// Music moods: outfits for the music Choom only, driven by what is playing.
// New track means a burst of notes plus headphones, listening means headphones
// plus a light bop, long sessions earn cool shades, pausing returns the plain
// green Choom. Everything is derived from the state on each notification, so
// no polling: timers run only while a mood timer or animation needs them.
// Hiding or unfocusing lets the wall-time anchors keep running with no
// background timers, while pausing or going inactive restarts the continuous
// clock. Mini bots in the rail stay plain.

import { State } from "../core/state";
import { Ease } from "../core/anim";
import type { BotEngine } from "../mochi/engine";
import { MUSIC_ID } from "./focus";

const easeOut = Ease.out;
const easeBack = Ease.back;

export function musicMoodsEnabled(): boolean {
  return State.settings.musicMoods !== false;
}

/** After this much uninterrupted playing the Choom is vibing. */
export const SHADES_AFTER_MS = 10 * 60_000;
/** A track restarting this soon after ending counts as a replay. */
export const REPLAY_WITHIN_MS = 30_000;
/** A position this close to the end counts as having heard the track out. */
export const REPLAY_END_WINDOW_MS = 5_000;
/** A restart counts only from this close to the start of the track. */
export const REPLAY_START_WINDOW_MS = 5_000;
/** A timed sing lasts this long, then the headphones come back. */
export const SING_MS = 8_000;
const BURST_MS = 4_000;
const BURST_EVERY_MS = 450;
const BOP_EVERY_MS = 900;
/** A short sing every few minutes until lyrics drive it. */
const SING_EVERY_MIN_MS = 4 * 60_000;
const SING_EVERY_SPREAD_MS = 2 * 60_000;

interface TrackData {
  app?: unknown;
  title?: unknown;
  artist?: unknown;
  playing?: unknown;
  active?: unknown;
  positionMs?: unknown;
  durationMs?: unknown;
  updatedAtMs?: unknown;
}

export interface MoodWiring {
  engine: () => BotEngine | null;
  isMusicFocused: () => boolean;
  isPlaying: () => boolean;
  suspended: () => boolean;
}

function trackKeyOf(data: TrackData): string {
  return `${String(data.app ?? "")}~${String(data.title ?? "")}~${String(data.artist ?? "")}`;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Where the track is now. Like the player card, the position is only valid as
 * of updatedAtMs, so playing time since then is added; without a timestamp the
 * reported position is used as is, which keeps boundary tests deterministic.
 */
function effectivePosition(data: TrackData, now: number): { pos: number; dur: number } {
  const dur = readNumber(data.durationMs);
  const reported = readNumber(data.positionMs);
  if (dur <= 0) return { pos: reported, dur };
  const updated = readNumber(data.updatedAtMs);
  const live = updated > 0 && data.playing === true
    ? reported + Math.max(0, now - updated)
    : reported;
  return { pos: Math.min(dur, Math.max(0, live)), dur };
}

export class MusicMood {
  private wiring: MoodWiring | null = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private lastTrackKey: string | null = null;
  /** Tracks left while playing, with when: returning to one counts as replay. */
  private recentEnds: { key: string; at: number }[] = [];
  /** When the current track was last heard near its end, for replay checks. */
  private endSeenAt = 0;
  /** Was the data playing on the previous sync, for pause detection. */
  private prevPlaying = false;
  /**
   * Continuous playing of the current track. Pausing or going inactive resets
   * it; hiding or unfocusing lets the wall-time anchor keep running, with no
   * background timers while nothing can be seen.
   */
  private playAccumMs = 0;
  private playResumeAt = 0;
  private shades = false;
  private hoverSing = false;
  private timedSing = false;

  private burstTimer: ReturnType<typeof setInterval> | null = null;
  private burstStop: ReturnType<typeof setTimeout> | null = null;
  private bopTimer: ReturnType<typeof setInterval> | null = null;
  private singTimer: ReturnType<typeof setTimeout> | null = null;
  private singStop: ReturnType<typeof setTimeout> | null = null;
  private shadesTimer: ReturnType<typeof setTimeout> | null = null;
  private singDueAt = 0;
  private singRemaining: number | undefined = undefined;

  bind(wiring: MoodWiring): void {
    this.wiring = wiring;
  }

  /** Idempotent: follow the state, like the island does. */
  start(subscribe: (fn: () => void) => () => void): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.unsubscribe = subscribe(() => this.sync());
    this.sync();
  }

  /** Hovering the large Choom while music plays sings along. */
  setHover(hovering: boolean): void {
    if (this.hoverSing === hovering) return;
    this.hoverSing = hovering;
    this.applyVisuals();
  }

  dispose(): void {
    this.disposed = true;
    this.clearRunTimers();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private get engine(): BotEngine | null {
    return this.wiring?.engine() ?? null;
  }

  private live(): boolean {
    const w = this.wiring;
    return !!w && w.isMusicFocused() && w.isPlaying() && !w.suspended();
  }

  private sync(): void {
    if (this.disposed || !this.wiring) return;
    const now = Date.now();
    const data = (State.integrations[MUSIC_ID]?.data ?? {}) as TrackData;
    const playing = data.playing === true && data.active !== false;
    const key = data.title != null || data.artist != null || data.app != null
      ? trackKeyOf(data)
      : null;

    if (key !== this.lastTrackKey) {
      const was = this.lastTrackKey;
      this.lastTrackKey = key;
      this.endSeenAt = 0;
      if (was != null && this.prevPlaying) {
        this.recentEnds.push({ key: was, at: now });
        while (this.recentEnds.length > 5) this.recentEnds.shift();
        this.recentEnds = this.recentEnds.filter((e) => now - e.at < REPLAY_WITHIN_MS);
      }
      if (key != null && playing) this.onTrack(key, now);
    } else if (key != null && playing) {
      // Same track heard out and restarted near zero: a replay. A plain
      // pause/resume or a mid-track backward seek never matches both halves.
      const { pos, dur } = effectivePosition(data, now);
      if (dur > 0 && dur - pos <= REPLAY_END_WINDOW_MS) {
        this.endSeenAt = now;
      } else if (
        pos <= REPLAY_START_WINDOW_MS &&
        this.endSeenAt !== 0 &&
        now - this.endSeenAt < REPLAY_WITHIN_MS
      ) {
        this.onReplay(now);
      }
    }

    if (!playing) this.resetPlaying();
    else if (this.live()) this.resume();
    else this.suspendWall();
    this.prevPlaying = playing;
    this.applyVisuals();
  }

  /** Bookkeeping for a track that starts playing; the burst needs the island. */
  private onTrack(key: string, now: number): void {
    const replay = this.recentEnds.some((e) => e.key === key && now - e.at < REPLAY_WITHIN_MS);
    this.recentEnds = this.recentEnds.filter((e) => now - e.at < REPLAY_WITHIN_MS);
    this.endSeenAt = 0;
    this.shades = replay;
    this.playAccumMs = 0;
    if (this.playResumeAt !== 0) this.playResumeAt = now;
    if (!this.live()) return;
    this.clearBurst();
    if (!this.reducedMotion()) {
      this.engine?.emit("note", 3);
      this.burstTimer = setInterval(() => {
        if (this.disposed || !this.live()) {
          this.clearBurst();
          return;
        }
        this.engine?.emit("note", 2);
      }, BURST_EVERY_MS);
      this.burstStop = setTimeout(() => this.clearBurst(), BURST_MS);
    }
    this.applyVisuals();
  }

  /** A replay earns shades at once and restarts the continuous clock. */
  private onReplay(now: number): void {
    this.endSeenAt = 0;
    this.shades = true;
    this.playAccumMs = 0;
    if (this.playResumeAt !== 0) this.playResumeAt = now;
  }

  private resume(): void {
    if (this.playResumeAt === 0) this.playResumeAt = Date.now();
    if (!this.shades && this.shadesTimer == null) {
      const left = SHADES_AFTER_MS - this.playedMs();
      if (left <= 0) {
        this.shades = true;
      } else {
        this.shadesTimer = setTimeout(() => {
          this.shadesTimer = null;
          if (this.disposed || !this.live()) return;
          this.shades = true;
          this.applyVisuals();
        }, left);
      }
    }
    if (this.singTimer == null && this.singStop == null) {
      const delay = this.singRemaining ?? SING_EVERY_MIN_MS + Math.random() * SING_EVERY_SPREAD_MS;
      this.singRemaining = undefined;
      this.armSing(delay);
    }
    if (this.bopTimer == null && !this.reducedMotion()) {
      this.bopTimer = setInterval(() => {
        if (this.disposed || !this.live()) return;
        const engine = this.engine;
        if (engine && engine.outfit === "headphones" && !engine.singing) {
          engine.anim("oy", [[-0.06, 160, easeOut], [0, 260, easeBack]]);
        }
      }, BOP_EVERY_MS);
    }
  }

  private armSing(delay: number): void {
    if (this.singTimer != null) return;
    this.singDueAt = Date.now() + delay;
    this.singTimer = setTimeout(() => {
      this.singTimer = null;
      if (this.disposed || !this.live()) return;
      this.timedSing = true;
      this.applyVisuals();
      this.singStop = setTimeout(() => {
        this.singStop = null;
        this.timedSing = false;
        this.applyVisuals();
        if (!this.disposed && this.live()) {
          this.armSing(SING_EVERY_MIN_MS + Math.random() * SING_EVERY_SPREAD_MS);
        }
      }, SING_MS);
    }, delay);
  }

  /**
   * Playing but nothing can be seen (hidden, unfocused, or moods off): stop
   * the timers, but let the wall-time anchors keep running so hidden
   * listening still counts as uninterrupted.
   */
  private suspendWall(): void {
    if (this.playResumeAt === 0) this.playResumeAt = Date.now();
    if (this.singTimer != null) {
      this.singRemaining = Math.max(0, this.singDueAt - Date.now());
    }
    this.clearRunTimers();
    this.timedSing = false;
  }

  /** Paused or inactive: continuous playing starts over, shades included. */
  private resetPlaying(): void {
    this.playAccumMs = 0;
    this.playResumeAt = 0;
    this.shades = false;
    this.timedSing = false;
    this.endSeenAt = 0;
    this.recentEnds = [];
    this.singRemaining = undefined;
    this.clearRunTimers();
  }

  private clearBurst(): void {
    if (this.burstTimer != null) clearInterval(this.burstTimer);
    if (this.burstStop != null) clearTimeout(this.burstStop);
    this.burstTimer = null;
    this.burstStop = null;
  }

  private clearRunTimers(): void {
    this.clearBurst();
    if (this.bopTimer != null) clearInterval(this.bopTimer);
    if (this.singTimer != null) clearTimeout(this.singTimer);
    if (this.singStop != null) clearTimeout(this.singStop);
    if (this.shadesTimer != null) clearTimeout(this.shadesTimer);
    this.bopTimer = null;
    this.singTimer = null;
    this.singStop = null;
    this.shadesTimer = null;
  }

  private playedMs(): number {
    return this.playAccumMs + (this.playResumeAt !== 0 ? Date.now() - this.playResumeAt : 0);
  }

  private reducedMotion(): boolean {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private applyVisuals(): void {
    const engine = this.engine;
    if (!engine) return;
    const w = this.wiring;
    const moods = musicMoodsEnabled();
    const on = !!w && w.isMusicFocused() && w.isPlaying() && moods && !w.suspended();
    if (!on) {
      // Paused, unfocused, hidden, or moods off: the music-only visual goes.
      engine.outfit = "none";
      engine.singing = false;
      return;
    }
    engine.outfit = this.shades ? "shades" : "headphones";
    engine.singing = this.hoverSing || this.timedSing;
  }
}

/** The shared mood driver, bound to the island engine at boot. */
export const Mood = new MusicMood();
