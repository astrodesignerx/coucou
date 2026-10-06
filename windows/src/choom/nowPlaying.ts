// Now playing: a Music pill for whatever the Windows media controls are
// playing, and the player card behind it. Event driven end to end - the pill
// appears on the first `now-playing` event and nothing here polls. The one
// timer is the elapsed clock on a visible, playing card, and it clears itself
// as soon as the card leaves the view.

import "./choom.css";
import { Bridge, onEvent, type NowPlaying } from "../core/bridge";
import { State, type Settings } from "../core/state";
import { h, svg } from "../views/dom";

const PILL_ID = "integration_music";
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

let removeTimer: number | null = null;
/** The art of the last card, so a track change can crossfade it. */
let lastArt: string | null = null;

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
  } else {
    const pill = State.tasks.find((t) => t.id === PILL_ID);
    if (pill) pill.state = "idle";
    scheduleRemove();
  }
  State.notify();
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
  lastArt = null;
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

/** The player card, shown in the overview's left card like every integration. */
export function nowPlayingCard(data: Record<string, unknown>): HTMLElement {
  const snapshot = data as unknown as Partial<NowPlaying>;
  const playing = snapshot.playing === true;
  const title = typeof snapshot.title === "string" ? snapshot.title : "";
  const artist = typeof snapshot.artist === "string" ? snapshot.artist : "";
  const app = typeof snapshot.app === "string" ? snapshot.app : "";
  const art = typeof snapshot.art === "string" ? snapshot.art : null;
  const position = readNumber(snapshot.positionMs);
  const duration = readNumber(snapshot.durationMs);
  // The position is anchored to when Rust read it, not to when this card ran.
  const from = readNumber(snapshot.updatedAtMs) || Date.now();
  const at = () => {
    const now = position + Math.max(0, Date.now() - from);
    return duration > 0 ? Math.min(duration, now) : now;
  };

  const artBox = h("div", { class: "np-art" });
  if (art) {
    const img = h("img", { alt: "", src: art });
    if (art !== lastArt) artBox.classList.add("np-art-new");
    artBox.append(img);
  } else {
    artBox.classList.add("np-art-empty");
    artBox.append(h("i", {}));
  }
  lastArt = art;

  const elapsed = h("span", { class: "np-elapsed", text: formatTime(position) });
  const total = h("span", { class: "np-total", text: duration > 0 ? formatTime(duration) : "--:--" });

  const track = h("div", { class: "np-track" }, h("div", { class: "np-fill" }));
  const progress = h("div", { class: "np-progress" }, elapsed, track, total);
  const fill = track.firstChild as HTMLElement;
  const fraction = duration > 0 ? Math.min(1, at() / duration) : 0;
  fill.style.transform = `scaleX(${fraction})`;

  const play = svg(ICON.play, 12);
  play.classList.add("np-play");
  const pause = svg(ICON.pause, 12);
  pause.classList.add("np-pause");

  const card = h(
    "div",
    { class: playing ? "int-card np-card playing" : "int-card np-card" },
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
        h("div", { class: "np-title", text: title || "Not playing" }),
        h("div", { class: "np-artist", text: artist }),
        h("div", { class: "np-app", text: app || "Unknown app" }),
        progress,
        h(
          "div",
          { class: "np-controls" },
          iconButton("Previous", ICON.previous, 11, () => void Bridge.mediaControl("previous")),
          h(
            "button",
            {
              class: "np-btn",
              title: playing ? "Pause" : "Play",
              onclick: () => void Bridge.mediaControl("toggle"),
            },
            h("span", { class: "np-pp" }, play, pause),
          ),
          iconButton("Next", ICON.next, 11, () => void Bridge.mediaControl("next")),
        ),
      ),
    ),
  );

  progress.addEventListener("click", (event) => {
    if (duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const clicked = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    void Bridge.mediaControl("seek", Math.round(clicked * duration));
  });

  if (playing && duration > position) {
    // Time is the one place linear timing is right: one frame at the current
    // position, then a transition over exactly what is left of the track.
    requestAnimationFrame(() => {
      if (!card.isConnected) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        fill.style.transform = "scaleX(1)";
        return;
      }
      fill.style.transition = `transform ${duration - position}ms linear`;
      fill.style.transform = "scaleX(1)";
    });
    startElapsed(card, elapsed, snapshot, at);
  }

  return card;
}

/**
 * The one timer of this feature: the elapsed clock while the card is on
 * screen and playing. It stops when the card is hidden, paused or gone;
 * the elapsed time is recomputed from its anchor, so it always catches up.
 */
function startElapsed(
  card: HTMLElement,
  elapsed: HTMLElement,
  snapshot: Partial<NowPlaying>,
  at: () => number,
): void {
  let timer: number | null = null;

  const stop = () => {
    if (timer == null) return;
    window.clearInterval(timer);
    timer = null;
  };
  const start = () => {
    if (timer == null) timer = window.setInterval(tick, 1000);
  };
  const visible = () =>
    State.mode === "expanded" &&
    State.view === "overview" &&
    State.focusId === PILL_ID &&
    snapshot.playing === true;

  function tick() {
    if (!card.isConnected) {
      stop();
      unsubscribe();
      return;
    }
    elapsed.textContent = formatTime(at());
  }

  const unsubscribe = State.subscribe(() => {
    if (!card.isConnected) {
      stop();
      unsubscribe();
      return;
    }
    if (visible()) start();
    else stop();
  });

  if (visible()) start();
}
