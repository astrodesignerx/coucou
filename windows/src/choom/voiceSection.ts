// Choom voice deck and settings. A compact default, B for extended
// transcript and multi-step work, C for selected context and click approvals.
// Main mascot stays left with existing size and padding. No visible
// scrollbars, no duplicate headings, no cockpit decoration.
//
// Production calls use the live Bridge. The fixture injects VoiceDeps mocks
// for deterministic preview only; no simulated values reach production.

import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { Bridge, type ChatContext, type RoutineStep, type VoiceMemory, type VoiceToolOption, type VoiceToolRoute } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type Settings } from "../core/state";
import type { ViewHost } from "../views/views";
import { submitChatTurn, currentChatOwner, cancelChatTurn } from "../views/chat";
import { routineById, resolveRoutineSteps } from "./tools";
import {
  Voice, TRANSCRIPT_PAGE, clampEndpointMs, noteSubmitted, noteSubmittedSegments, speakPreview,
  validDeckMode, wasSubmitted, type VoiceDeckMode,
} from "./voice";

/** Everything the deck touches outside itself. Production default is live. */
export interface VoiceDeps {
  voiceCapability: () => Promise<{ supported: boolean; recognizers: string[]; voices: string[]; error: string | null } | null>;
  openSettings: () => Promise<void>;
  voiceListenStart: (muted: boolean) => Promise<number>;
  voiceListenStop: () => Promise<void>;
  voiceCancel: () => Promise<number>;
  voiceSpeak: (text: string, generation: number) => Promise<void>;
  voiceSpeakStop: () => Promise<void>;
  voiceWakeSet: (enabled: boolean) => Promise<void>;
  voiceMute: (muted: boolean) => Promise<void>;
  voiceDeviceRecover: () => Promise<void>;
  voiceToolRun: (kind: string, target: string, generation: number) => Promise<string>;
  voiceWindowSnapshot: () => Promise<{ appName: string; title: string } | null>;
  voiceToolResolve: (utterance: string) => Promise<VoiceToolRoute>;
  voiceProviderCheck: () => Promise<void>;
  voiceMemoryList: () => Promise<VoiceMemory[]>;
  voiceMemoryAdd: (text: string) => Promise<VoiceMemory>;
  voiceMemoryUpdate: (id: string, text: string) => Promise<VoiceMemory>;
  voiceMemoryRemove: (id: string) => Promise<void>;
  voiceMemoryClear: () => Promise<void>;
  toolsPickDocument: () => Promise<string | null>;
  toolsRoutineStart: (routineId: string, steps: RoutineStep[]) => Promise<import("../core/bridge").StepResult[]>;
  mediaControl: (action: "play" | "pause" | "next" | "previous" | "toggle") => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  chatTurn: (
    query: string,
    context: ChatContext | null,
    onHeight: () => void,
    owner: number,
  ) => Promise<{ text: string } | { error: string }>;
}

const liveDeps: VoiceDeps = {
  voiceCapability: () => Bridge.voiceCapability(),
  openSettings: () => Bridge.openSettingsWindow().then(() => undefined),
  voiceListenStart: (muted) => Bridge.voiceListenStart(muted),
  voiceListenStop: () => Bridge.voiceListenStop().then(() => undefined),
  voiceCancel: () => Bridge.voiceCancel(),
  voiceSpeak: (text, generation) => Bridge.voiceSpeak(text, generation).then(() => undefined),
  voiceSpeakStop: () => Bridge.voiceSpeakStop().then(() => undefined),
  voiceWakeSet: (enabled) => Bridge.voiceWakeSet(enabled),
  voiceMute: (muted) => Bridge.voiceMute(muted),
  voiceDeviceRecover: () => Bridge.voiceDeviceRecover(),
  voiceToolRun: (kind, target, generation) => Bridge.voiceToolRun(kind, target, generation),
  voiceWindowSnapshot: () => Bridge.voiceWindowSnapshot(),
  voiceToolResolve: (utterance) => Bridge.voiceToolResolve(utterance),
  voiceProviderCheck: () => Bridge.voiceProviderCheck(),
  voiceMemoryList: () => Bridge.voiceMemoryList().then((list) => list ?? []),
  voiceMemoryAdd: (text) => Bridge.voiceMemoryAdd(text),
  voiceMemoryUpdate: (id, text) => Bridge.voiceMemoryUpdate(id, text),
  voiceMemoryRemove: (id) => Bridge.voiceMemoryRemove(id),
  voiceMemoryClear: () => Bridge.voiceMemoryClear(),
  toolsPickDocument: () => Bridge.toolsPickDocument(),
  toolsRoutineStart: (routineId, steps) => Bridge.toolsRoutineStart(routineId, steps),
  mediaControl: (action) => Bridge.mediaControl(action).then(() => undefined),
  saveSettings: (settings) => Bridge.saveSettings(settings).then(() => undefined),
  chatTurn: (query, context, onHeight, owner) => submitChatTurn(query, context, onHeight, owner),
};

let deps: VoiceDeps = liveDeps;

/** Fixture only: isolated mock adapters for deterministic preview. */
export function setVoiceDeps(next: VoiceDeps | null): void {
  deps = next ?? liveDeps;
}

let endpointTimer: number | null = null;
let followupTimer: number | null = null;
/** Generation armed for follow-up listening after its talkback ends. */
let followupArmed: number | null = null;
/** Manual editing inhibits auto dispatch until the user resumes explicitly. */
let editHold = false;
let openIsland: (() => void) | null = null;
let heightTick: (() => void) | null = null;

