// Music moods: outfits for the music Choom only, driven by what is playing.
// New track means a burst of notes plus headphones, listening means headphones
// plus a light bop, long sessions earn cool shades, pausing returns the plain
// green Choom. Everything is derived from the state on each notification, so
// no polling: timers run only while a mood timer or animation needs them, and
// suspending (hidden, paused, disabled) freezes the wall-time anchors instead
// of losing them. Mini bots in the rail stay plain.

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

export class MusicMood {
  private wiring: MoodWiring | null = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private lastTrackKey: string | null = null;
  private lastEnd: { key: string; at: number } | null = null;
  /** Continuous playing, frozen across suspends. */
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
    const data = (State.integrations[MUSIC_ID]?.data ?? {}) as TrackData;
    const playing = data.playing === true && data.active !== false;
    const key = data.title != null || data.artist != null || data.app != null
      ? trackKeyOf(data)
      : null;

    if (key !== this.lastTrackKey) {
      const was = this.lastTrackKey;
      this.lastTrackKey = key;
      if (was != null && (playing || this.playResumeAt !== 0)) {
        this.lastEnd = { key: was, at: Date.now() };
      }
      if (key != null && playing) this.onTrack(key);
    }
    if (!playing && this.playResumeAt !== 0) {
      this.lastEnd = this.lastTrackKey != null
        ? { key: this.lastTrackKey, at: Date.now() }
        : this.lastEnd;
    }

    if (this.live()) this.resume();
    else this.freeze();
    this.applyVisuals();
  }

  private onTrack(key: string): void {
    if (!this.live()) return;
    const now = Date.now();
    const replay = this.lastEnd != null &&
      this.lastEnd.key === key &&
      now - this.lastEnd.at < REPLAY_WITHIN_MS;
    this.shades = replay;
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

  /** Stop timers but keep the elapsed anchors for the resume. */
  private freeze(): void {
    if (this.playResumeAt !== 0) {
      this.playAccumMs += Date.now() - this.playResumeAt;
      this.playResumeAt = 0;
    }
    if (this.singTimer != null) {
      this.singRemaining = Math.max(0, this.singDueAt - Date.now());
    }
    this.clearRunTimers();
    this.timedSing = false;
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
      // Paused, another pill focused, suspended, or moods off: plain Choom.
      if (!moods || !!w?.isMusicFocused()) {
        engine.outfit = "none";
        engine.singing = false;
      }
      return;
    }
    engine.outfit = this.shades ? "shades" : "headphones";
    engine.singing = this.hoverSing || this.timedSing;
  }
}

/** The shared mood driver, bound to the island engine at boot. */
export const Mood = new MusicMood();
