// Music moods: outfits for the music Choom only, driven by what is playing.
// While playing, floating notes drift by default with no headphones outfit.
// Hover or timed singing adds the sing mouth on top of the notes, pausing
// returns the plain green Choom. Everything is derived from the state on each
// notification, so no polling: timers run only while a mood timer or animation
// needs them. Hidden or unfocused music runs no animation timers. Mini bots
// stay plain.

import { State } from "../core/state";
import type { BotEngine } from "../mochi/engine";
import { MUSIC_ID } from "./focus";

/** A timed sing lasts this long, then the notes continue without the mouth. */
export const SING_MS = 8_000;
const BURST_MS = 4_000;
const BURST_EVERY_MS = 450;
/** While playing, a note drifts up this often until pause. */
const PLAY_STREAM_EVERY_MS = 2_400;
/** While singing, a note drifts up this often until the song ends. */
const SING_STREAM_EVERY_MS = 800;
/** A short sing every few minutes until lyrics drive it. */
const SING_EVERY_MIN_MS = 4 * 60_000;
const SING_EVERY_SPREAD_MS = 2 * 60_000;

export function musicMoodsEnabled(): boolean {
  return State.settings.musicMoods !== false;
}

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

export class MusicMood {
  private wiring: MoodWiring | null = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private lastTrackKey: string | null = null;
  private hoverSing = false;
  private timedSing = false;

  private burstTimer: ReturnType<typeof setInterval> | null = null;
  private burstStop: ReturnType<typeof setTimeout> | null = null;
  private playStreamTimer: ReturnType<typeof setInterval> | null = null;
  private singStreamTimer: ReturnType<typeof setInterval> | null = null;
  private singTimer: ReturnType<typeof setTimeout> | null = null;
  private singStop: ReturnType<typeof setTimeout> | null = null;
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
      ? trackKeyOf(data) : null;
    if (key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      if (key != null && playing) this.onTrack();
    }

    if (!playing) this.resetPlaying();
    else if (this.live()) this.resume();
    else this.suspendWall();
    this.applyVisuals();
  }

  /** Bookkeeping for a track that starts playing; the burst needs the island. */
  private onTrack(): void {
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

  private resume(): void {
    if (this.singTimer == null && this.singStop == null) {
      const delay = this.singRemaining ?? SING_EVERY_MIN_MS + Math.random() * SING_EVERY_SPREAD_MS;
      this.singRemaining = undefined;
      this.armSing(delay);
    }
    this.startPlayStream();
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

  /** Stop animation timers while hidden or unfocused. */
  private suspendWall(): void {
    if (this.singTimer != null) {
      this.singRemaining = Math.max(0, this.singDueAt - Date.now());
    }
    this.clearRunTimers();
    this.timedSing = false;
  }

  /** Paused or inactive: clear music animations. */
  private resetPlaying(): void {
    this.timedSing = false;
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
    this.stopPlayStream();
    this.stopSingStream();
    if (this.singTimer != null) clearTimeout(this.singTimer);
    if (this.singStop != null) clearTimeout(this.singStop);
    this.singTimer = null;
    this.singStop = null;
  }

  private reducedMotion(): boolean {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Floating notes while playing: one gentle stream, started once. */
  private startPlayStream(): void {
    if (this.playStreamTimer != null || this.reducedMotion()) return;
    this.playStreamTimer = setInterval(() => {
      if (this.disposed || !this.live() || this.reducedMotion()) {
        this.stopPlayStream();
        return;
      }
      this.engine?.emit("note", 1);
    }, PLAY_STREAM_EVERY_MS);
  }

  private stopPlayStream(): void {
    if (this.playStreamTimer != null) clearInterval(this.playStreamTimer);
    this.playStreamTimer = null;
  }

  /** Notes while singing: one short stream, started once, stopped at once. */
  private startSingStream(): void {
    if (this.singStreamTimer != null || this.reducedMotion()) return;
    this.engine?.emit("note", 1);
    this.singStreamTimer = setInterval(() => {
      const engine = this.engine;
      if (this.disposed || !this.live() || !engine?.singing || this.reducedMotion()) {
        this.stopSingStream();
        return;
      }
      engine.emit("note", 1);
    }, SING_STREAM_EVERY_MS);
  }

  private stopSingStream(): void {
    if (this.singStreamTimer != null) clearInterval(this.singStreamTimer);
    this.singStreamTimer = null;
  }

  private applyVisuals(): void {
    const engine = this.engine;
    if (!engine) return;
    const w = this.wiring;
    const moods = musicMoodsEnabled();
    const on = !!w && w.isMusicFocused() && w.isPlaying() && moods && !w.suspended();
    if (!on) {
      // Paused, unfocused, hidden, or moods off: plain Choom, no notes.
      engine.outfit = "none";
      engine.singing = false;
      this.stopPlayStream();
      this.stopSingStream();
      return;
    }
    // No headphones by default: floating notes carry the playing state.
    engine.outfit = "none";
    engine.singing = this.hoverSing || this.timedSing;
    if (!this.reducedMotion()) {
      this.startPlayStream();
      if (engine.singing) this.startSingStream();
      else this.stopSingStream();
    } else {
      this.stopPlayStream();
      this.stopSingStream();
    }
  }
}

/** The shared mood driver, bound to the island engine at boot. */
export const Mood = new MusicMood();