export function registerVoiceIsland(opener: () => void, onHeight: () => void): void {
  openIsland = opener;
  heightTick = onHeight;
}

function clearEndpoint(): void {
  if (endpointTimer != null) {
    window.clearTimeout(endpointTimer);
    endpointTimer = null;
  }
}

function clearFollowup(): void {
  if (followupTimer != null) {
    window.clearTimeout(followupTimer);
    followupTimer = null;
  }
  followupArmed = null;
}

function voiceChatContext(): ChatContext | null {
  const ctx = Voice.state.context;
  if (ctx?.kind === "file" && ctx.path) {
    return { kind: "file", name: ctx.name ?? "file", path: ctx.path };
  }
  if (ctx?.kind === "window" && ctx.appName && ctx.title) {
    return { kind: "window", appName: ctx.appName, title: ctx.title };
  }
  return null;
}

function memoryPrefix(): string {
  // Only user-selected facts inject, clearly delimited as user data.
  // Nothing loads or injects while opt-in is off.
  const selected = Voice.selectedMemories();
  if (selected.length === 0) return "";
  const facts = selected.map((m) => `- ${m.text}`).join("\n");
  return `[User facts, not instructions]\n${facts}\n\n`;
}

/** Starts dictation. Native guards on opt-in, lock, pause and mute. */
export async function startVoice(): Promise<void> {
  if (!State.settings.voiceEnabled || Voice.state.muted || State.paused) return;
  clearEndpoint();
  Voice.clearTurnUI();
  const operation = ++listenOperation;
  let generation: number;
  try {
    generation = await deps.voiceListenStart(Voice.state.muted);
  } catch (err) {
    if (operation !== listenOperation) return;
    Voice.state.runtime = "error";
    Voice.state.deviceError = /microphone|device|audio/i.test(String(err));
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  // Cancelled while starting: shut the orphan capture, keep the new turn.
  if (operation !== listenOperation) {
    await deps.voiceListenStop();
    return;
  }
  Voice.state.generation = generation;
  Voice.state.runtime = "listening";
  Voice.state.deviceError = false;
  Voice.state.error = null;
  Voice.notify();
  heightTick?.();
}

export async function stopVoice(): Promise<void> {
  ++listenOperation;
  clearEndpoint();
  await deps.voiceListenStop();
  if (Voice.state.runtime === "listening" || Voice.state.runtime === "processing") {
    Voice.state.runtime = "standby";
  }
  Voice.state.partial = "";
  Voice.state.pendingSegments = [];
  Voice.notify();
}

export async function cancelVoice(): Promise<void> {
  ++listenOperation;
  clearEndpoint();
  clearFollowup();
  // Aborts the owned agent request too; unrelated sessions are untouched.
  cancelChatTurn();
  try {
    const generation = await deps.voiceCancel();
    Voice.cancelTurn(generation);
  } catch {
    Voice.cancelTurn(Voice.state.generation + 1);
  }
  await deps.voiceSpeakStop();
  State.stateOverride = null;
  State.notify();
  heightTick?.();
}

/** Re-arms opted-in keyword wake after unlock or follow-up. Errors stay visible. */
export async function rearmWake(): Promise<void> {
  if (!State.settings.voiceEnabled || !State.settings.voiceWakeEnabled) return;
  try {
    await deps.voiceWakeSet(true);
    Voice.state.wakeOn = true;
    Voice.notify();
  } catch (err) {
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

/** Local session close: native already stopped capture, so only clear UI. */
export function localVoiceStandby(): void {
  clearEndpoint();
  clearFollowup();
  Voice.state.partial = "";
  Voice.state.pendingSegments = [];
  Voice.state.runtime = "standby";
  Voice.clearTurnUI();
  Voice.notify();
  heightTick?.();
}

let listenOperation = 0;

function currentGeneration(): number {
  return Voice.state.generation;
}

function fenced(generation: number): boolean {
  return Voice.state.generation === generation;
}

/** Submits the aggregated utterance exactly once with its generation id. */
export async function submitVoiceFinal(
  text: string,
  generation: number,
  opts: { manual?: boolean; segments?: string[] } = {},
): Promise<void> {
  const clean = text.trim();
  if (!clean || wasSubmitted(generation, clean)) return;
  if (!fenced(generation)) return;
  // No second request while one is working; the turn owns the deck.
  if (Voice.state.runtime === "working") return;
  noteSubmittedSegments(generation, clean, opts.segments ?? [clean]);
  clearEndpoint();
  // Stop actual capture once a turn submits.
  await deps.voiceListenStop();
  if (!fenced(generation)) return;
  Voice.state.runtime = "working";
  Voice.notify();

  // Deterministic local tools first: offline pause and saved launches work
  // with no LLM credentials at all.
  try {
    const route = await deps.voiceToolResolve(clean);
    if (!fenced(generation)) return;
    if (route && route.kind === "media" && route.action) {
      const action = route.action as "play" | "pause" | "next" | "previous" | "toggle";
      await deps.mediaControl(action);
      if (!fenced(generation)) return;
      Voice.state.receipt = { target: "Music", status: "ok", message: `Music ${route.action}.` };
      await speakResult(`Music ${route.action}.`, generation);
      return;
    }
    if (route && (route.kind === "app" || route.kind === "folder") && route.target) {
      const target = route.target;
      try {
        // Generation-guarded native run: stale turns never launch.
        await deps.voiceToolRun(route.kind, target, generation);
        if (!fenced(generation)) return;
        Voice.state.receipt = { target, status: "ok", message: "Opened." };
        await speakResult("Opened.", generation);
      } catch (err) {
        if (!fenced(generation)) return;
        // A failed action is shown, never repeated as an agent request.
        Voice.state.receipt = {
          target,
          status: "failed",
          message: String(err).replace(/^Error:\s*/, ""),
        };
        Voice.state.runtime = "standby";
        Voice.notify();
      }
      return;
    }
    if (route && route.kind === "routine" && route.routineId) {
      // Routines show the ordered saved steps and run only on Run click.
      Voice.state.routinePreview = { routineId: route.routineId, name: route.reason ?? route.routineId };
      Voice.state.runtime = "standby";
      Voice.notify();
      heightTick?.();
      return;
    }
    if (route && route.kind === "ambiguous") {
      Voice.state.ambiguity = route.options ?? [];
      Voice.state.error = route.reason ?? "Pick one.";
      Voice.state.runtime = "standby";
      Voice.notify();
      heightTick?.();
      return;
    }
    if (route && route.kind === "refused") {
      Voice.state.approvalNote = route.reason ?? "That needs a click.";
      Voice.state.runtime = "standby";
      Voice.notify();
      return;
    }
  } catch {
    // Tool routing failure falls through to the agent path honestly.
  }
  if (!fenced(generation)) return;

  // Agent path needs the free-only gate; local tools above never did.
  try {
    await deps.voiceProviderCheck();
  } catch (err) {
    if (!fenced(generation)) return;
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  if (!fenced(generation)) return;

  // One shared implementation for voice and typed turns, owner fenced.
  const context = voiceChatContext();
  const query = memoryPrefix() + clean;
  const owner = currentChatOwner();
  State.stateOverride = "thinking";
  State.notify();
  const outcome = await deps.chatTurn(query, context, () => heightTick?.(), owner);
  if (!fenced(generation)) return;
  if ("error" in outcome) {
    if (outcome.error === "cancelled" || outcome.error === "busy") {
      Voice.state.runtime = "standby";
      State.stateOverride = null;
      Voice.notify();
      return;
    }
    State.stateOverride = null;
    Voice.state.runtime = "error";
    Voice.state.error = outcome.error;
    Voice.notify();
    return;
  }
  State.stateOverride = null;
  // The owned result excerpt lives on the card; the full text is one click
  // away in the shared chat history. No invented progress, just the reply.
  Voice.state.receipt = { target: "Agent", status: "ok", message: excerpt(outcome.text) };
  await speakResult(outcome.text, generation);
}

/** First line of a reply for the card, bounded and single-line. */
function excerpt(reply: string, maxChars = 140): string {
  return reply.split("\n")[0]?.trim().slice(0, maxChars) ?? "";
}

/** Speaks a short result, then arms actual follow-up recognition. */
async function speakResult(short: string, generation: number): Promise<void> {
  if (!fenced(generation)) return;
  Voice.state.runtime = "speaking";
  Voice.notify();
  followupArmed = generation;
  await deps.voiceSpeak(speakPreview(short), generation);
}

/** Manual send: the edit field or the aggregated segments, exactly once. */
export async function manualVoiceSubmit(editValue: string): Promise<void> {
  clearEndpoint();
  editHold = false;
  const generation = currentGeneration();
  const trimmed = editValue.trim();
  if (trimmed) {
    await submitVoiceFinal(trimmed, generation, { manual: true });
    return;
  }
  const { aggregate, segments } = Voice.takeSegments();
  if (!aggregate) return;
  await submitVoiceFinal(aggregate, generation, { manual: true, segments });
}

/** Runs one exact ambiguity choice. Nothing is guessed. */
export async function runVoiceChoice(option: VoiceToolOption): Promise<void> {
  const generation = currentGeneration();
  Voice.state.ambiguity = [];
  Voice.state.error = null;
  Voice.state.runtime = "working";
  Voice.notify();
  try {
    await deps.voiceToolRun(option.kind, option.target, generation);
    if (!fenced(generation)) return;
    Voice.state.receipt = { target: option.target, status: "ok", message: "Opened." };
    await speakResult("Opened.", generation);
  } catch (err) {
    if (!fenced(generation)) return;
    Voice.state.receipt = {
      target: option.target,
      status: "failed",
      message: String(err).replace(/^Error:\s*/, ""),
    };
    Voice.state.runtime = "standby";
    Voice.notify();
  }
}

/** Runs the previewed routine's saved steps on an explicit click. */
export async function runVoiceRoutine(): Promise<void> {
  const preview = Voice.state.routinePreview;
  if (!preview) return;
  const generation = currentGeneration();
  const routine = routineById(preview.routineId);
  if (!routine) {
    Voice.state.error = "That routine is gone. Pick again.";
    Voice.state.routinePreview = null;
    Voice.notify();
    return;
  }
  const resolved = resolveRoutineSteps(routine);
  if (resolved.some((s) => s.missing)) {
    Voice.state.error = "A step no longer exists. Edit the routine first.";
    Voice.notify();
    return;
  }
  Voice.state.routinePreview = null;
  Voice.state.runtime = "working";
  Voice.notify();
  try {
    const results = await deps.toolsRoutineStart(
      routine.id,
      resolved.map((s) => ({ id: s.id, kind: s.kind, target: s.target })),
    );
    if (!fenced(generation)) return;
    const failed = (results ?? []).find((r) => r.status === "failed");
    const cancelled = (results ?? []).find((r) => r.status === "cancelled");
    Voice.state.receipt = {
      target: routine.name,
      status: failed ? "failed" : "ok",
      message: failed
        ? failed.message
        : cancelled
          ? "Cancelled before every step ran."
          : `Ran ${resolved.length} step(s).`,
    };
    await speakResult(
      failed ? `Routine stopped: ${failed.message}` : `Routine ${routine.name} finished.`,
      generation,
    );
  } catch (err) {
    if (!fenced(generation)) return;
    Voice.state.receipt = {
      target: routine.name,
      status: "failed",
      message: String(err).replace(/^Error:\s*/, ""),
    };
    Voice.state.runtime = "standby";
    Voice.notify();
  }
}

function scheduleSubmit(generation: number): void {
  clearEndpoint();
  // Manual mode never auto-submits, and an edited turn stays manual until
  // the user sends or resumes auto-send explicitly.
  if (!State.settings.voiceAutoSubmit || editHold) return;
  const delay = clampEndpointMs(State.settings.voiceEndpointMs);
  endpointTimer = window.setTimeout(() => {
    endpointTimer = null;
    const { aggregate, segments } = Voice.takeSegments();
    void submitVoiceFinal(aggregate, generation, { segments });
  }, delay);
}

/** Production voice events from the helper. No synthesized wake events here. */
export function handleVoiceEvent(evt: { name: string; payload: unknown }): void {
  if (evt.name !== "voice-event") return;
  const payload = evt.payload as { kind: string; text?: string; generation?: number; message?: string };
  const kind = payload.kind;
  const generation = payload.generation ?? Voice.state.generation;
  if (payload.generation != null && generation < currentGeneration()) return;
  switch (kind) {
    case "partial":
      if (payload.text && Voice.applyPartial(payload.text, generation)) {
        // Wait for final recognition before scheduling task execution.
        clearEndpoint();
      }
      break;
    case "final":
      if (payload.text) {
        // Segments aggregate into one utterance; only finalization arms the
        // endpoint that submits it exactly once.
        if (Voice.applyFinal(payload.text, generation)) scheduleSubmit(generation);
        heightTick?.();
      }
      break;
    case "wake":
      if (Voice.state.muted || State.paused || !State.settings.voiceWakeEnabled || !State.settings.voiceEnabled) break;
      Voice.state.wakeOn = true;
      Voice.notify();
      openIsland?.();
      Sound.play("blip");
      void startVoice();
      break;
    case "listening":
      Voice.state.generation = generation;
      Voice.state.runtime = "listening";
      Voice.notify();
      break;
    case "speech_started":
      Voice.state.runtime = "speaking";
      Voice.notify();
      break;
    case "speech_ended":
      if (Voice.state.runtime === "speaking") {
        // Follow-up starts actual recognition after TTS completion.
        if (followupArmed === generation && fenced(generation) && !Voice.state.muted && !State.paused) {
          void beginFollowup(generation);
        } else {
          Voice.state.runtime = "standby";
          Voice.notify();
        }
      }
      break;
    case "cancelled":
      ++listenOperation;
      Voice.cancelTurn(generation);
      break;
    case "recovered":
      Voice.state.deviceError = false;
      Voice.state.error = null;
      Voice.state.runtime = "standby";
      Voice.notify();
      break;
    case "helper_exited":
      Voice.state.runtime = "error";
      Voice.state.error = "Voice helper exited. Start listening again to recover.";
      Voice.notify();
      break;
    case "error": {
      Voice.state.runtime = "error";
      // Captions preserve text after errors: stable lines stay, and errors
      // stay visible until the next explicit start, retry or cancel.
      const message = payload.message ?? payload.text ?? "Voice error.";
      Voice.state.error = message;
      Voice.state.deviceError = /microphone|device|audio|recognizer/i.test(message);
      Voice.notify();
      break;
    }
    default:
      break;
  }
  heightTick?.();
}

/** Follow-up window: real recognition now, wake re-arm or shutdown at the end.
 * The start is owned by an operation token, not the old generation: the
 * native reply carries the actual new generation, and the timeout is
 * scheduled against it, so a delayed reply after cancel cannot resurrect. */
async function beginFollowup(completedGeneration: number): Promise<void> {
  if (followupArmed !== completedGeneration || !fenced(completedGeneration)) return;
  followupArmed = null;
  const operation = ++listenOperation;
  let next: number;
  try {
    next = await deps.voiceListenStart(Voice.state.muted);
  } catch (err) {
    // Cancelled while starting: stay quiet and keep the new turn.
    if (operation !== listenOperation) return;
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  // A delayed reply after cancel must not resurrect: shut the orphan
  // capture instead of adopting it.
  if (operation !== listenOperation) {
    await deps.voiceListenStop();
    return;
  }
  Voice.state.generation = next;
  Voice.state.runtime = "listening";
  Voice.notify();
  heightTick?.();
  clearFollowup();
  followupTimer = window.setTimeout(() => {
    followupTimer = null;
    void endFollowup(next);
  }, State.settings.voiceFollowupMs);
}

async function endFollowup(generation: number): Promise<void> {
  if (currentGeneration() !== generation) return;
  await deps.voiceListenStop();
  if (currentGeneration() !== generation) return;
  // The window ends by actual wake re-arm or capture shutdown, never drift.
  if (Voice.state.wakeOn && State.settings.voiceWakeEnabled && State.settings.voiceEnabled) {
    try {
      await deps.voiceWakeSet(true);
    } catch (err) {
      if (currentGeneration() !== generation) return;
      Voice.state.runtime = "error";
      Voice.state.error = String(err).replace(/^Error:\s*/, "");
      Voice.notify();
      return;
    }
  }
  if (currentGeneration() !== generation) return;
  Voice.state.runtime = "standby";
  Voice.notify();
  heightTick?.();
}

// ── Deck view ─────────────────────────────────────────────────────────────

let mountedVoiceCard: HTMLElement | null = null;

/** Island height follows the deck content, clamped to the panel. The
 * voice-main scrollHeight is the content demand: unlike the card, which is
 * height 100 percent and would feed back its old size, the inner content
 * sizes naturally, bounded by transcript pages. */
export function voiceIslandHeight(): number {
  const main = mountedVoiceCard?.querySelector(".voice-main") as HTMLElement | null;
  if (main?.isConnected) {
    const demand = main.scrollHeight + 56;
    return Math.min(320, Math.max(160, Math.ceil(demand)));
  }
  const mode = Voice.deckMode();
  if (mode === "c") return 264;
  if (mode === "b") return 232;
  return 184;
}

export function buildVoiceView(onHeightChange: () => void): ViewHost {
  const partial = h("div", { class: "voice-partial" });
  const stable = h("div", { class: "voice-stable" });
  const pager = h("div", { class: "voice-pager" });
  const error = h("div", { class: "voice-error" });
  const receipt = h("div", { class: "voice-receipt" });
  const choices = h("div", { class: "voice-choices" });
  const ctxRow = h("div", { class: "voice-context" });
  const attachRow = h("div", { class: "voice-attach" });
  const edit = h("input", {
    type: "text", class: "voice-edit", placeholder: "Edit before sending…", spellcheck: "false",
  }) as HTMLInputElement;
  const modeRow = h("div", { class: "voice-modes" });

  const micBtn = h("button", { class: "voice-mic", title: "Talk (Ctrl+Shift+V)" }, svg(ICONS.bubble, 13));
  micBtn.addEventListener("click", () => {
    if (!State.settings.voiceEnabled) {
      void deps.openSettings();
      return;
    }
    if (Voice.state.runtime === "listening") void stopVoice();
    else void startVoice();
  });
  const stopBtn = h("button", { class: "voice-stop", title: "Stop (Esc)" }, svg(ICONS.plus, 11));
  stopBtn.addEventListener("click", () => void cancelVoice());
  const sendBtn = h("button", { class: "voice-send", title: "Send" }, svg(ICONS.arrowUp, 11));
  sendBtn.addEventListener("click", () => {
    const text = edit.value;
    edit.value = "";
    void manualVoiceSubmit(text);
  });
  // Typing stops the endpoint and holds auto dispatch: an edited turn never
  // auto-submits mid-edit, and later partials cannot re-arm it until Send
  // or an explicit auto-send resume.
  edit.addEventListener("input", () => {
    clearEndpoint();
    editHold = true;
  });
  edit.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      const text = edit.value;
      edit.value = "";
      void manualVoiceSubmit(text);
    }
  });

  const modes: VoiceDeckMode[] = ["auto", "a", "b", "c"];
  for (const m of modes) {
    const btn = h("button", {
      class: "voice-mode",
      text: m === "auto" ? "Auto" : m.toUpperCase(),
      title: m === "auto" ? "Automatic deck" : `Pin deck ${m.toUpperCase()}`,
      onclick: () => {
        Voice.state.deckPin = m;
        State.settings.voiceMode = m;
        void deps.saveSettings(State.settings);
        Voice.notify();
        onHeightChange();
      },
    });
    btn.dataset.mode = m;
    modeRow.append(btn);
  }

  const autoSend = h("button", {
    class: "voice-autosend",
    title: "Send automatically after a pause",
    onclick: () => {
      State.settings.voiceAutoSubmit = !State.settings.voiceAutoSubmit;
      if (!State.settings.voiceAutoSubmit) clearEndpoint();
      else editHold = false;
      void deps.saveSettings(State.settings);
      Voice.notify();
    },
  });

  const muteBtn = h("button", {
    class: "voice-mute",
    title: "Mute the microphone",
    onclick: () => void toggleMute(),
  });

  const attachWindow = h("button", {
    class: "voice-attach-btn", text: "Attach window",
    onclick: () => void snapshotWindowContext(),
  });
  const attachFile = h("button", {
    class: "voice-attach-btn", text: "Attach file",
    onclick: () => void attachDocument(),
  });
  attachRow.append(attachWindow, attachFile);

  const status = h("div", { class: "voice-status" });
  const body = h("div", { class: "voice-body" }, status, stable, pager, partial, error, receipt, choices, ctxRow, attachRow, edit);
  const controls = h("div", { class: "voice-controls" }, micBtn, muteBtn, stopBtn, sendBtn, autoSend, modeRow);
  const card = h("div", { class: "card wash voice-card" }, h("div", { class: "voice-main" }, body, controls));
  card.style.setProperty("--wash", "rgba(34,211,238,0.30)");
  mountedVoiceCard = card;
  const el = h("div", { class: "view" }, card);

  Voice.subscribe(() => sync());
  State.subscribe(() => sync());

  /** Key of the rendered transcript: mode, page and line ids. Unchanged
   * content keeps its DOM nodes, so partial updates never restart the
   * line fade animations. */
  let renderedStableKey = "";

  function sync(): void {
    const mode = Voice.deckMode();
    el.dataset.deck = mode;
    status.textContent = runtimeLabel();
    const lines = mode === "a"
      ? Voice.state.stable.slice(-1)
      : mode === "b"
        ? Voice.state.stable.slice(
          Voice.state.page * TRANSCRIPT_PAGE,
          Voice.state.page * TRANSCRIPT_PAGE + TRANSCRIPT_PAGE,
        )
        : Voice.state.stable.slice(-2);
    const key = [mode, Voice.state.page, lines.map((l) => l.id).join(",")].join("|");
    if (key !== renderedStableKey) {
      renderedStableKey = key;
      clear(stable);
      clear(pager);
      for (const line of lines) {
        stable.append(h("div", { class: "voice-line", text: line.text }));
      }
      if (mode === "b") {
        // B: the bounded transcript in pages, no scrollbars.
        const total = Voice.state.stable.length;
        const pages = Math.max(1, Math.ceil(total / TRANSCRIPT_PAGE));
        const at = Math.min(Math.max(0, Voice.state.page), pages - 1);
        Voice.state.page = at;
        if (pages > 1) {
          const prev = h("button", {
            class: "voice-page", text: "Earlier",
            onclick: () => { Voice.state.page = Math.max(0, at - 1); Voice.notify(); },
          }) as HTMLButtonElement;
          const next = h("button", {
            class: "voice-page", text: "Later",
            onclick: () => { Voice.state.page = Math.min(pages - 1, at + 1); Voice.notify(); },
          }) as HTMLButtonElement;
          prev.disabled = at === 0;
          next.disabled = at === pages - 1;
          pager.append(prev, h("span", { class: "voice-pagecount", text: `${at + 1}/${pages}` }), next);
        }
      }
    }
    partial.textContent = Voice.state.partial;
    partial.style.display = Voice.state.partial ? "" : "none";
    error.textContent = Voice.state.error ?? "";
    error.style.display = Voice.state.error ? "" : "none";
    if (Voice.state.error && Voice.state.deviceError) {
      const recover = h("button", {
        class: "voice-recover", text: "Recover device",
        onclick: () => void recoverDevice(),
      });
      error.append(recover);
    }
    clear(choices);
    if (Voice.state.ambiguity.length > 0) {
      for (const option of Voice.state.ambiguity) {
        choices.append(h("button", {
          class: "voice-choice", text: `${option.name}`,
          title: option.target,
          onclick: () => void runVoiceChoice(option),
        }));
      }
    }
    clear(receipt);
    // The owned result excerpt reads on the card in every deck: compact in
    // A, beside the transcript in B, with approvals in C.
    if (Voice.state.receipt) {
      receipt.append(h("div", {
        class: "voice-receipt-line",
        text: `${Voice.state.receipt.target}: ${Voice.state.receipt.message}`,
      }));
    }
    if (mode === "c") {
      if (Voice.state.routinePreview) {
        const id = Voice.state.routinePreview.routineId;
        const routine = routineById(id);
        const steps = routine ? resolveRoutineSteps(routine) : [];
        const list = h("ol", { class: "voice-steps" });
        for (const step of steps) {
          list.append(h("li", { text: step.missing ? `${step.name} (missing)` : step.name }));
        }
        const run = h("button", {
          class: "btn primary",
          text: `Run ${routine?.name ?? id}`,
          onclick: () => void runVoiceRoutine(),
        });
        receipt.append(h("div", { class: "voice-routine" }, list, run));
      }
      if (Voice.state.approvalNote) {
        receipt.append(h("div", { class: "voice-approval", text: Voice.state.approvalNote }));
      }
      const selected = Voice.selectedMemories();
      if (selected.length > 0) {
        receipt.append(h("div", {
          class: "voice-memory",
          text: `Remembering: ${selected.map((m) => m.text).join("; ")}`,
        }));
      }
    }
    clear(ctxRow);
    if (Voice.state.context) {
      const remove = h("button", {
        class: "voice-ctx-remove", text: "Remove",
        onclick: () => Voice.clearContext(),
      });
      ctxRow.append(h("span", { class: "voice-ctx-label", text: Voice.state.context.label }), remove);
      ctxRow.style.display = "";
    } else {
      ctxRow.style.display = "none";
    }
    attachRow.style.display = mode === "c" ? "" : "none";
    micBtn.classList.toggle("on", Voice.state.runtime === "listening");
    micBtn.title = !State.settings.voiceEnabled
      ? "Voice is off. Open Settings to turn it on."
      : Voice.state.runtime === "listening" ? "Stop listening" : "Talk (Ctrl+Shift+V)";
    muteBtn.textContent = Voice.state.muted ? "Unmute" : "Mute";
    muteBtn.classList.toggle("on", Voice.state.muted);
    muteBtn.title = Voice.state.muted ? "Unmute the microphone" : "Mute the microphone";
    stopBtn.style.display =
      Voice.state.runtime === "speaking" || Voice.state.runtime === "working" || Voice.state.runtime === "processing"
        ? "" : "none";
    autoSend.textContent = State.settings.voiceAutoSubmit ? "Auto-send on" : "Auto-send off";
    autoSend.classList.toggle("on", State.settings.voiceAutoSubmit);
    for (const btn of modeRow.querySelectorAll("button")) {
      (btn as HTMLElement).classList.toggle("on", (btn as HTMLElement).dataset.mode === Voice.state.deckPin);
    }
  }

  sync();
  return { el, sync, focus() { edit.focus(); } };
}

/** Authoritative mute: closes capture natively and blocks every re-arm. */
async function toggleMute(): Promise<void> {
  const next = !Voice.state.muted;
  try {
    await deps.voiceMute(next);
  } catch (err) {
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  Voice.state.muted = next;
  if (next) {
    clearEndpoint();
    clearFollowup();
    Voice.state.partial = "";
    Voice.state.pendingSegments = [];
    if (Voice.state.runtime === "listening" || Voice.state.runtime === "processing") {
      Voice.state.runtime = "standby";
    }
  }
  Voice.notify();
}

/** Live runtime state in plain words: observable, never an unlabeled mic. */
function runtimeLabel(): string {
  if (Voice.state.muted) return "Muted";
  switch (Voice.state.runtime) {
    case "listening": return "Listening";
    case "processing": return "Heard it, thinking";
    case "working": return "Working";
    case "speaking": return "Speaking";
    case "error": return "Needs attention";
    case "disabled": return "Voice off";
    default: return "Standing by";
  }
}

async function recoverDevice(): Promise<void> {
  Voice.state.error = null;
  Voice.notify();
  try {
    await deps.voiceDeviceRecover();
  } catch (err) {
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

// ── Settings section ──────────────────────────────────────────────────────

interface VoiceSectionOpts {
  getSettings: () => Settings;
  save: () => Promise<void>;
}

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

export function voiceSettingsSection(opts: VoiceSectionOpts): HTMLElement {
  const s = () => opts.getSettings();
  const status = h("div", { class: "hint", text: "Checking speech engines…" });
  const voices = h("select", {}) as HTMLSelectElement;

  async function refreshCapability(): Promise<void> {
    const cap = await deps.voiceCapability().catch(() => null);
    if (!cap) {
      status.textContent = "Speech status unavailable outside Choom.";
      return;
    }
    Voice.state.recognizers = cap.recognizers;
    Voice.state.voices = cap.voices;
    Voice.state.capabilityError = cap.error;
    if (!cap.supported) {
      status.textContent = cap.error ?? "No speech recognizer installed.";
    } else {
      status.textContent = `${cap.recognizers.length} recognizer(s), ${cap.voices.length} voice(s).`;
    }
    clear(voices);
    voices.append(h("option", { value: "", text: "System default" }));
    for (const v of cap.voices.slice(0, 20)) voices.append(h("option", { value: v, text: v }));
    voices.value = s().voiceSpeechVoice;
    Voice.notify();
  }

  const endpoint = h("input", {
    type: "range", min: "300", max: "3000", step: "100", value: String(s().voiceEndpointMs),
  }) as HTMLInputElement;
  const endpointLabel = h("span", { class: "hint", text: `${s().voiceEndpointMs} ms` });
  endpoint.addEventListener("input", () => {
    s().voiceEndpointMs = clampEndpointMs(Number(endpoint.value));
    endpointLabel.textContent = `${s().voiceEndpointMs} ms`;
    void opts.save();
  });

  const rate = h("input", {
    type: "range", min: "-10", max: "10", step: "1", value: String(s().voiceSpeechRate),
  }) as HTMLInputElement;
  rate.addEventListener("change", () => {
    s().voiceSpeechRate = Number(rate.value);
    void opts.save();
  });
  const volume = h("input", {
    type: "range", min: "0", max: "100", step: "5", value: String(s().voiceSpeechVolume),
  }) as HTMLInputElement;
  volume.addEventListener("change", () => {
    s().voiceSpeechVolume = Number(volume.value);
    void opts.save();
  });
  voices.value = s().voiceSpeechVoice;
  voices.addEventListener("change", () => {
    s().voiceSpeechVoice = voices.value;
    void opts.save();
  });

  const audition = h("button", { text: "Audition" });
  audition.addEventListener("click", async () => {
    // User-triggered audition only: speaks a short sample once.
    await deps.voiceSpeak("Choom voice check.", Voice.state.generation);
  });

  const memInput = h("input", {
    type: "text", placeholder: "Add a fact to remember…", style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const memList = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  async function refreshMemories(): Promise<void> {
    clear(memList);
    // Nothing loads while opt-in is off.
    if (!s().voiceMemoryEnabled) {
      Voice.state.memories = [];
      Voice.state.selectedMemoryIds = [];
      Voice.notify();
      return;
    }
    const list = await deps.voiceMemoryList().catch(() => []);
    Voice.state.memories = list.map((m) => ({ id: m.id, text: m.text, createdMs: m.createdMs, source: m.source }));
    Voice.state.selectedMemoryIds = Voice.state.selectedMemoryIds.filter((id) =>
      Voice.state.memories.some((m) => m.id === id),
    );
    for (const m of Voice.state.memories) {
      const checked = Voice.state.selectedMemoryIds.includes(m.id);
      const box = h("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = checked;
      box.title = "Inject this fact with the next voice turn";
      box.addEventListener("change", () => {
        const at = Voice.state.selectedMemoryIds.indexOf(m.id);
        if (box.checked && at < 0) Voice.state.selectedMemoryIds.push(m.id);
        if (!box.checked && at >= 0) Voice.state.selectedMemoryIds.splice(at, 1);
        Voice.notify();
      });
      const when = new Date(m.createdMs).toLocaleString();
      const label = h("span", { class: "hint", text: `${m.text} (${m.source}, ${when})` });
      const editBtn = h("button", { text: "Edit" });
      editBtn.addEventListener("click", () => {
        clear(memList);
        const field = h("input", { type: "text", value: m.text, style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
        const saveBtn = h("button", { class: "primary", text: "Save" });
        saveBtn.addEventListener("click", async () => {
          try {
            await deps.voiceMemoryUpdate(m.id, field.value);
            await refreshMemories();
          } catch (err) {
            status.textContent = String(err).replace(/^Error:\s*/, "");
          }
        });
        const back = h("button", { text: "Back" });
        back.addEventListener("click", () => void refreshMemories());
        memList.append(h("div", { class: "row" }, field, saveBtn, back));
        field.focus();
        field.select();
      });
      const del = h("button", { text: "Forget" });
      del.addEventListener("click", async () => {
        await deps.voiceMemoryRemove(m.id);
        await refreshMemories();
      });
      memList.append(h("div", { class: "row" }, box, label, editBtn, del));
    }
    Voice.notify();
  }
  const memAdd = h("button", { text: "Remember" });
  memAdd.addEventListener("click", async () => {
    const value = memInput.value.trim();
    if (!value) return;
    try {
      const added = await deps.voiceMemoryAdd(value);
      Voice.state.selectedMemoryIds.push(added.id);
      memInput.value = "";
      await refreshMemories();
    } catch (err) {
      status.textContent = String(err).replace(/^Error:\s*/, "");
    }
  });

  let forgetArmed = false;
  const forgetAll = h("button", { class: "danger", text: "Forget all" });
  forgetAll.addEventListener("click", async () => {
    if (!forgetArmed) {
      forgetArmed = true;
      forgetAll.textContent = "Click again to forget everything";
      window.setTimeout(() => {
        forgetArmed = false;
        forgetAll.textContent = "Forget all";
      }, 4000);
      return;
    }
    forgetArmed = false;
    forgetAll.textContent = "Forget all";
    await deps.voiceMemoryClear();
    await refreshMemories();
  });

  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Voice" })),
    h("div", { class: "hint", text: "Opt-in only. Voice and wake stay off until you turn them on. Wake standby is the one low-power exception to hidden zero CPU." }),
    status,
    h("div", { class: "row" }, h("label", { text: "Voice" }), toggle(s().voiceEnabled, (v) => {
      s().voiceEnabled = v;
      Voice.state.runtime = v ? "standby" : "disabled";
      if (!v) void cancelVoice();
      void opts.save();
      Voice.notify();
    })),
    h("div", { class: "row" }, h("label", { text: "Wake word" }), toggle(s().voiceWakeEnabled, async (v) => {
      s().voiceWakeEnabled = v;
      try {
        await deps.voiceWakeSet(v);
      } catch (err) {
        status.textContent = String(err).replace(/^Error:\s*/, "");
      }
      void opts.save();
    })),
    h("div", { class: "row" }, h("label", { text: "Endpoint delay" }), endpoint, endpointLabel),
    h("div", { class: "row" }, h("label", { text: "Auto-send" }), toggle(s().voiceAutoSubmit ?? true, (v) => {
      s().voiceAutoSubmit = v;
      void opts.save();
    })),
    h("div", { class: "row" }, h("label", { text: "Speech voice" }), voices, audition),
    h("div", { class: "row" }, h("label", { text: "Rate" }), rate),
    h("div", { class: "row" }, h("label", { text: "Volume" }), volume),
    h("div", { class: "row" }, h("label", { text: "Local memory" }), toggle(s().voiceMemoryEnabled, (v) => {
      s().voiceMemoryEnabled = v;
      Voice.state.memoryEnabled = v;
      void opts.save();
      void refreshMemories();
    })),
    h("div", { class: "row" }, memInput, memAdd),
    memList,
    h("div", { class: "row" }, forgetAll),
  );
  void refreshCapability();
  if (s().voiceMemoryEnabled) void refreshMemories();
  return section;
}

/** Explicit window attach: snapshots the external foreground window. The
 * island never activates, so the snapshot still sees the outside window. */
export async function snapshotWindowContext(): Promise<void> {
  try {
    const snap = await deps.voiceWindowSnapshot();
    if (!snap) {
      Voice.state.error = "No window to attach. Choom itself is never selected.";
      Voice.notify();
      return;
    }
    Voice.state.context = {
      kind: "window",
      label: `${snap.appName}: ${snap.title}`,
      appName: snap.appName,
      title: snap.title,
    };
    Voice.state.error = null;
    Voice.notify();
  } catch (err) {
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

/** Explicit file attach: native document picker, validated at the backend. */
export async function attachDocument(): Promise<void> {
  try {
    const picked = await deps.toolsPickDocument();
    if (!picked) return;
    const name = picked.split(/[\\/]/).pop() ?? "file";
    Voice.state.context = { kind: "file", label: name, name, path: picked };
    Voice.state.error = null;
    Voice.notify();
  } catch (err) {
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

export function isValidDeckPin(value: string): value is VoiceDeckMode {
  return validDeckMode(value);
}
