// Now playing: a Music pill for whatever the Windows media controls are
// playing, and the player card behind it. Event driven end to end - the pill
// appears on the first `now-playing` event and nothing here polls. The one
// timer is the elapsed clock on a visible, playing card, and it clears itself
// as soon as the card leaves the view.
//
// The card is built once per track and then updated in place, so play, pause
// and seek animate (icon crossfade, progress, elapsed) instead of replaying
// the entrance animation.

import "./choom.css";
import { Bridge, onEvent, type NowPlaying } from "../core/bridge";
import { State, type Settings } from "../core/state";
import { Focus, MUSIC_ID } from "./focus";
import { h, svg, clear } from "../views/dom";

const PILL_ID = MUSIC_ID;
const PILL_NAME = "Music";
const PILL_COLOR = "#1ED760";
/** How long a session may be gone before the pill is removed. */
const INACTIVE_GRACE_MS = 60_000;

/** Media glyphs the shared icon set doesn't carry. */
const ICON = {
  previous: "M7.2 6h2v12h-2V6zm9.8 0v12l-8.1-6L17 6z",
  next: "M14.8 6h2v12h-2V6zM7 6l8.1 6L7 18V6z",
  play: "M8.2 5.4 18.8 12 8.2 18.6V5.4z",
  pause: "M7.6 5.4h3.3v13.2H7.6V5.4zm5.5 0h3.3v13.2h-3.3V5.4z",
} as const;

/** The mounted card's updater, keyed by its element. */
const updaters = new WeakMap<HTMLElement, (data: Record<string, unknown>) => void>();

let removeTimer: number | null = null;

export function registerNowPlaying() {
  void onEvent<NowPlaying>("now-playing", apply);
  // The settings window also writes preferences; keep the pill in step.
  void onEvent<Settings>("settings-changed", (settings) => {
    State.settings = { ...State.settings, ...settings };
    syncEnabled();
  });
  // First paint, then the live events above take over.
  void Bridge.mediaSnapshot().then((snapshot) => {
    if (snapshot) apply(snapshot);
  });
}

/** Settings are read fresh, like chatSection does. */
function enabled(): boolean {
  return State.settings.nowPlaying !== false;
}

function apply(snapshot: NowPlaying) {
  if (!enabled()) return;
  if (snapshot.active) cancelRemove();
  State.integrations[PILL_ID] = {
    data: { ...snapshot },
    error: null,
    loaded: true,
    configured: true,
  };
  if (snapshot.active) {
    if (!State.tasks.some((t) => t.id === PILL_ID)) {
      // Inserted right after VS Code, and it never takes focus.
      State.upsertExternalAgent(PILL_ID, PILL_NAME, PILL_COLOR);
    }
    const pill = State.tasks.find((t) => t.id === PILL_ID);
    if (pill) pill.state = snapshot.playing ? "working" : "idle";
    maybeTrackMoment(snapshot);
  } else {
    const pill = State.tasks.find((t) => t.id === PILL_ID);
    if (pill) pill.state = "idle";
    scheduleRemove();
  }
  State.notify();
}

/** A track the pill already peeked at, and when, so repeats stay quiet. */
const peekedTracks = new Map<string, number>();
const PEEK_MEMORY_MS = 10 * 60_000;
let lastTrackKey: string | null = null;
let lastWasPlaying = false;
let seenAnySnapshot = false;

function trackKey(snapshot: NowPlaying): string {
  return `${snapshot.app}~${snapshot.title}~${snapshot.artist}`;
}

function songPeekEnabled(): boolean {
  return State.settings.songPeek !== false;
}

/**
 * One grammar for all moments: a new track borrows the pill for a few
 * seconds. Only when the track identity changes to something not peeked in
 * the last 10 minutes while playing, never on resume after a pause, and never
 * for the very first snapshot, which may be a session already in progress.
 */
