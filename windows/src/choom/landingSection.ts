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
import { State } from "../core/state";
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
 * Routine tiles capture the reviewed plan at preview time and show each
 * resolved target; Run compares against the live configuration and requires
 * another deliberate click when anything changed, so stale plans never
 * launch. Shortcut tiles resolve the live shortcut at click time and fail
 * when removed. Empty and dishonest backend results report honestly.
 */
export function landingLaunchpadCard(actions: LaunchpadActions): { el: HTMLElement; stop: () => void } {
  const status = h("div", { class: "landing-status", role: "status" });
  const list = h("div", { class: "landing-tiles" });
  const preview = h("div", { class: "landing-preview" });
  let selectedRoutineId: string | null = null;
  /** Reviewed plan captured when the preview painted: id, kind, target, order. */
  let reviewedPlan: { routineId: string; key: string } | null = null;
  let runningRoutineId: string | null = null;
  let runSeq = 0;
  let cancelled = false;
  let stopped = false;
  let lastToolsKey = "";

  function planKey(resolved: { id: string; kind: string; target: string; missing: boolean }[]): string {
    return resolved.map((s) => `${s.id}|${s.kind}|${s.target}|${s.missing ? "1" : "0"}`).join("~");
  }

  function toolsKey(): string {
    const data = readTools();
    return JSON.stringify({ s: data.shortcuts ?? [], r: data.routines ?? [] });
  }

  function asset(kind: string): HTMLElement {
    const art = h("span", { class: "landing-asset", "aria-hidden": "true" });
    art.dataset.kind = kind;
    return art;
  }

  function paintPreview(): void {
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    if (selectedRoutineId == null || stopped) {
      reviewedPlan = null;
      return;
    }
    const routine = routineById(selectedRoutineId);
    if (!routine) {
      selectedRoutineId = null;
      reviewedPlan = null;
      return;
    }
    const resolved = resolveRoutineSteps(routine);
    reviewedPlan = { routineId: routine.id, key: planKey(resolved) };
    const steps = h("ol", { class: "landing-steps" });
    for (const step of resolved) {
      const item = h("li", { class: step.missing ? "missing" : "" },
        h("b", { text: step.missing ? `${step.id} (missing)` : step.name }),
        h("small", { text: step.missing ? "Shortcut missing, edit the routine" : `${stepKindLabel(step.kind)}: ${step.target}` }));
      item.title = step.missing ? step.id : step.target;
      steps.append(item);
    }
    const running = runningRoutineId === routine.id;
    const run = h("button", {
      class: "landing-run", type: "button",
      text: running ? "Running..." : `Run ${routine.name}`,
    }) as HTMLButtonElement;
    run.disabled = running || runningRoutineId != null;
    run.addEventListener("click", () => void startRun(routine.id));
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

  async function startRun(routineId: string): Promise<void> {
    const routine = routineById(routineId);
    if (!routine) {
      selectedRoutineId = null;
      reviewedPlan = null;
      status.textContent = "That routine is gone. Pick again.";
      paintPreview();
      State.notify();
      return;
    }
    // Freshness gate: the reviewed plan must still match the live
    // configuration, or the preview refreshes and another click is required.
    const live = resolveRoutineSteps(routine);
    if (!reviewedPlan || reviewedPlan.routineId !== routine.id || reviewedPlan.key !== planKey(live)) {
      paintPreview();
      status.textContent = "The routine changed. Review the steps and run again.";
      status.title = "";
      State.notify();
      return;
    }
    if (live.some((s) => s.missing)) {
      status.textContent = "A step no longer exists. Edit the routine first.";
      paintPreview();
      State.notify();
      return;
    }
    runningRoutineId = routine.id;
    cancelled = false;
    const seq = ++runSeq;
    status.textContent = `Running ${routine.name}...`;
    status.title = "";
    paintPreview();
    State.notify();
    const outcome = await runToolRoutineAction(routine, () => cancelled);
    if (stopped || seq !== runSeq) return;
    runningRoutineId = null;
    if (cancelled) {
      status.textContent = "Cancelled before every step ran.";
      status.title = (outcome.results ?? []).map((r) => `${r.id}: ${r.message}`).join("; ");
      paintPreview();
      State.notify();
      return;
    }
    const names = (outcome.results ?? []).map((r) => {
      const found = shortcutById(r.id);
      return `${found ? found.name : r.id}: ${r.message}`;
    });
    status.textContent = outcome.message;
    status.title = names.join("; ");
    paintPreview();
    State.notify();
  }

  function renderTiles(): void {
    const active = (typeof document !== "undefined" ? document.activeElement : null) as HTMLElement | null;
    const activeLabel = active && list.contains(active) ? active.getAttribute("aria-label") : null;
    while (list.firstChild) list.removeChild(list.firstChild);
    const data = readTools();
    const shortcuts = (data.shortcuts ?? []).filter((s) => s.kind === "app" || s.kind === "folder");
    const routines = data.routines ?? [];
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
        // Resolve the live shortcut: a removed or retargeted entry can never
        // launch an obsolete target from stale card data.
        const live = shortcutById(s.id);
        if (!live || (live.kind !== "app" && live.kind !== "folder")) {
          status.textContent = "That shortcut is gone.";
          status.title = "";
          renderTiles();
          paintPreview();
          State.notify();
          return;
        }
        status.textContent = "";
        status.title = "";
        void launchToolShortcutAction(live).then((err) => {
          if (stopped) return;
          status.textContent = err ?? `Opened ${live.name}.`;
          State.notify();
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
        State.notify();
      });
      list.append(tile);
    }
    if (activeLabel) {
      const again = Array.from(list.querySelectorAll(".landing-tile"))
        .find((t) => t.getAttribute("aria-label") === activeLabel);
      (again as HTMLElement | undefined)?.focus?.();
    }
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

  lastToolsKey = toolsKey();
  renderTiles();
  paintPreview();

  const offTools = State.subscribe(() => {
    if (stopped) return;
    const key = toolsKey();
    if (key === lastToolsKey) return;
    lastToolsKey = key;
    if (selectedRoutineId && !routineById(selectedRoutineId)) selectedRoutineId = null;
    renderTiles();
    paintPreview();
    State.notify();
  });

  if (readTools().shortcuts.length === 0 && readTools().routines.length === 0) {
    const open = h("button", {
      class: "landing-open-tools", type: "button", text: "Open Tools settings",
      onclick: () => actions.onOpenTools(),
    });
    root.append(open);
  }
  mountedLaunchCard = root;
  return {
    el: root,
    stop() {
      stopped = true;
      runSeq += 1;
      offTools();
    },
  };
}

/** C-owned island height: measured content demand, bounded like other cards. */
let mountedLaunchCard: HTMLElement | null = null;

/** Chrome around the measured tile, preview and status regions. */
const LAUNCH_CHROME = 120;
const LAUNCH_MIN_H = 184;
const LAUNCH_MAX_H = 320;

export function landingLaunchpadHeight(): number {
  if (mountedLaunchCard?.isConnected) {
    const tiles = mountedLaunchCard.querySelector(".landing-tiles") as HTMLElement | null;
    const preview = mountedLaunchCard.querySelector(".landing-preview") as HTMLElement | null;
    const status = mountedLaunchCard.querySelector(".landing-status") as HTMLElement | null;
    const demand = (tiles ? tiles.scrollHeight : 0) +
      (preview ? preview.scrollHeight : 0) +
      (status ? status.scrollHeight : 0) + LAUNCH_CHROME;
    return Math.min(LAUNCH_MAX_H, Math.max(LAUNCH_MIN_H, Math.ceil(demand)));
  }
  const data = readTools();
  const tiles = Math.min(6, (data.shortcuts ?? []).length) +
    Math.min(3, (data.routines ?? []).length);
  const rows = Math.max(1, Math.ceil(tiles / 2));
  return Math.min(LAUNCH_MAX_H, Math.max(LAUNCH_MIN_H, 100 + rows * 44));
}
