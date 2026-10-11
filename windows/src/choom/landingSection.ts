// Landing cards: A open invitation and C small launchpad. B reuses the
// existing Music/Jobs/System cards directly, so activity stays real.
// A shares the voice lifecycle through injected runners and navigates to the
// existing demand editor, so drafts live in voiceSection alone. C reuses the
// shared Tools action controller from toolsSection, with resolved-step
// previews, Run/Cancel, honest empty results and no illustrative targets.
// Timers pause when hidden or interacted with; every subscription and timer
// is owned and released when the card leaves.

import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { Bridge } from "../core/bridge";
import { State, type ToolRoutine } from "../core/state";
import { Voice, type VoiceRuntimeState } from "./voice";
import { sublineLines, LANDING_INVITATION, LANDING_SUBLINE_INVITE } from "./landing";
import {
  launchToolShortcutAction,
  runToolRoutineAction,
} from "./toolsSection";
import {
  readTools,
  resolveRoutineSteps,
  routineById,
  shortcutById,
} from "./tools";

export interface LandingHomeActions {
  onInput: () => void;
  onOpenVoice: () => void;
  onMicStart: () => void;
  onMicStop: () => void;
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

/** True while a voice turn owns the subline and rotation must pause. */
function turnActive(runtime: string): boolean {
  return runtime === "listening" || runtime === "processing" ||
    runtime === "working" || runtime === "speaking";
}

/** Real voice state in plain words; only listening implies capture. */
export function voiceStatusLabel(runtime: VoiceRuntimeState): string {
  switch (runtime) {
    case "listening": return "Listening to you";
    case "processing": return "Heard it, thinking";
    case "working": return "Working";
    case "speaking": return "Speaking";
    case "error": return "Needs attention";
    case "disabled": return "Voice off";
    default: return "Standing by";
  }
}

/** Live waveform: bars animate only while audio is actually captured. */
export function buildLandingWave(): { el: HTMLElement; stop: () => void } {
  const wave = h("span", { class: "landing-wave", "aria-hidden": "true" },
    h("i", {}), h("i", {}), h("i", {}));
  let stopped = false;
  const sync = () => {
    if (stopped) return;
    wave.classList.toggle("live", Voice.state.runtime === "listening");
  };
  const off = Voice.subscribe(sync);
  sync();
  return {
    el: wave,
    stop() {
      if (stopped) return;
      stopped = true;
      off();
    },
  };
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Shared subline slot: invitation when quiet, invitation plus one real
 * music/job line rotating about every five seconds when active. A voice turn
 * supersedes rotation with its real state label. Hidden, hovered and focused
 * cards pause; reduced motion cycles only on click. No receipts appear here.
 * Live updates refresh line text without resetting the rotation cadence, and
 * an explicit click never replaces an active turn status.
 */
export function buildLandingSubline(
  card: HTMLElement,
  opts?: { onDetach?: () => void },
): { el: HTMLElement; stop: () => void } {
  const btn = h("button", {
    class: "landing-subline",
    type: "button",
    title: "Show next status",
    "aria-label": "Status. Click to show next status.",
  });
  let lines: string[] = [LANDING_SUBLINE_INVITE];
  let index = 0;
  let timer: number | null = null;
  let stopped = false;

  function render(): void {
    const line = lines[index] ?? LANDING_SUBLINE_INVITE;
    if (btn.textContent !== line) btn.textContent = line;
    btn.setAttribute("aria-label", lines.length > 1 ? `${line}. Click to show next status.` : line);
  }

  function renderTurn(): void {
    const label = voiceStatusLabel(Voice.state.runtime);
    if (btn.textContent !== label) btn.textContent = label;
    btn.setAttribute("aria-label", `${label}.`);
  }

  /** Live refresh: new text flows in, the rotation slot is preserved. */
  function refresh(): void {
    if (stopped) return;
    if (turnActive(Voice.state.runtime)) {
      renderTurn();
      return;
    }
    const next = sublineLines();
    if (!sameLines(next, lines)) {
      lines = next;
      if (index >= lines.length) index = 0;
    }
    render();
  }

  function tick(): void {
    if (stopped) return;
    if (!btn.isConnected) {
      // Detached without an explicit stop: release the whole card scope,
      // not just this slot, so no callback survives its DOM.
      if (opts?.onDetach) opts.onDetach();
      else stopAll();
      return;
    }
    if (cardHidden(card)) return;
    if (interacting(card)) return;
    if (reducedMotion()) return;
    if (turnActive(Voice.state.runtime)) {
      renderTurn();
      return;
    }
    const next = sublineLines();
    if (!sameLines(next, lines)) {
      lines = next;
      if (index >= lines.length) index = 0;
      render();
      return;
    }
    if (lines.length <= 1) {
      render();
      return;
    }
    index = (index + 1) % lines.length;
    render();
  }

  function stopTimer(): void {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function stopAll(): void {
    if (stopped) return;
    stopped = true;
    stopTimer();
    offVoice();
    offState();
  }

  btn.addEventListener("click", () => {
    if (stopped) return;
    if (turnActive(Voice.state.runtime)) return;
    refresh();
    if (lines.length <= 1) return;
    index = (index + 1) % lines.length;
    render();
  });

  const offVoice = Voice.subscribe(refresh);
  const offState = State.subscribe(refresh);
  refresh();
  timer = window.setInterval(tick, 5000);

  return { el: btn, stop: stopAll };
}

/** Mic runs the injected voice lifecycle; Input opens the demand editor. */
export function buildLandingControls(actions: LandingHomeActions): { el: HTMLElement; stop: () => void } {
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
    if (Voice.state.runtime === "listening") actions.onMicStop();
    else actions.onMicStart();
  });
  input.addEventListener("click", () => actions.onInput());

  let stopped = false;
  const sync = () => {
    if (stopped) return;
    const listening = Voice.state.runtime === "listening";
    mic.classList.toggle("on", listening);
    mic.title = listening ? "Stop listening" : "Talk";
    mic.setAttribute("aria-label", listening ? "Stop listening" : "Start listening");
    mic.setAttribute("aria-pressed", String(listening));
  };
  const off = Voice.subscribe(sync);
  sync();

  return {
    el: h("div", { class: "landing-actions", role: "group", "aria-label": "Voice actions" }, mic, input),
    stop() {
      if (stopped) return;
      stopped = true;
      off();
    },
  };
}

/**
 * A open invitation: one heading, live waveform, one shared subline, and the
 * Mic/Input pair on the right centered vertically. No chat destination, no
 * Send, no idle caption. The lead mascot safe area matches int-card padding.
 */
export function landingHomeCard(actions: LandingHomeActions): { el: HTMLElement; stop: () => void } {
  const wave = buildLandingWave();
  const title = h("div", { class: "landing-title", text: LANDING_INVITATION });
  const prompt = h("div", { class: "landing-prompt" }, wave.el);
  const copy = h("div", { class: "landing-copy" }, title, prompt);
  const controls = buildLandingControls(actions);
  const root = h("div", { class: "int-card landing-home" }, copy, controls.el);
  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    wave.stop();
    controls.stop();
    sub.stop();
  }
  const sub = buildLandingSubline(root, { onDetach: stop });
  prompt.append(sub.el);
  return { el: root, stop };
}