function maybeTrackMoment(snapshot: NowPlaying) {
  const key = trackKey(snapshot);
  const changed = lastTrackKey !== key;
  const resumed = !changed && !lastWasPlaying;
  lastTrackKey = key;
  lastWasPlaying = snapshot.playing;
  const first = !seenAnySnapshot;
  seenAnySnapshot = true;
  if (first || !changed || resumed || !snapshot.playing) return;
  if (!songPeekEnabled()) return;
  const now = Date.now();
  for (const [k, at] of peekedTracks) {
    if (now - at > PEEK_MEMORY_MS) peekedTracks.delete(k);
  }
  if (peekedTracks.size > 50) {
    const oldest = [...peekedTracks.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) peekedTracks.delete(oldest[0]);
  }
  if (now - (peekedTracks.get(key) ?? 0) < PEEK_MEMORY_MS) return;
  peekedTracks.set(key, now);
  const title = snapshot.title.trim() || "Unknown track";
  Focus.moment({
    taskId: PILL_ID,
    kind: "track",
    line1: title,
    line2: snapshot.artist.trim() || snapshot.app.trim(),
    ms: 3500,
  });
}

/** The last enabled state we acted on; null until the first settings event. */
let showing: boolean | null = null;

/** When the toggle turns off, the pill and its data go at once. */
function syncEnabled() {
  const on = enabled();
  if (on === showing) return;
  showing = on;
  if (!on) {
    removePill();
    return;
  }
  // Coming back on: show whatever is playing now, without waiting for the
  // next media event.
  void Bridge.mediaSnapshot().then((snapshot) => {
    if (snapshot && enabled()) apply(snapshot);
  });
}

function scheduleRemove() {
  if (removeTimer != null) return;
  removeTimer = window.setTimeout(() => {
    removeTimer = null;
    removePill();
  }, INACTIVE_GRACE_MS);
}

function cancelRemove() {
  if (removeTimer == null) return;
  window.clearTimeout(removeTimer);
  removeTimer = null;
}

function removePill() {
  cancelRemove();
  delete State.integrations[PILL_ID];
  if (!State.tasks.some((t) => t.id === PILL_ID)) return;
  if (State.focusId === PILL_ID) State.focusId = "integration_claude";
  State.removeTask(PILL_ID);
}

// ── Card ──────────────────────────────────────────────────────────────────────

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function iconButton(title: string, path: string, size: number, onclick: () => void): HTMLElement {
  return h("button", { class: "np-btn", title, onclick }, svg(path, size));
}

