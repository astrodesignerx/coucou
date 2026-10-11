// Landing cards: A open invitation and C small launchpad. B reuses the
// existing Music/Jobs/System cards directly, so activity stays real.
// A shares the voice lifecycle (start/stopVoice) and navigates to the
// existing demand editor, so drafts live in voiceSection alone. C reuses the
// configured Tools shortcuts and routines through the same Bridge calls and
// safeguards as toolsSection, with no illustrative targets and no invented
// progress. Timers pause when hidden or interacted with and clear once the
// card leaves the DOM.

import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { Bridge } from "../core/bridge";
import { State, type ToolRoutine, type ToolShortcut } from "../core/state";
import { Voice } from "./voice";
import { startVoice, stopVoice } from "./voiceSection";
import { sublineLines, sublineListening, LANDING_INVITATION } from "./landing";
import {
  beginRoutine,
  finishRoutine,
  readTools,
  resolveRoutineSteps,
} from "./tools";

export interface LandingHomeActions {
  onInput: () => void;
  onOpenVoice: () => void;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cardHidden(card: HTMLElement): boolean {
  if (!card.isConnected) return true;
  if (typeof document !== "undefined" && document.hidden) return true;
  if (State.mode === "hidden") return true;
  if (State.view !== "overview") return true;
  return false;
}

function interacting(card: HTMLElement): boolean {
  try {
    return card.matches(":hover") || card.matches(":focus-within");
  } catch {
    return false;
  }
}

/** Live waveform: three bars animate only while a voice turn is active. */
export function buildLandingWave(): HTMLElement {
  const wave = h("span", { class: "landing-wave", "aria-hidden": "true" },
    h("i", {}), h("i", {}), h("i", {}));
  const off = Voice.subscribe(() => {
    const active = sublineListening(Voice.state.runtime);
    wave.classList.toggle("live", active);
  });
  wave.classList.toggle("live", sublineListening(Voice.state.runtime));
  void off;
  return wave;
}

/**
 * Shared subline slot: invitation when quiet, invitation plus one real
 * music/job line rotating about every five seconds when active. Listening
 * supersedes rotation. Hidden, hovered and focused cards pause; reduced
 * motion cycles only on click. No receipts or diagnostics appear here.
 */
export function buildLandingSubline(card: HTMLElement): { el: HTMLElement; stop: () => void } {
  const btn = h("button", {
    class: "landing-subline",
    type: "button",
    title: "Show next status",
    "aria-label": "Status. Click to show next status.",
  });
  let index = 0;
  let timer: number | null = null;

  function paint(advance: boolean): void {
    if (!btn.isConnected) return;
    if (sublineListening(Voice.state.runtime)) {
      if (btn.textContent !== "Listening to you") btn.textContent = "Listening to you";
      btn.setAttribute("aria-label", "Listening to you.");
      return;
    }
    const lines = sublineLines();
    if (advance) index = (index + 1) % lines.length;
    else index = 0;
    const line = lines[index] ?? LANDING_INVITATION;
    if (btn.textContent !== line) btn.textContent = line;
    btn.setAttribute("aria-label", lines.length > 1 ? `${line}. Click to show next status.` : line);
  }

  function tick(): void {
    if (!btn.isConnected) {
      stop();
      return;
    }
    if (cardHidden(card)) return;
    if (interacting(card)) return;
    if (reducedMotion()) return;
    if (sublineListening(Voice.state.runtime)) {
      paint(false);
      return;
    }
    const lines = sublineLines();
    if (lines.length <= 1) {
      paint(false);
      return;
    }
    paint(true);
  }

  function stop(): void {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  btn.addEventListener("click", () => {
    const lines = sublineLines();
    if (lines.length <= 1) return;
    index = (index + 1) % lines.length;
    const line = lines[index] ?? LANDING_INVITATION;
    btn.textContent = line;
  });

  const offVoice = Voice.subscribe(() => paint(false));
  const offState = State.subscribe(() => paint(false));
  paint(false);
  timer = window.setInterval(tick, 5000);

  const stopAll = () => {
    stop();
    offVoice();
    offState();
  };
  return { el: btn, stop: stopAll };
}

/** Mic uses the existing voice lifecycle; Input opens the demand editor. */
export function buildLandingControls(actions: LandingHomeActions): HTMLElement {
  const mic = h("button", {
    class: "landing-mic",
    type: "button",
    title: "Talk",
    "aria-label": "Start listening",
  }, svg(ICONS.mic, 15));
  const input = h("button", {
    class: "landing-input",
    type: "button",
    title: "Type a request",
    "aria-label": "Open typing",
  }, svg(ICONS.keyboard, 15));

  mic.addEventListener("click", () => {
    if (!State.settings.voiceEnabled) {
      actions.onOpenVoice();
      return;
    }
    if (Voice.state.runtime === "listening") void stopVoice();
    else void startVoice();
  });
  input.addEventListener("click", () => actions.onInput());

  const off = Voice.subscribe(() => {
    const listening = Voice.state.runtime === "listening";
    mic.classList.toggle("on", listening);
    mic.title = listening ? "Stop listening" : "Talk";
    mic.setAttribute("aria-label", listening ? "Stop listening" : "Start listening");
    mic.setAttribute("aria-pressed", String(listening));
  });
  void off;
  const listening = Voice.state.runtime === "listening";
  mic.classList.toggle("on", listening);

  return h("div", { class: "landing-actions", role: "group", "aria-label": "Voice actions" }, mic, input);
}

/**
 * A open invitation: one heading, live waveform, one shared subline, and the
 * Mic/Input pair on the right centered vertically. No chat destination, no
 * Send, no idle caption. The lead mascot safe area matches int-card padding.
 */
export function landingHomeCard(actions: LandingHomeActions): { el: HTMLElement; stop: () => void } {
  const wave = buildLandingWave();
  const title = h("div", { class: "landing-title", text: LANDING_INVITATION });
  const prompt = h("div", { class: "landing-prompt" }, wave);
  const copy = h("div", { class: "landing-copy" }, title, prompt);
  const controls = buildLandingControls(actions);
  const root = h("div", { class: "int-card landing-home" }, copy, controls);
  const sub = buildLandingSubline(root);
  prompt.append(sub.el);
  return { el: root, stop: sub.stop };
}

// ── C launchpad ──────────────────────────────────────────────────────────────

export interface LaunchpadActions {
  onDone: () => void;
  onOpenTools: () => void;
}

function actionable(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

async function launchShortcut(s: ToolShortcut): Promise<string | null> {
  try {
    if (s.kind === "folder") await Bridge.toolsOpenFolder(s.target);
    else await Bridge.toolsLaunchApp(s.target);
    return null;
  } catch (err) {
    return actionable(err);
  }
}

async function runRoutine(r: ToolRoutine): Promise<string> {
  if (!beginRoutine(r.id)) return "A routine is already running.";
  const resolved = resolveRoutineSteps(r);
  if (resolved.some((s) => s.missing)) {
    finishRoutine(r.id);
    return "A step no longer exists. Edit the routine first.";
  }
  try {
    const results = await Bridge.toolsRoutineStart(
      r.id,
      resolved.map((s) => ({ id: s.id, kind: s.kind, target: s.target })),
    );
    const failed = (results ?? []).find((x) => x.status === "failed");
    const cancelled = (results ?? []).find((x) => x.status === "cancelled");
    if (failed) return failed.message;
    if (cancelled) return "Cancelled before every step ran.";
    return `Ran ${resolved.length} step(s).`;
  } catch (err) {
    return actionable(err);
  } finally {
    finishRoutine(r.id);
  }
}

/**
 * C small launchpad: real configured app/folder shortcuts and routines only.
 * Empty configuration offers the real Tools route. Results report what the
 * Bridge returned; nothing is invented and nothing auto-dismisses.
 */
export function landingLaunchpadCard(actions: LaunchpadActions): HTMLElement {
  const data = readTools();
  const shortcuts = (data.shortcuts ?? []).filter((s) => s.kind === "app" || s.kind === "folder");
  const routines = data.routines ?? [];
  const status = h("div", { class: "landing-status", role: "status" });
  const list = h("div", { class: "landing-tiles" });

  if (shortcuts.length === 0 && routines.length === 0) {
    list.append(h("div", { class: "landing-empty", text: "No shortcuts yet." }));
  }
  for (const s of shortcuts.slice(0, 6)) {
    const tile = h("button", { class: "landing-tile", type: "button", title: s.target },
      h("span", { class: "landing-kind", text: s.kind === "app" ? "APP" : "DIR" }),
      h("span", { class: "landing-name", text: s.name }));
    tile.setAttribute("aria-label", `Launch ${s.name}`);
    tile.addEventListener("click", () => {
      status.textContent = "";
      void launchShortcut(s).then((err) => {
        status.textContent = err ?? `Opened ${s.name}.`;
      });
    });
    list.append(tile);
  }
  for (const r of routines.slice(0, 3)) {
    const tile = h("button", { class: "landing-tile", type: "button" },
      h("span", { class: "landing-kind", text: `${r.steps.length}` }),
      h("span", { class: "landing-name", text: r.name }));
    tile.setAttribute("aria-label", `Run ${r.name}`);
    tile.title = `Run ${r.name}`;
    tile.addEventListener("click", () => {
      status.textContent = `Running ${r.name}...`;
      void runRoutine(r).then((msg) => {
        status.textContent = msg;
      });
    });
    list.append(tile);
  }

  const root = h("div", { class: "int-card landing-launch" },
    h("div", { class: "landing-launch-top" },
      h("div", { class: "landing-title", text: "Your next move." }),
      h("button", {
        class: "landing-done", type: "button", text: "Done",
        title: "Back to Home",
        "aria-label": "Back to Home",
        onclick: () => actions.onDone(),
      })),
    list,
    status);

  if (shortcuts.length === 0 && routines.length === 0) {
    const open = h("button", {
      class: "landing-open-tools", type: "button", text: "Open Tools settings",
      onclick: () => actions.onOpenTools(),
    });
    root.append(open);
  }
  return root;
}