// ── C launchpad ──────────────────────────────────────────────────────────────

export interface LaunchpadActions {
  onDone: () => void;
  onOpenTools: () => void;
}

function stepKindLabel(kind: string): string {
  if (kind === "folder") return "Open folder";
  if (kind === "app") return "Open application";
  if (kind === "file") return "Open file";
  if (kind === "url") return "Open link";
  return "Saved shortcut";
}

/**
 * C small launchpad: real configured app/folder shortcuts and routines only.
 * Routine tiles open the existing resolved-step preview with Run/Cancel, and
 * steps re-resolve at Run time so edited targets never run stale. Empty and
 * null backend results report honestly instead of claiming success. Empty
 * configuration offers the real Tools route.
 */
export function landingLaunchpadCard(actions: LaunchpadActions): { el: HTMLElement; stop: () => void } {
  const data = readTools();
  const shortcuts = (data.shortcuts ?? []).filter((s) => s.kind === "app" || s.kind === "folder");
  const routines = data.routines ?? [];
  const status = h("div", { class: "landing-status", role: "status" });
  const list = h("div", { class: "landing-tiles" });
  const preview = h("div", { class: "landing-preview" });
  let selectedRoutineId: string | null = null;
  let runningRoutineId: string | null = null;
  let runSeq = 0;
  let cancelled = false;
  let stopped = false;

  function asset(kind: string): HTMLElement {
    const art = h("span", { class: "landing-asset", "aria-hidden": "true" });
    art.dataset.kind = kind;
    return art;
  }

  function paintPreview(): void {
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    if (selectedRoutineId == null || stopped) return;
    const routine = routineById(selectedRoutineId);
    if (!routine) {
      selectedRoutineId = null;
      return;
    }
    const resolved = resolveRoutineSteps(routine);
    const steps = h("ol", { class: "landing-steps" });
    for (const step of resolved) {
      steps.append(h("li", { class: step.missing ? "missing" : "" },
        h("b", { text: step.missing ? `${step.id} (missing)` : step.name }),
        h("small", { text: step.missing ? "Shortcut missing, edit the routine" : stepKindLabel(step.kind) })));
    }
    const running = runningRoutineId === routine.id;
    const run = h("button", {
      class: "landing-run", type: "button",
      text: running ? "Running..." : `Run ${routine.name}`,
    }) as HTMLButtonElement;
    run.disabled = running || runningRoutineId != null;
    run.addEventListener("click", () => void startRun(routine));
    preview.append(steps, h("div", { class: "landing-preview-row" }, run));
    if (running) {
      const cancel = h("button", { class: "landing-cancel", type: "button", text: "Cancel" });
      cancel.addEventListener("click", () => {
        cancelled = true;
        void Bridge.toolsRoutineCancel();
      });
      preview.querySelector(".landing-preview-row")?.append(cancel);
    }
  }

  async function startRun(routine: ToolRoutine): Promise<void> {
    const fresh = routineById(routine.id);
    if (!fresh) {
      status.textContent = "That routine is gone. Pick again.";
      paintPreview();
      return;
    }
    const previewed = resolveRoutineSteps(fresh).map((s) => `${s.id}:${s.target}`).join("|");
    runningRoutineId = fresh.id;
    cancelled = false;
    const seq = ++runSeq;
    status.textContent = `Running ${fresh.name}...`;
    paintPreview();
    const outcome = await runToolRoutineAction(fresh, () => cancelled);
    if (stopped || seq !== runSeq) return;
    runningRoutineId = null;
    if (cancelled) {
      status.textContent = "Cancelled before every step ran.";
      paintPreview();
      return;
    }
    const rerun = resolveRoutineSteps(routineById(fresh.id) ?? fresh)
      .map((s) => `${s.id}:${s.target}`).join("|");
    if (rerun !== previewed) {
      status.textContent = "A step changed while running. Review before running again.";
      paintPreview();
      return;
    }
    const names = (outcome.results ?? []).map((r) => {
      const found = shortcutById(r.id);
      return `${found ? found.name : r.id}: ${r.message}`;
    });
    status.textContent = outcome.message;
    if (names.length > 0) status.title = names.join("; ");
    paintPreview();
  }

  if (shortcuts.length === 0 && routines.length === 0) {
    list.append(h("div", { class: "landing-empty", text: "No shortcuts yet." }));
  }
  for (const s of shortcuts.slice(0, 6)) {
    const tile = h("button", { class: "landing-tile", type: "button", title: s.target },
      asset(s.kind),
      h("span", { class: "landing-kind", text: s.kind === "app" ? "APP" : "DIR" }),
      h("span", { class: "landing-name", text: s.name }));
    tile.setAttribute("aria-label", `Launch ${s.name}`);
    tile.addEventListener("click", () => {
      if (stopped) return;
      status.textContent = "";
      status.title = "";
      void launchToolShortcutAction(s).then((err) => {
        if (stopped) return;
        status.textContent = err ?? `Opened ${s.name}.`;
      });
    });
    list.append(tile);
  }
  for (const r of routines.slice(0, 3)) {
    const tile = h("button", { class: "landing-tile", type: "button" },
      asset("routine"),
      h("span", { class: "landing-kind", text: `${r.steps.length}` }),
      h("span", { class: "landing-name", text: r.name }));
    tile.setAttribute("aria-label", `Preview ${r.name}`);
    tile.title = `Preview ${r.name}: steps show before every run`;
    tile.addEventListener("click", () => {
      if (stopped) return;
      selectedRoutineId = selectedRoutineId === r.id ? null : r.id;
      status.textContent = "";
      status.title = "";
      paintPreview();
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
    preview,
    status);

  if (shortcuts.length === 0 && routines.length === 0) {
    const open = h("button", {
      class: "landing-open-tools", type: "button", text: "Open Tools settings",
      onclick: () => actions.onOpenTools(),
    });
    root.append(open);
  }
  return {
    el: root,
    stop() {
      stopped = true;
      runSeq += 1;
    },
  };
}