/** The player card. Built once per track; updateNowPlayingCard drives it on. */
export function nowPlayingCard(data: Record<string, unknown>): HTMLElement {
  const artBox = h("div", { class: "np-art" });
  const title = h("div", { class: "np-title" });
  const artist = h("div", { class: "np-artist" });
  const app = h("div", { class: "np-app" });
  const elapsed = h("span", { class: "np-elapsed" });
  const total = h("span", { class: "np-total" });
  const track = h("div", { class: "np-track" }, h("div", { class: "np-fill" }));
  const progress = h("div", { class: "np-progress" }, elapsed, track, total);
  const fill = track.firstElementChild as HTMLElement;

  const play = svg(ICON.play, 12);
  play.classList.add("np-play");
  const pause = svg(ICON.pause, 12);
  pause.classList.add("np-pause");
  const toggle = h(
    "button",
    { class: "np-btn", onclick: () => void Bridge.mediaControl("toggle") },
    h("span", { class: "np-pp" }, play, pause),
  );

  const card = h(
    "div",
    { class: "int-card np-card" },
    h(
      "div",
      { class: "int-head" },
      h("i", { class: "dot", style: `width:7px;height:7px;background:${PILL_COLOR}` }),
      h("b", { text: PILL_NAME }),
      h("span", { text: "Now playing" }),
    ),
    h(
      "div",
      { class: "np-body" },
      artBox,
      h(
        "div",
        { class: "np-side" },
        title,
        artist,
        app,
        progress,
        h(
          "div",
          { class: "np-controls" },
          iconButton("Previous", ICON.previous, 11, () => void Bridge.mediaControl("previous")),
          toggle,
          iconButton("Next", ICON.next, 11, () => void Bridge.mediaControl("next")),
        ),
      ),
    ),
  );

  let current: Record<string, unknown> = {};
  let currentArt: string | null = null;
  let timer: number | null = null;
  let unsubscribe: (() => void) | null = null;

  const snapshot = () => current as unknown as Partial<NowPlaying>;

  // The position is only valid as of updatedAtMs; while paused, no time is
  // added, so the card keeps the app's real position.
  const at = () => {
    const np = snapshot();
    const position = readNumber(np.positionMs);
    const duration = readNumber(np.durationMs);
    const from = readNumber(np.updatedAtMs) || Date.now();
    const played = np.playing === true ? Math.max(0, Date.now() - from) : 0;
    const now = position + played;
    return duration > 0 ? Math.min(duration, now) : now;
  };

  const visible = () =>
    State.mode === "expanded" &&
    State.view === "overview" &&
    State.focusId === PILL_ID &&
    snapshot().playing === true;

  const stop = () => {
    if (timer == null) return;
    window.clearInterval(timer);
    timer = null;
  };
  const start = () => {
    if (timer == null) timer = window.setInterval(tick, 1000);
  };
  function tick() {
    if (!card.isConnected) {
      stop();
      unsubscribe?.();
      unsubscribe = null;
      return;
    }
    elapsed.textContent = formatTime(at());
  }

  unsubscribe = State.subscribe(() => {
    if (!card.isConnected) {
      stop();
      unsubscribe?.();
      unsubscribe = null;
      return;
    }
    if (visible()) start();
    else stop();
  });

  const update = (data: Record<string, unknown>) => {
    if (data === current) return;
    current = data;
    const np = snapshot();
    const playing = np.playing === true;
    const art = typeof np.art === "string" ? np.art : null;
    const duration = readNumber(np.durationMs);

    card.classList.toggle("playing", playing);
    title.textContent = (typeof np.title === "string" && np.title) || "Not playing";
    artist.textContent = typeof np.artist === "string" ? np.artist : "";
    app.textContent = (typeof np.app === "string" && np.app) || "Unknown app";
    toggle.title = playing ? "Pause" : "Play";

    if (art !== currentArt) {
      currentArt = art;
      if (art) {
        let img = artBox.querySelector("img");
        if (!img) {
          clear(artBox);
          artBox.classList.remove("np-art-empty");
          img = h("img", { alt: "" });
          artBox.append(img);
        }
        img.setAttribute("src", art);
        // Restart the fade, so a new cover crossfades in over the old one.
        artBox.classList.remove("np-art-new");
        void artBox.offsetWidth;
        artBox.classList.add("np-art-new");
      } else {
        clear(artBox);
        artBox.classList.add("np-art-empty");
        artBox.classList.remove("np-art-new");
        artBox.append(h("i", {}));
      }
    }

    // The bar is one transform: the current fraction, then a linear
    // transition over exactly what is left of the track.
    const fraction = duration > 0 ? Math.min(1, at() / duration) : 0;
    fill.style.transition = "none";
    fill.style.transform = `scaleX(${fraction})`;
    const left = duration - at();
    if (playing && left > 0) {
      requestAnimationFrame(() => {
        if (!card.isConnected || current !== data || snapshot().playing !== true) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          fill.style.transform = "scaleX(1)";
          return;
        }
        fill.style.transition = `transform ${duration - at()}ms linear`;
        fill.style.transform = "scaleX(1)";
      });
    }
    elapsed.textContent = formatTime(at());
    total.textContent = duration > 0 ? formatTime(duration) : "--:--";

    if (visible()) start();
    else stop();
  };

  progress.addEventListener("click", (event) => {
    const duration = readNumber(snapshot().durationMs);
    if (duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const clicked = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    void Bridge.mediaControl("seek", Math.round(clicked * duration));
  });

  updaters.set(card, update);
  update(data);
  return card;
}

/**
 * Updates the mounted player card in place: play state, art, title, progress
 * and elapsed time. Calls with the same data object are cheap no-ops, so the
 * overview can call this on every sync.
 */
export function updateNowPlayingCard(el: HTMLElement | null, data: Record<string, unknown>): void {
  if (!el) return;
  updaters.get(el)?.(data);
}
