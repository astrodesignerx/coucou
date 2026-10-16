// Choom voice deck and settings. A is the ribbon default, C is the task
// instance for steps, choices, approvals and context, B is a manual
// conversation alternative. Mic and Input are the only primary card
// controls. Main mascot stays left with existing size and padding.
// No visible scrollbars, no duplicate headings, no cockpit decoration.
//
// Production calls use the live Bridge. The fixture injects VoiceDeps mocks
// for deterministic preview only; no simulated values reach production.

import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { Bridge, onEvent, type ChatContext, type DecisionEngine, type JevCandidate, type JevOutcome, type JevReceipt, type LayaOutcome, type LayaReceipt, type LayaStatus, type RoutineStep, type VoiceMemory, type VoiceToolOption, type VoiceToolRoute } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type Settings } from "../core/state";
import type { ViewHost } from "../views/views";
import { submitChatTurn, currentChatOwner, cancelChatTurn } from "../views/chat";
import { routineById, resolveRoutineSteps } from "./tools";
import {
  assistedNextStep,
  clampJevDeadlineMs,
  clampJevThreshold,
  formatJevReceipt,
  isJevEligible,
  normalizeJevMode,
  outcomeToReceipt,
  shouldAskJev,
} from "./jev";
import {
  LAYA_CLARIFY_PROMPT, LAYA_OFFLINE_LIMIT, canCheckLocalEngine, clampLayaThreshold,
  formatLayaReceipt, formatLayaStatus, isLocalEngine, layaNextStep, layaShowsClarification,
  layaShowsOptions, normalizeDecisionEngine, outcomeToLayaReceipt,
} from "./laya";
import {
  Voice, TRANSCRIPT_PAGE, WHISPER_FINISH_TIMEOUT_MS, clampEndpointMs, noteSubmittedSegments, speakPreview,
  validDeckMode, wasSubmitted, type VoiceDeckMode,
} from "./voice";
import { parseFlowCommand, type FlowShortcut } from "./flowGrammar";
import {
  planFromRequest, planSummary, formatPlanReceipt,
  type FlowPlan, type FlowPlanReceipt, type FlowStepReceipt,
} from "./flow";
import {
  resetSession, cancelFlow, runPlan, setVoiceGeneration, setStaleCheck,
  savedShortcuts, correctFlowTurn, rememberFlowRequest, flowRegistry,
  flowCapabilityView, runMediaFlow, runRoutineFlow, runLaunchFlow,
} from "./flowController";
import {
  FlowAdmission, FlowClauseTracker,
  type ClauseVerdict,
} from "./flowClauseTracker";

/** Everything the deck touches outside itself. Production default is live. */
export interface VoiceDeps {
  voiceCapability: () => Promise<{ supported: boolean; recognizers: string[]; voices: string[]; error: string | null } | null>;
  voiceWhisperStatus: () => Promise<{ binary: boolean; base: boolean; small: boolean; error: string | null } | null>;
  openSettings: () => Promise<void>;
  voiceListenStart: (muted: boolean) => Promise<number>;
  voiceListenStop: () => Promise<void>;
  voiceWhisperFinish: () => Promise<void>;
  voiceCancel: (preserveDraft?: boolean) => Promise<number>;
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
  jevDecide: (request: string, candidates: JevCandidate[], generation: number | null) => Promise<JevOutcome>;
  jevConfigured: () => Promise<boolean>;
  chatDeltas: (handler: (text: string) => void) => Promise<() => void>;
  /** One local decision. Rejects with a bounded reason on any failure. */
  layaDecide: (request: string, generation: number | null) => Promise<LayaOutcome>;
  /** Honest local readiness right now. Never optimistic. */
  layaStatus: () => Promise<LayaStatus | null>;
  /** Explicit readiness check: warms the local model with a neutral probe. */
  layaCheck: () => Promise<LayaStatus | null>;
  /** Retires the owned local worker and advances the shared generation. */
  layaCancel: () => Promise<number>;
  layaHistory: () => Promise<LayaReceipt[]>;
  layaClearHistory: () => Promise<void>;
  chatTurn: (
    query: string,
    context: ChatContext | null,
    onHeight: () => void,
    owner: number,
  ) => Promise<{ text: string } | { error: string }>;
}

const liveDeps: VoiceDeps = {
  voiceCapability: () => Bridge.voiceCapability(),
  voiceWhisperStatus: () => Bridge.voiceWhisperStatus(),
  openSettings: () => {
    // The island owns the inline route in Tauri and in the plain-browser
    // fixture alike: the CustomEvent alone opens the room. Calling the native
    // command on top would echo back through the tray handler and reset a
    // deep link to the hub home, so it stays out of this path.
    try {
      window.dispatchEvent(new CustomEvent("coucou:open-settings", { detail: { category: "voice" } }));
    } catch { /* event only */ }
    return Promise.resolve();
  },
  voiceListenStart: (muted) => Bridge.voiceListenStart(muted),
  voiceListenStop: () => Bridge.voiceListenStop().then(() => undefined),
  voiceWhisperFinish: () => Bridge.voiceWhisperFinish(),
  voiceCancel: (preserveDraft) => Bridge.voiceCancel(preserveDraft),
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
  jevDecide: (request, candidates, generation) => Bridge.jevDecide(request, candidates, generation),
  jevConfigured: async () => (await Bridge.jevStatus())?.configured ?? false,
  chatDeltas: (handler) => onEvent<string>("chat-delta", handler),
  layaDecide: (request, generation) => Bridge.layaDecide(request, generation),
  layaStatus: () => Bridge.layaStatus(),
  layaCheck: () => Bridge.layaCheck(),
  layaCancel: () => Bridge.layaCancel(),
  layaHistory: () => Bridge.layaHistory().then((list) => list ?? []),
  layaClearHistory: () => Bridge.layaClearHistory(),
  chatTurn: (query, context, onHeight, owner) => submitChatTurn(query, context, onHeight, owner),
};

let deps: VoiceDeps = liveDeps;

/** Fixture only: isolated mock adapters for deterministic preview. */
export function setVoiceDeps(next: VoiceDeps | null): void {
  deps = next ?? liveDeps;
}

let flowQueueOwned = false;

function prepareFlowGeneration(generation: number): void {
  if (!State.settings.flowEnabled) return;
  flowQueueOwned = true;
  setVoiceGeneration(generation);
}

function cancelFlowQueue(): void {
  if (!flowQueueOwned && !State.settings.flowEnabled) return;
  cancelFlow();
  flowQueueOwned = false;
}

let endpointTimer: number | null = null;
let followupTimer: number | null = null;
/** Generation armed for follow-up listening after its talkback ends. */
let followupArmed: number | null = null;
let agentSpeech: { generation: number; owner: number; working: boolean; playing: boolean; failed: boolean; spoken: string; dispatch: Promise<void>; ended: Promise<void>; finish: () => void } | null = null;
/** Manual editing inhibits auto dispatch until the user resumes explicitly. */
let editHold = false;
let openIsland: (() => void) | null = null;
let heightTick: (() => void) | null = null;
/**
 * Narrow shared entry to the demand editor, owned by the mounted voice card.
 * Landing Input navigates to the voice view then opens the editor through
 * this, so drafts, Escape, Enter and capture rules stay in one place.
 */
let voiceEditorOpener: (() => void) | null = null;

export function openVoiceEditor(): boolean {
  const open = voiceEditorOpener;
  if (!open) return false;
  open();
  return true;
}

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

function clearFollowup(discardAgent = true): void {
  if (followupTimer != null) {
    window.clearTimeout(followupTimer);
    followupTimer = null;
  }
  followupArmed = null;
  agentSpeech?.finish();
  if (discardAgent) agentSpeech = null;
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
  clearPendingFinish();
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
    if (State.mode !== "expanded") await rearmWake();
    return;
  }
  initializeListeningSession(generation);
  Voice.notify();
  heightTick?.();
}

function initializeListeningSession(generation: number): void {
  Voice.state.generation = generation;
  // A fresh listening session owns a fresh Flow session: nothing from a
  // previous session's turns may be reused or replayed.
  if (State.settings.flowEnabled) resetSession();
  prepareFlowGeneration(generation);
  if (State.settings.flowEnabled) setStaleCheck((gen) => !fenced(gen));
  // A continuous session gets a fresh tracker and a fresh admission queue:
  // nothing from a previous session's utterances may be reused or replayed.
  if (continuousFlowActive()) beginContinuousFlow(generation);
  else retireContinuousFlow();
  Voice.state.runtime = "listening";
  Voice.state.deviceError = false;
  Voice.state.error = null;
  captureSetup = captureSetupKey(State.settings);
}

export async function stopVoice(): Promise<void> {
  if (isWhisperFinishing()) return;
  // Manual mic stop on an active Whisper recording finishes the utterance:
  // the authoritative final, empty or error lands first, wake re-arms after.
  // Everything else discards, exactly like the Windows backend stop.
  if (isWhisperRecording()) {
    await stopVoiceFinish();
    return;
  }
  await discardVoiceCapture();
}

/** Pending finish-utterance wait. Set by manual mic stop on Whisper and
 * settled only by the authoritative terminal event for that generation.
 * Wake re-arms after the terminal, never at stop time. */
let pendingFinish: { generation: number; timer: number | null } | null = null;

function clearPendingFinish(): void {
  if (pendingFinish?.timer != null) window.clearTimeout(pendingFinish.timer);
  pendingFinish = null;
}

function isWhisperBackend(): boolean {
  return State.settings.voiceBackend === "whisper";
}

// ── Continuous Flow capture ─────────────────────────────────────────────────
// With Flow on and Whisper selected, one microphone session stays open while
// bounded snapshots are decoded. Capture ownership is deliberately separate
// from the action display state: a plan running, a receipt showing or the
// agent working never stops the microphone, and speech is never discarded just
// because something else is busy. Everything below only decides what the
// existing FlowSession queue runs; it never runs a capability itself.

/** Continuous capture is derived from settings exactly as the native side
 * derives it, so the frontend and the helper never disagree about it. */
function continuousFlowActive(): boolean {
  return !!State.settings.flowEnabled && isWhisperBackend();
}

const clauseTracker = new FlowClauseTracker();
const flowAdmission = new FlowAdmission();

/**
 * Actual capture ownership, tracked independently of what the card is
 * displaying and of any settings flag. The runtime goes to `working` while a
 * plan runs even though the microphone is still open, and Flow or the backend
 * can be switched off while a capture is live, so neither can be used to
 * decide whether capture exists. This is the one answer to that question.
 */
let captureOwner: { generation: number; epoch: number } | null = null;
let captureEpoch = 0;

/** The live capture session, or null when nothing is being captured. */
function activeCapture(): { generation: number; epoch: number } | null {
  return captureOwner;
}

/** True when a continuous Flow capture is genuinely live right now. */
function continuousCaptureLive(): boolean {
  return captureOwner != null && continuousFlowActive();
}

/**
 * Retires capture bookkeeping and everything waiting to run. Called by every
 * path that ends a continuous session: Stop, close, mute, pause, lock, engine
 * or setup change, and a fresh listen. Text on the card is never touched.
 *
 * The pump guard is deliberately NOT cleared here. Retirement advances the
 * epoch instead, so a pump that is already awaiting work can only retire its
 * own state, and can never clear the guard that a newer pump now owns.
 */
function retireContinuousFlow(): void {
  if (captureOwner == null && !pumpActive && !flowAdmission.depth) return;
  captureEpoch += 1;
  captureOwner = null;
  Voice.state.flowCurrentAction = null;
  clauseTracker.reset();
  flowAdmission.clear();
}

/** Saved shortcuts, the notes folder and the registry the grammar needs,
 * read once per turn exactly as the one-shot path does. */
function flowGrammarContext() {
  return {
    shortcuts: savedShortcuts().map((s) => ({ id: s.id, name: s.name, kind: s.kind, target: s.target })),
    notesConfigured: !!State.settings.flowNotesFolder,
    registry: flowRegistry(),
  } as const;
}

/** Starts the tracker for a new continuous listening session. */
function beginContinuousFlow(generation: number): void {
  captureEpoch += 1;
  captureOwner = { generation, epoch: captureEpoch };
  clauseTracker.begin(generation, flowGrammarContext());
  flowAdmission.setGeneration(generation);
}

/** Routes one helper observation through the tracker and admits whatever it
 * decided. Only complete, stable clauses ever reach the queue. */
function feedContinuousFlow(
  verdict: ClauseVerdict,
  generation: number,
): void {
  if (verdict.kind === "hold" || verdict.kind === "not-flow") return;
  if (verdict.kind === "refuse") {
    // The grammar's own wording, shown as it stands. Nothing was invented
    // here and nothing was run.
    if (!fenced(generation)) return;
    Voice.state.error = verdict.message;
    Voice.notify();
    heightTick?.();
    return;
  }
  const batch = { generation, steps: verdict.steps, text: verdict.text };
  if (!flowAdmission.admit(batch)) {
    // The bound is honest work, not a silent drop: the queue is saturated, so
    // the user is told instead of a command vanishing.
    if (!fenced(generation)) return;
    Voice.state.error = `Too many commands waiting. Stop and try again.`;
    Voice.notify();
    heightTick?.();
    return;
  }
  void pumpFlowAdmission();
}

/**
 * The single drain loop for continuous dispatch. One batch runs at a time, in
 * spoken order, through the existing FlowSession. Capture and decoding keep
 * running while it works, and every awaited step rechecks the turn fence, so a
 * Stop or a routing change stops the queue without touching the microphone's
 * ownership rules.
 *
 * The loop owns an epoch. Retirement advances the epoch rather than clearing
 * a flag, so a pump that is still awaiting `runPlan` can only retire its own
 * state, can never consume a newer session's batches, and can never clear a
 * guard that a newer pump now owns.
 */
async function pumpFlowAdmission(): Promise<void> {
  const epoch = captureEpoch;
  if (pumpEpoch === epoch && pumpActive) return;
  pumpEpoch = epoch;
  pumpActive = true;
  try {
    for (let guard = 0; guard < 64; guard++) {
      // Once retired this pump owns nothing: it stops taking work immediately
      // and leaves the display to whoever owns the live session.
      if (epoch !== captureEpoch || !State.settings.flowEnabled) return;
      const batch = flowAdmission.take();
      if (!batch) return;
      if (!fenced(batch.generation)) continue;
      // Capture ownership is not action state: the deck keeps showing that it
      // is listening while a plan runs.
      const wasListening = Voice.state.runtime === "listening";
      if (wasListening) Voice.state.runtime = "working";
      let receipt: FlowPlanReceipt;
      try {
        const planned = planFromRequest({ generation: batch.generation, steps: batch.steps }, Date.now(), flowRegistry());
        if (!planned.plan) {
          if (epoch !== captureEpoch || !fenced(batch.generation)) return;
          Voice.state.error = planned.error ?? "That request cannot run.";
          Voice.state.runtime = wasListening && activeCapture() != null ? "listening" : "standby";
          Voice.notify();
          continue;
        }
        rememberFlowRequest({ generation: batch.generation, steps: batch.steps });
        receipt = await runPlan(planned.plan, {
          onStep: (step, settled) => {
            if (epoch !== captureEpoch || !fenced(batch.generation)) return;
            Voice.state.flowCurrentAction = settled ? null : `${step.kind.replace(".", " ")}: ${step.target}`;
            if (settled) rememberStepReceipt(settled);
            Voice.notify();
            heightTick?.();
          },
        });
      } catch (err) {
        if (epoch !== captureEpoch || !fenced(batch.generation)) return;
        Voice.state.error = String(err).replace(/^Error:\s*/, "");
        Voice.state.runtime = wasListening && activeCapture() != null ? "listening" : "standby";
        Voice.notify();
        continue;
      }
      if (epoch !== captureEpoch || !fenced(batch.generation)) return;
      Voice.state.flowCurrentAction = null;
      for (const step of receipt.steps) rememberStepReceipt(step);
      // Only the newest receipt is shown; the queue keeps running.
      Voice.state.flowReceipt = receipt;
      Voice.state.receipt = {
        target: "Flow",
        status: planSummary(receipt).failed > 0 ? "failed" : "ok",
        message: formatPlanReceipt(receipt),
      };
      Voice.state.runtime = wasListening && activeCapture() != null ? "listening" : "standby";
      Voice.notify();
      heightTick?.();
    }
  } finally {
    // Only the pump that owns this epoch may clear the guard. A newer pump
    // that already took over keeps it.
    if (pumpEpoch === epoch) pumpActive = false;
  }
}

let pumpEpoch = -1;
let pumpActive = false;

function rememberStepReceipt(step: FlowStepReceipt): void {
  const recent = Voice.state.flowRecentReceipts.filter((item) => item.id !== step.id);
  Voice.state.flowRecentReceipts = [...recent, step].slice(-4);
}

function isWhisperFinishing(): boolean {
  return pendingFinish != null;
}

function isWhisperRecording(): boolean {
  return isWhisperBackend()
    && Voice.state.generation > 0
    && (activeCapture() != null || Voice.state.runtime === "listening");
}

/** Manual mic stop on Whisper: finish and wait for the terminal event. */
async function stopVoiceFinish(): Promise<void> {
  const generation = currentGeneration();
  clearEndpoint();
  Voice.state.runtime = "processing";
  Voice.state.partial = "";
  Voice.notify();
  heightTick?.();
  try {
    pendingFinish = { generation, timer: null };
    await deps.voiceWhisperFinish();
  } catch (err) {
    clearPendingFinish();
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  // Superseded while sending: the newer turn owns the helper now.
  if (!fenced(generation)) return;
  if (pendingFinish?.generation !== generation) return;
  pendingFinish.timer = window.setTimeout(() => {
    if (pendingFinish?.generation !== generation) return;
    pendingFinish = null;
    if (!fenced(generation)) return;
    Voice.state.runtime = "error";
    Voice.state.error = "Transcription timed out. Try again.";
    Voice.notify();
    heightTick?.();
  }, WHISPER_FINISH_TIMEOUT_MS);
}

/** Discard path: stops capture and drops audio, then returns to keyword
 * standby. Identical for both backends; the Windows stop is unchanged. */
async function discardVoiceCapture(): Promise<void> {
  ++listenOperation;
  clearEndpoint();
  clearPendingFinish();
  Voice.state.runtime = "standby";
  await deps.voiceListenStop();

  Voice.state.partial = "";
  Voice.state.pendingSegments = [];
  Voice.notify();
  if (State.settings.voiceWakeEnabled && !Voice.state.muted) await rearmWake();
}

/** Closing a voice panel discards capture audio and returns to keyword
 * standby at once. Only manual mic stop finishes on Whisper. */
export async function closeVoicePanel(): Promise<void> {
  // Continuous capture keeps the microphone open, so a close retires capture,
  // the decoder and every queued or already admitted native action even while
  // a plan runs or the agent is speaking. Outside Flow the existing policy is
  // untouched.
  if (!continuousFlowActive()
    && (Voice.state.runtime === "working" || Voice.state.runtime === "speaking")) return;
  clearFollowup();
  if (continuousCaptureLive()) {
    // Text on the card survives a close; the capture, the queue and the native
    // generation do not.
    const draft = Voice.state.partial;
    const pending = Voice.state.pendingSegments;
    const stable = Voice.state.stable;
    const context = Voice.state.context;
    await retireContinuousCapture(true);
    Voice.state.partial = draft;
    Voice.state.pendingSegments = pending;
    Voice.state.stable = stable;
    Voice.state.context = context;
    if (State.settings.voiceWakeEnabled && !Voice.state.muted) await rearmWake();
    Voice.notify();
    heightTick?.();
    return;
  }
  retireContinuousFlow();
  if (isWhisperBackend()) {
    try {
      await discardVoiceCapture();
    } catch (err) {
      Voice.state.runtime = "error";
      Voice.state.error = String(err).replace(/^Error:\s*/, "");
      Voice.notify();
    }
    return;
  }
  try {
    await stopVoice();
  } catch (err) {
    clearPendingFinish();
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

export async function cancelVoice(): Promise<void> {
  ++listenOperation;
  clearEndpoint();
  clearFollowup();
  clearPendingFinish();
  // Stop retires capture, the pending decoder work and everything queued to
  // run. Native dispatch and any late outcome stay generation fenced below.
  retireContinuousFlow();
  // Aborts the owned agent request too; unrelated sessions are untouched.
  cancelChatTurn();
  // Stop also invalidates any queued or late Flow step for this turn.
  cancelFlowQueue();
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
  if (State.settings.voiceWakeEnabled && !Voice.state.muted) await rearmWake();
}

/** Re-arms opted-in keyword wake after unlock or follow-up. Errors stay visible. */
export async function rearmWake(): Promise<void> {
  if (!State.settings.voiceEnabled || !State.settings.voiceWakeEnabled
    || Voice.state.muted || State.paused) return;
  try {
    await deps.voiceWakeSet(true);
    Voice.state.wakeOn = true;
    Voice.notify();
  } catch (err) {
    clearPendingFinish();
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

/** Local session close: native already stopped capture, so only clear UI. */
export function localVoiceStandby(): void {
  clearEndpoint();
  clearFollowup();
  clearPendingFinish();
  // A lock or a suspend ends a continuous session even while the deck is
  // showing work: the capture owner, not the displayed runtime, decides.
  retireContinuousFlow();
  cancelFlowQueue();
  Voice.state.partial = "";
  Voice.state.pendingSegments = [];
  Voice.state.runtime = "standby";
  Voice.clearTurnUI();
  Voice.notify();
  heightTick?.();
}

/**
 * Retires a continuous capture for real: the tracker, the queue and the Flow
 * fence here, and the native generation, decoder and any blocking native
 * action on the other side.
 *
 * Clearing JavaScript state alone cannot fence a native action that was
 * already admitted, so every control path that ends a continuous session goes
 * through here rather than only through `discardVoiceCapture`. Effects that
 * already ran keep their honest receipts; nothing new is admitted.
 */
async function retireContinuousCapture(preserveDraft: boolean): Promise<void> {
  ++listenOperation;
  clearEndpoint();
  clearPendingFinish();
  retireContinuousFlow();
  cancelFlowQueue();
  try {
    const generation = await deps.voiceCancel(preserveDraft);
    if (preserveDraft) {
      adoptCancellationGeneration(routingEpoch, generation);
    } else if (Number.isFinite(generation)) {
      Voice.cancelTurn(generation);
    }
  } catch {
    // Outside Choom there is no capture to stop; the local fence above still
    // retires everything this side owns.
  }
}

let listenOperation = 0;

function currentGeneration(): number {
  return Voice.state.generation;
}

function fenced(generation: number): boolean {
  return Voice.state.generation === generation;
}

/**
 * Monotonic routing epoch. It moves on whenever the engine changes or the
 * local setup is edited, so a callback that started under the previous
 * routing can never be reused, not even after a round trip back to the same
 * engine.
 */
let routingEpoch = 0;

/** What a running local worker is actually bound to. Editing any of these
 *  under a fixed engine is a routing change like any other: the old worker
 *  can no longer answer for the new setup. */
function localSetupKey(settings: Settings): string {
  return [
    normalizeDecisionEngine(settings.decisionEngine),
    settings.layaRuntimePath ?? "",
    settings.layaModelPath ?? "",
    settings.layaManifestPath ?? "",
    String(clampLayaThreshold(settings.layaThreshold ?? 0.85)),
  ].join("|");
}

let routingSetup = localSetupKey(State.settings);

function captureSetupKey(settings: Settings): string {
  return `${!!settings.flowEnabled}|${settings.voiceBackend}`;
}

let captureSetup = captureSetupKey(State.settings);

/** The engine that owns a decision, captured before the call and rechecked
 *  after it: a switch between the two means the answer belongs to an engine
 *  the user has already replaced. */
function decisionOwned(epoch: number, engine: DecisionEngine): boolean {
  return epoch === routingEpoch && normalizeDecisionEngine(State.settings.decisionEngine) === engine;
}

/**
 * A unique id per submitted Voice request. The routing epoch and the
 * generation decide whether a request is still valid at all; this id decides
 * whether it still owns the deck. Two requests can share a generation and an
 * epoch, and only the newest of them may change the runtime, the choice list,
 * the thinking state or cancel its own queue.
 */
let nextRequestOwner = 0;
let activeRequestOwner = 0;
let voiceThinkingOwner = 0;
let voiceThinkingChatOwner = 0;

/** One complete Voice request, fenced as a unit. The epoch is captured at
 *  entry and rechecked after every awaited step, so a routing change made
 *  while a classifier or the provider gate was still pending retires the
 *  whole request instead of letting it fall through to a remote call. */
interface VoiceTurn {
  readonly owner: number;
  readonly generation: number;
  readonly epoch: number;
  readonly engine: DecisionEngine;
  owns(): boolean;
}

function beginTurn(generation: number): VoiceTurn {
  const epoch = routingEpoch;
  const engine = normalizeDecisionEngine(State.settings.decisionEngine);
  const owner = ++nextRequestOwner;
  activeRequestOwner = owner;
  return {
    owner,
    generation,
    epoch,
    engine,
    owns: () => activeRequestOwner === owner
      && fenced(generation)
      && decisionOwned(epoch, engine),
  };
}

/**
 * Retires one request, and only when it still owns the deck. A callback that
 * settles after a newer request has started returns here and touches nothing:
 * not the runtime, not the choice list, not the thinking indicator, and not
 * the queue the newer request is using. The thinking state is released only by
 * the request that set it, so an unrelated typed chat turn is never affected.
 */
function retireRequest(owner: number): void {
  if (owner === 0 || activeRequestOwner !== owner) return;
  activeRequestOwner = 0;
  if (voiceThinkingOwner === owner) {
    if (currentChatOwner() === voiceThinkingChatOwner) {
      cancelChatTurn();
      if (State.stateOverride === "thinking") State.stateOverride = null;
    }
    voiceThinkingOwner = 0;
  }
  Voice.state.ambiguity = [];
  if (Voice.state.runtime === "working") cancelFlowQueue();
  if (Voice.state.runtime === "working") Voice.state.runtime = "standby";
  Voice.notify();
  heightTick?.();
}

/** True while the whole Voice request may keep going. A retired request is
 *  put back on the deck first, so the user is never left on "working". */
function stillOwned(turn: VoiceTurn): boolean {
  if (turn.owns()) return true;
  retireRequest(turn.owner);
  return false;
}

/**
 * The routing change stops the capture it invalidated, on purpose. The native
 * side has already moved its own generation on by then, so a capture left
 * running would keep sending a generation the helper discards, and the deck
 * would look like it was listening while every word was dropped. Stopping it
 * is the honest outcome: the deck returns to standby with the partial, the
 * pending segments, the transcript and the attached context all still there,
 * and the user starts listening again on the new engine. An explicit Stop is
 * untouched and still clears the turn as before.
 */
async function retireCaptureForRouting(epoch: number): Promise<void> {
  // Capture ownership, not the displayed runtime: the speech pump shows
  // `working` while the microphone is still open, and a routing change made
  // in that state has to stop the real capture, not just the worker.
  const capture = activeCapture();
  const live = capture != null
    || Voice.state.runtime === "listening"
    || Voice.state.runtime === "processing";
  if (!live) {
    retireContinuousFlow();
    cancelFlowQueue();
    try {
      const returned = await deps.layaCancel();
      adoptCancellationGeneration(epoch, returned);
    } catch {
      // Outside Choom there is no worker to retire; the epoch already fences it.
    }
    return;
  }
  // Everything the user said is held aside across the retirement, so no event
  // that lands during it can take the text away. The tracker and the queue go
  // with the capture: nothing from the retired session may run.
  const draft = Voice.state.partial;
  const pending = Voice.state.pendingSegments;
  const stable = Voice.state.stable;
  const context = Voice.state.context;
  const startedAt = Voice.state.generation;
  retireContinuousFlow();
  // A routing change fences Flow too: nothing from the retired capture may
  // still be admitted when the engine has moved on.
  cancelFlowQueue();
  let returned = Number.NaN;
  try {
    returned = await deps.voiceCancel(true);
  } catch {
    // Outside Choom there is no capture to stop.
  }
  // The deck belongs to the user again the moment it moves on. A listen that
  // started, or a Stop that landed, while this command was in flight keeps its
  // own text and its own runtime; the restore is then simply not applied.
  if (Voice.state.generation === startedAt) {
    Voice.state.partial = draft;
    Voice.state.pendingSegments = pending;
    Voice.state.stable = stable;
    Voice.state.context = context;
    Voice.state.runtime = "standby";
  }
  adoptCancellationGeneration(epoch, returned);
  Voice.notify();
  heightTick?.();
}

/**
 * Applies the generation a native retirement returned, and only ever forwards.
 * A reply from a routing change that has already been superseded is dropped,
 * and one older than the generation the deck already holds is dropped too, so
 * a delayed reply can never cancel a newer listen.
 */
function adoptCancellationGeneration(epoch: number, next: number): void {
  if (epoch !== routingEpoch) return;
  if (!Number.isFinite(next) || next <= Voice.state.generation) return;
  Voice.state.generation = next;
}

/** Last sanitized Jev receipt for settings. No raw content. */
let lastJevReceipt: JevReceipt | null = null;

export function getLastJevReceipt(): JevReceipt | null {
  return lastJevReceipt;
}

/** Fixture only: seeds the diagnostic receipt without network. */
export function setLastJevReceipt(receipt: JevReceipt | null): void {
  lastJevReceipt = receipt;
}

/** Fills the deck edit field. Registered by the deck view; Jev clarify
 * uses it so the submitted request stays editable instead of lost. */
let jevEditFiller: ((text: string) => void) | null = null;
/** Which mounted deck owns the filler, so disposal clears only its own. */
let activeJevFiller: ((text: string) => void) | null = null;

export function setJevEditFiller(fn: ((text: string) => void) | null): void {
  jevEditFiller = fn;
}

/** Compact eligible capabilities: saved shortcuts, routines and media. */
export function buildJevCandidates(): JevCandidate[] {
  const out: JevCandidate[] = [];
  const tools = State.settings.tools;
  for (const s of tools?.shortcuts ?? []) {
    if (out.length >= 12) break;
    if (s.id && s.name) out.push({ id: s.id, label: String(s.name).slice(0, 60) });
  }
  for (const r of tools?.routines ?? []) {
    if (out.length >= 12) break;
    if (r.id && r.name) out.push({ id: `routine:${r.id}`, label: String(r.name).slice(0, 60) });
  }
  for (const [id, label] of [
    ["media:play", "Play music"],
    ["media:pause", "Pause music"],
  ] as [string, string][]) {
    if (out.length >= 12) break;
    if (!out.some((c) => c.id === id)) out.push({ id, label });
  }
  return out;
}

export const JEV_ASSISTED_GRACE_MS = 600;

/**
 * Bounded Jev decision after local routes, before the agent fallback.
 * Returns true when the turn is complete or retired (Assisted showed options
 * or clarification, or a Stop or an engine change superseded it). Shadow
 * never completes here: it records and falls through.
 * Local media, saved launches, routines, wake and cancellation never reach it.
 */
export async function decideWithJev(clean: string, generation: number): Promise<boolean> {
  // The online engine only ever owns a turn while it is the selected one.
  if (isLocalEngine(State.settings)) return false;
  const epoch = routingEpoch;
  let configured = false;
  try {
    configured = await deps.jevConfigured();
  } catch {
    configured = false;
  }
  if (!isJevEligible(State.settings, configured)) return false;
  // A routing change while eligibility was being read retires the whole
  // request: falling through would hand a retired turn to the agent path.
  if (!decisionOwned(epoch, "jev")) return true;
  const mode = normalizeJevMode(State.settings.jevMode);
  const candidates = buildJevCandidates();
  if (mode === "shadow") {
    // Recording must not delay the user's agent response.
    void deps.jevDecide(clean.slice(0, 500), candidates, generation).then((outcome) => {
      if (!fenced(generation) || !decisionOwned(epoch, "jev")) return;
      lastJevReceipt = outcomeToReceipt(outcome, Date.now());
      Voice.notify();
      heightTick?.();
    }).catch(() => undefined);
    return false;
  }
  let outcome: JevOutcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  try {
    const decision = deps.jevDecide(clean.slice(0, 500), candidates, generation);
    void decision.then((receipt) => {
      if (!late || !fenced(generation)) return;
      lastJevReceipt = outcomeToReceipt(receipt, Date.now());
      Voice.notify();
      heightTick?.();
    }).catch(() => undefined);
    const timely = await Promise.race([
      decision,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { late = true; resolve(null); }, JEV_ASSISTED_GRACE_MS);
      }),
    ]);
    if (timely === null) return false;
    outcome = timely;
  } catch (err) {
    // Stale or cancelled turns drop silently; anything else falls through.
    if (String(err).includes("cancelled")) return true;
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!fenced(generation)) return true;
  // A routing change between dispatch and answer retires this result: it
  // belongs to an engine the user has already replaced.
  if (!decisionOwned(epoch, "jev")) return true;
  if (!isJevEligible(State.settings, configured)
    || normalizeJevMode(State.settings.jevMode) !== mode) return false;
  lastJevReceipt = outcomeToReceipt(outcome, Date.now());
  Voice.notify();
  heightTick?.();
  // Assisted chooses answer versus options or clarification only. It never
  // invents or executes a target, shell command, approval or provider switch.
  if (outcome.fallbackReason) return false;
  const threshold = clampJevThreshold(State.settings.jevThreshold);
  if (!Number.isFinite(outcome.confidence) || outcome.confidence < threshold) return false;
  const eligibleIds = candidates.map((c) => c.id);
  const step = assistedNextStep(outcome, eligibleIds);
  if (step.action === "answer" || step.action === "fallback") return false;
  if (step.action === "show_clarify") {
    // Genuine editable clarification: the submitted request moves into the
    // edit field, so nothing is lost and the user reshapes and resends it.
    jevEditFiller?.(clean);
    Voice.state.error = "What result would you like? Add that detail to your request, or keep talking.";
    Voice.state.runtime = "standby";
    Voice.notify();
    heightTick?.();
    return true;
  }
  // This classifier never returns a candidate selection. Local targets
  // continue through the deterministic resolver and existing approvals.
  if (outcome.route === "supported_local") return false;
  // Options shows only real saved app/folder targets through the existing
  // ambiguity controls. With none saved, fall through to the agent answer.
  const grounded: VoiceToolOption[] = (State.settings.tools?.shortcuts ?? [])
    .filter((s) => (s.kind === "app" || s.kind === "folder") && !!s.id && !!s.target
      && eligibleIds.includes(s.id) && s.name.trim().length > 1
      && clean.toLocaleLowerCase().includes(s.name.trim().toLocaleLowerCase()))
    .slice(0, 12)
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind, target: s.target }));
  if (grounded.length === 0) return false;
  Voice.state.ambiguity = grounded;
  Voice.state.error = "Choose a saved target from your request, or keep talking.";
  Voice.state.runtime = "standby";
  Voice.notify();
  heightTick?.();
  return true;
}

/** Last sanitized local receipt for Settings. No raw content, ever. */
let lastLayaReceipt: LayaReceipt | null = null;

export function getLastLayaReceipt(): LayaReceipt | null {
  return lastLayaReceipt;
}

/** Fixture only: seeds the diagnostic receipt without a local worker. */
export function setLastLayaReceipt(receipt: LayaReceipt | null): void {
  lastLayaReceipt = receipt;
}

/** Ends the turn locally with one visible, honest line. Nothing is called. */
function endLocalTurn(message: string): boolean {
  Voice.state.error = message;
  Voice.state.runtime = "standby";
  Voice.notify();
  heightTick?.();
  return true;
}

/**
 * The offline decision step. It runs where the Jev step runs, and it is
 * deliberately the opposite in every direction: there is no fallback, no
 * agent call and no provider check, on any outcome or on any failure. Every
 * exit below returns true, so the caller can never fall through to the cloud
 * path while Local Laya is selected.
 */
export async function decideWithLaya(clean: string, generation: number): Promise<boolean> {
  if (!isLocalEngine(State.settings)) return false;
  const epoch = routingEpoch;
  let outcome: LayaOutcome;
  try {
    outcome = await deps.layaDecide(clean.slice(0, 500), generation);
  } catch (err) {
    // A cancelled or superseded turn is already fenced: drop it silently
    // rather than showing a limitation for a turn the user replaced.
    if (String(err).includes("cancelled")) return true;
    if (!fenced(generation) || !decisionOwned(epoch, "laya")) return true;
    // Missing runtime, a manifest that does not verify, a timeout: the honest
    // result is the fixed explanation the native side returned.
    return endLocalTurn(String(err).replace(/^Error:\s*/, ""));
  }
  if (!fenced(generation)) return true;
  if (!decisionOwned(epoch, "laya")) return true;
  lastLayaReceipt = outcomeToLayaReceipt(outcome, Date.now());
  Voice.notify();
  heightTick?.();

  // Only real saved app or folder targets the user actually named are offered,
  // and only through the existing ambiguity controls. Nothing is invented and
  // nothing is executed without a click.
  const named = clean.toLocaleLowerCase();
  const grounded: VoiceToolOption[] = (State.settings.tools?.shortcuts ?? [])
    .filter((s) => (s.kind === "app" || s.kind === "folder") && !!s.id && !!s.target
      && s.name.trim().length > 1
      && named.includes(s.name.trim().toLocaleLowerCase()))
    .slice(0, 12)
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind, target: s.target }));
  const action = layaNextStep(outcome, clampLayaThreshold(State.settings.layaThreshold ?? 0.85),
    grounded.length > 0);
  if (layaShowsOptions(action)) {
    Voice.state.ambiguity = grounded;
    return endLocalTurn("Choose a saved target from your request, or keep talking.");
  }
  if (layaShowsClarification(action)) {
    // Genuine editable clarification: the request moves into the edit field
    // untouched, so nothing the user said is lost.
    jevEditFiller?.(clean);
    return endLocalTurn(LAYA_CLARIFY_PROMPT);
  }
  return endLocalTurn(LAYA_OFFLINE_LIMIT);
}

/**
 * Moves the decision ownership when the user picks the other engine. The
 * previous engine is retired natively and the shared generation advances, so a
 * pending startup or inference can never answer for the new one. A capture that
 * was listening is stopped on purpose, because the native generation has
 * already moved on and a capture left running would be deaf. The request
 * draft, the transcript, the attached context and the pending captured text
 * are deliberately left alone.
 */
export async function switchDecisionEngine(next: DecisionEngine): Promise<void> {
  const wanted = normalizeDecisionEngine(next);
  if (normalizeDecisionEngine(State.settings.decisionEngine) === wanted) return;
  State.settings.decisionEngine = wanted;
  routingSetup = localSetupKey(State.settings);
  const epoch = retireRouting();
  await retireCaptureForRouting(epoch);
}

/**
 * Applies a routing change that arrived from elsewhere, for example the
 * settings-changed event of another window. An engine change and a local setup
 * edit are handled by the same rule, because a worker bound to an interpreter,
 * model or manifest the user just replaced may no longer answer.
 */
export async function applyRoutingSettings(patch: Partial<Settings>): Promise<void> {
  const previousEngine = normalizeDecisionEngine(State.settings.decisionEngine);
  const previousSetup = routingSetup;
  if (typeof patch.flowEnabled === "boolean") State.settings.flowEnabled = patch.flowEnabled;
  if (typeof patch.voiceBackend === "string") State.settings.voiceBackend = patch.voiceBackend;
  const nextCapture = captureSetupKey(State.settings);
  const captureMoved = nextCapture !== captureSetup;
  captureSetup = nextCapture;
  if (typeof patch.decisionEngine === "string") {
    State.settings.decisionEngine = normalizeDecisionEngine(patch.decisionEngine);
  }
  if (typeof patch.layaRuntimePath === "string") State.settings.layaRuntimePath = patch.layaRuntimePath;
  if (typeof patch.layaModelPath === "string") State.settings.layaModelPath = patch.layaModelPath;
  if (typeof patch.layaManifestPath === "string") {
    State.settings.layaManifestPath = patch.layaManifestPath;
  }
  if (typeof patch.layaThreshold === "number") State.settings.layaThreshold = patch.layaThreshold;
  const nextSetup = localSetupKey(State.settings);
  const engineMoved = normalizeDecisionEngine(State.settings.decisionEngine) !== previousEngine;
  const setupMoved = nextSetup !== previousSetup;
  if (!engineMoved && !setupMoved && !captureMoved) return;
  routingSetup = nextSetup;
  const epoch = retireRouting();
  await retireCaptureForRouting(epoch);
}

/** Moves the routing epoch on and returns it, so a retirement started now can
 *  be recognized as current, or superseded, when its reply lands. The request
 *  the deck is running is retired immediately; the thinking indicator is
 *  released only by the request that set it. */
function retireRouting(): number {
  ++listenOperation;
  clearPendingFinish();
  routingEpoch += 1;
  Voice.state.ambiguity = [];
  if (activeRequestOwner !== 0) retireRequest(activeRequestOwner);
  else if (Voice.state.runtime === "working") Voice.state.runtime = "standby";
  Voice.notify();
  heightTick?.();
  return routingEpoch;
}

/** Fixture and Settings only: an edit to the local setup under a fixed engine
 *  is a routing change, because the running worker belongs to the old one. It
 *  takes the same capture retirement as an engine change. The settings input
 *  handlers are synchronous, so the retirement is started here and finishes
 *  on its own. */
export function noteLocalSetupChange(): void {
  routingSetup = localSetupKey(State.settings);
  const epoch = retireRouting();
  void retireCaptureForRouting(epoch);
}

/**
 * The explicit readiness check. It warms the local model with a neutral
 * bounded probe: no action, no download, no cloud and no change to any answer.
 * A setup or engine change while the model was warming makes the reply about a
 * setup the user has already replaced, so the current truth is read instead.
 */
export async function checkLocalEngine(): Promise<LayaStatus | null> {
  if (!canCheckLocalEngine(State.settings)) return null;
  const epoch = routingEpoch;
  const status = await deps.layaCheck().catch(() => null);
  if (routingEpoch !== epoch) return deps.layaStatus().catch(() => null);
  return status;
}

/** Submits the aggregated utterance exactly once with its generation id. */
/** Runs one planned Flow plan on the persistent session and shows the
 *  receipt on the card. The queue owns ordering, cancellation and receipts;
 *  this only reports them honestly, including steps that sent without proof
 *  or wait for a click. */
async function runFlowPlanToCard(
  plan: FlowPlan,
  prefix: string | null,
  generation: number,
): Promise<true> {
  let receipt: FlowPlanReceipt;
  try {
    receipt = await runPlan(plan);
  } catch (err) {
    if (!fenced(generation)) return true;
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.state.runtime = "standby";
    Voice.notify();
    return true;
  }
  if (!fenced(generation)) return true;
  const summary = planSummary(receipt);
  const body = formatPlanReceipt(receipt);
  const message = prefix ? `${prefix} ${body}` : body;
  Voice.state.receipt = {
    target: "Flow",
    status: summary.failed > 0 ? "failed" : "ok",
    message,
  };
  // The ordered per-step receipts expand on the C deck, so the user sees
  // verified, sent-without-proof, waiting, failed and stopped steps alike.
  Voice.state.flowReceipt = receipt;
  Voice.notify();
  await speakResult(message, generation);
  return true;
}

/** Parses one utterance into a Flow plan and runs it on the persistent
 *  session. Returns true when the turn was a Flow command and was handled
 *  (planned, corrected, ambiguous or unclear), so the caller must not fall
 *  through to the agent. Returns false when the utterance is not a Flow
 *  command at all, which keeps dictation and the agent path untouched. Only
 *  runs when Flow is on. */
async function tryFlowTurn(clean: string, generation: number): Promise<boolean> {
  // The Flow controller shares the voice turn's generation fence, so a stopped
  // or superseded turn never dispatches a queued step.
  prepareFlowGeneration(generation);
  setStaleCheck((gen) => !fenced(gen));
  const shortcuts: FlowShortcut[] = savedShortcuts().map((s) => ({
    id: s.id, name: s.name, kind: s.kind, target: s.target,
  }));
  const registry = flowRegistry();
  const ctx = {
    shortcuts,
    notesConfigured: !!State.settings.flowNotesFolder,
    registry,
  };

  // A spoken correction retargets this session's pending note step, or adds a
  // distinct verified rename for a note that already ran. Nothing in flight
  // is ever rewritten under its dispatch.
  const corrected = correctFlowTurn(clean);
  if (corrected) {
    const planned = planFromRequest(corrected.request, Date.now(), registry);
    if (!planned.plan) {
      Voice.state.error = planned.error ?? "That correction cannot run.";
      Voice.state.runtime = "standby";
      Voice.notify();
      return true;
    }
    rememberFlowRequest(corrected.request);
    return runFlowPlanToCard(planned.plan, corrected.note, generation);
  }

  const parsed = parseFlowCommand(clean, generation, ctx);
  if (!parsed) return false;
  if (parsed.kind === "ambiguous") {
    Voice.state.ambiguity = parsed.options.map((o) => ({ id: o.id, name: o.name, kind: o.kind, target: o.target }));
    Voice.state.error = parsed.message;
    Voice.state.runtime = "standby";
    Voice.notify();
    heightTick?.();
    return true;
  }
  if (parsed.kind === "unclear") {
    Voice.state.error = parsed.message;
    Voice.state.runtime = "standby";
    Voice.notify();
    heightTick?.();
    return true;
  }
  // A new listening session starts clean; the same session is reused for
  // cumulative turns, so a re-sent or extended plan never double-dispatches.
  // Note ownership is session context: it is never cleared before a run.
  const ordered = planFromRequest(parsed.request, Date.now(), registry);
  if (!ordered.plan) {
    Voice.state.error = ordered.error ?? "That request cannot run.";
    Voice.state.runtime = "standby";
    Voice.notify();
    return true;
  }
  rememberFlowRequest(parsed.request);
  return runFlowPlanToCard(ordered.plan, null, generation);
}

export async function submitVoiceFinal(
  text: string,
  generation: number,
  opts: { manual?: boolean; segments?: string[] } = {},
): Promise<void> {
  const clean = text.trim();
  if (!clean || wasSubmitted(generation, clean)) return;
  if (!fenced(generation)) return;
  // No second request while one is working; the turn owns the deck.
  if (Voice.state.runtime === "working" || agentSpeech?.working) return;
  noteSubmittedSegments(generation, clean, opts.segments ?? [clean]);
  // The whole request is fenced as one unit from here on. Every awaited step
  // rechecks it, so an engine or setup change made while a classifier, the
  // provider gate or the chat call was pending retires the entire request
  // rather than letting it fall through to a remote call.
  const turn = beginTurn(generation);
  clearEndpoint();
  // Stop actual capture once a turn submits.
  await deps.voiceListenStop();
  if (!stillOwned(turn)) return;
  Voice.clearTurnUI();
  Voice.state.runtime = "working";
  Voice.notify();

  // Every turn fences native side effects on its own generation, flow or
  // not, so deterministic routes below run through the same queue fences.
  prepareFlowGeneration(generation);

  // Flow: opt-in typed command grammar. Only runs when Flow is on and the
  // utterance parses into the six supported kinds. Anything else falls through
  // to the existing deterministic and agent path below, unchanged.
  if (State.settings.flowEnabled) {
    const handled = await tryFlowTurn(clean, generation);
    if (handled) return;
    if (!stillOwned(turn)) return;
  }

  // Deterministic local tools first: offline pause and saved launches work
  // with no LLM credentials at all.
  try {
    const route = await deps.voiceToolResolve(clean);
    if (!fenced(generation)) return;
    if (route && route.kind === "media" && route.action) {
      const action = route.action as "play" | "pause" | "next" | "previous" | "toggle";
      if (!State.settings.flowEnabled) {
        await deps.mediaControl(action);
        if (!fenced(generation)) return;
        Voice.state.receipt = { target: "Music", status: "ok", message: `Music ${route.action}.` };
        await speakResult(`Music ${route.action}.`, generation);
        return;
      }
      // Media runs through the same queue as every other capability, with the
      // same receipts, fences and post-action snapshot verification.
      const outcome = await runMediaFlow(action, generation);
      if (!fenced(generation)) return;
      Voice.state.flowReceipt = outcome.receipt;
      const failed = outcome.receipt?.steps.find((s) => s.state === "failed");
      if (!outcome.receipt || failed) {
        Voice.state.receipt = {
          target: "Music",
          status: "failed",
          message: outcome.error ?? failed?.message ?? "That did not run.",
        };
        Voice.state.runtime = "standby";
        Voice.notify();
        return;
      }
      // The card and the speech carry the actual queue summary: a media
      // action without a matching snapshot reads as sent without proof.
      const mediaMessage = formatPlanReceipt(outcome.receipt);
      Voice.state.receipt = { target: "Music", status: "ok", message: mediaMessage };
      await speakResult(mediaMessage, generation);
      return;
    }
    if (route && (route.kind === "app" || route.kind === "folder") && route.target) {
      if (!State.settings.flowEnabled) {
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
      // Deterministic launches run through the same queue: generation
      // fenced, registry validated, and honestly sent without proof.
      const outcome = await runLaunchFlow(route.kind, route.target, generation);
      if (!fenced(generation)) return;
      Voice.state.flowReceipt = outcome.receipt ?? null;
      const failed = outcome.receipt?.steps.find((s) => s.state === "failed");
      const message = outcome.error ?? failed?.message
        ?? (outcome.receipt ? formatPlanReceipt(outcome.receipt) : "That did not run.");
      const broken = failed != null || !outcome.receipt;
      Voice.state.receipt = { target: route.target, status: broken ? "failed" : "ok", message };
      if (broken) {
        Voice.state.runtime = "standby";
        Voice.notify();
        return;
      }
      await speakResult(message, generation);
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
  if (!stillOwned(turn)) return;

  // The decision engine, in the same slot for both. The engine is the one
  // captured when the request started, so a change made while the
  // deterministic routes above ran has already retired the request and never
  // reaches either branch. Local Laya ends the turn itself on every outcome,
  // so the agent path below is unreachable while it is selected: no Jev call,
  // no provider check, no remote chat.
  if (turn.engine === "laya") {
    await decideWithLaya(clean, generation);
    return;
  }
  // Bounded Jev classifier after deterministic local routes, before the
  // generative fallback. Shadow records without altering execution.
  // Local routes above already returned, so they always bypass Jev.
  if (shouldAskJev("agent")) {
    const done = await decideWithJev(clean, generation);
    if (!stillOwned(turn)) return;
    if (done) return;
  }
  if (!stillOwned(turn)) return;

  // Agent path needs the free-only gate; local tools above never did. The
  // gate sits after every supported local route on purpose, so an offline
  // turn never needs a provider at all.
  try {
    await deps.voiceProviderCheck();
  } catch (err) {
    if (!stillOwned(turn)) return;
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  // Rechecked immediately before the remote call: a switch that landed while
  // the provider was being made ready must not become a request.
  if (!stillOwned(turn)) return;

  // One shared implementation for voice and typed turns, owner fenced.
  const context = voiceChatContext();
  const query = memoryPrefix() + clean;
  const owner = currentChatOwner();
  const speech = { generation, owner, working: true, playing: false, failed: false, spoken: "", dispatch: Promise.resolve(), ended: Promise.resolve(), finish: () => {} };
  agentSpeech = speech;
  let unlisten = () => {};
  try {
    unlisten = await deps.chatDeltas((text) => {
      if (!turn.owns() || currentChatOwner() !== owner || agentSpeech !== speech || !speech.working) return;
      Voice.state.receipt = { target: "Agent", status: "ok", message: excerpt(text) };
      Voice.notify();
      heightTick?.();
      if (speech.spoken || speech.failed || Voice.state.muted || State.paused) return;
      const sentence = firstSentence(speakPreview(text));
      if (!sentence) return;
      speech.spoken = sentence;
      speech.playing = true;
      speech.ended = new Promise<void>((resolve) => { speech.finish = resolve; });
      speech.dispatch = deps.voiceSpeak(sentence, generation).catch(() => {
        speech.playing = false;
        speech.failed = true;
        speech.finish();
      });
    });
  } catch { /* Streaming is optional. */ }
  if (!turn.owns() || currentChatOwner() !== owner || agentSpeech !== speech) {
    unlisten();
    retireRequest(turn.owner);
    return;
  }
  voiceThinkingOwner = turn.owner;
  voiceThinkingChatOwner = owner;
  State.stateOverride = "thinking";
  State.notify();
  let outcome: { text: string } | { error: string };
  try {
    outcome = await deps.chatTurn(query, context, () => heightTick?.(), owner);
  } finally {
    speech.working = false;
    unlisten();
  }
  // A reply that lands after a Stop, a routing change or a newer request is
  // retired through the owner check alone. If a newer request owns the deck by
  // now, this one touches nothing: not the thinking indicator, not the runtime,
  // and not the queue the newer request is using.
  if (!turn.owns()) {
    retireRequest(turn.owner);
    return;
  }
  activeRequestOwner = 0;
  voiceThinkingOwner = 0;
  if ("error" in outcome) {
    clearFollowup();
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
  await speech.dispatch;
  // Consume the first completion before sending the remainder. A delayed
  // speech_ended must never re-arm capture over a newly queued utterance.
  await speech.ended;
  if (!fenced(generation) || currentChatOwner() !== owner || agentSpeech !== speech) return;
  await speakResult(outcome.text, generation, speech.spoken);
}

/** The first complete sentence, long enough to be useful as talkback. */
export function firstSentence(text: string): string {
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    const sentence = text.slice(0, match.index! + 1).trim();
    if (sentence.length >= 12) return sentence;
  }
  return "";
}

/** One line of card copy for a queue step receipt, honest about state:
 *  verified only with evidence, sent without proof, waiting for a click,
 *  failed with its reason, or stopped. */
function flowStepLabel(step: FlowStepReceipt): string {
  if (step.state === "completed") return step.evidence ? `verified: ${step.evidence}` : "verified";
  if (step.state === "dispatched") return "sent without proof";
  if (step.state === "awaiting") return "waiting for your click";
  if (step.state === "failed") return `failed: ${step.message}`;
  if (step.state === "cancelled") return "stopped";
  return step.state;
}

/** First line of a reply for the card, bounded and single-line. */
function excerpt(reply: string, maxChars = 140): string {
  return reply.split("\n")[0]?.trim().slice(0, maxChars) ?? "";
}

/** Speaks a short result, then arms actual follow-up recognition. */
async function speakResult(short: string, generation: number, spoken = ""): Promise<void> {
  if (!fenced(generation)) return;
  if (Voice.state.muted || State.paused || agentSpeech?.failed) {
    clearFollowup();
    Voice.state.runtime = "standby";
    Voice.notify();
    heightTick?.();
    return;
  }
  const preview = speakPreview(short);
  const remaining = spoken && preview.startsWith(spoken) ? preview.slice(spoken.length).trim() : preview;
  Voice.state.runtime = "speaking";
  Voice.notify();
  followupArmed = generation;
  if (remaining) await deps.voiceSpeak(remaining, generation);
  else if (!agentSpeech?.playing) await beginFollowup(generation);
}

/** Manual send: the edit field or the aggregated segments, exactly once. */
export async function manualVoiceSubmit(editValue: string): Promise<void> {
  clearEndpoint();
  clearPendingFinish();
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

/** Runs one exact ambiguity choice. Nothing is guessed. The click is the
 *  approval, and the launch itself runs through the same generation-fenced
 *  queue with an honest sent-without-proof receipt. */
async function legacyRunVoiceChoice(option: VoiceToolOption): Promise<void> {
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

export async function runVoiceChoice(option: VoiceToolOption): Promise<void> {
  if (!State.settings.flowEnabled) return legacyRunVoiceChoice(option);
  const generation = currentGeneration();
  prepareFlowGeneration(generation);
  Voice.state.ambiguity = [];
  Voice.state.error = null;
  Voice.state.runtime = "working";
  Voice.notify();
  const kind = option.kind === "folder" ? "folder" : "app";
  const outcome = await runLaunchFlow(kind, option.target, generation);
  if (!fenced(generation)) return;
  Voice.state.flowReceipt = outcome.receipt ?? null;
  const failed = outcome.receipt?.steps.find((s) => s.state === "failed");
  const message = outcome.error ?? failed?.message
    ?? (outcome.receipt ? formatPlanReceipt(outcome.receipt) : "That did not run.");
  const broken = failed != null || !outcome.receipt;
  Voice.state.receipt = { target: option.target, status: broken ? "failed" : "ok", message };
  if (broken) {
    Voice.state.runtime = "standby";
    Voice.notify();
    return;
  }
  await speakResult(message, generation);
}

/** Runs the previewed routine's saved steps on an explicit click. */
async function legacyRunVoiceRoutine(): Promise<void> {
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

export async function runVoiceRoutine(): Promise<void> {
  if (!State.settings.flowEnabled) return legacyRunVoiceRoutine();
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
    // The routine runs through the queue with the approval its Run click just
    // granted. The native runner keeps its own step-by-step cancellation.
    const outcome = await runRoutineFlow(routine.id, generation);
    if (!fenced(generation)) return;
    const failed = outcome.receipt?.steps.find((s) => s.state === "failed");
    const problem = failed?.message ?? outcome.error ?? null;
    Voice.state.flowReceipt = outcome.receipt ?? null;
    // The actual queue summary, so an unverified dispatch never reads as a
    // finished routine.
    const summary = outcome.receipt ? formatPlanReceipt(outcome.receipt) : "That routine did not run.";
    Voice.state.receipt = {
      target: routine.name,
      status: problem ? "failed" : "ok",
      message: problem ?? summary,
    };
    await speakResult(problem ? `Routine stopped: ${problem}` : summary, generation);
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
  const payload = evt.payload as {
    kind: string; text?: string; generation?: number; message?: string;
    utterance?: number; sequence?: number;
  };
  const kind = payload.kind;
  const generation = payload.generation ?? Voice.state.generation;
  if (payload.generation != null && generation < currentGeneration()) return;
  // A pending manual finish settles only on its own terminal event. Final
  // and empty re-arm wake after handling; errors stay visible instead.
  let rearmAfterTerminal = false;
  if (pendingFinish?.generation === generation
    && (kind === "final" || kind === "empty" || kind === "error" || kind === "helper_exited")) {
    if (pendingFinish.timer != null) window.clearTimeout(pendingFinish.timer);
    pendingFinish = null;
    rearmAfterTerminal = kind === "final" || kind === "empty";
  }
  const identified = Number.isFinite(payload.utterance)
    && (kind === "empty" || Number.isFinite(payload.sequence));
  if (continuousFlowActive() && identified && handleContinuousEvent(kind, payload, generation)) {
    if (rearmAfterTerminal) {
      captureOwner = null;
      Voice.state.runtime = pumpActive ? "working" : "standby";
      Voice.notify();
      void rearmWake();
    }
    heightTick?.();
    return;
  }
  switch (kind) {
    case "partial":
      if (payload.text && Voice.applyPartial(payload.text, generation)) {
        // Wait for final recognition before scheduling task execution.
        clearEndpoint();
      }
      break;
    case "final":
      if (isWhisperBackend() && !["listening", "processing"].includes(Voice.state.runtime)) break;
      if (payload.text) {
        // Segments aggregate into one utterance; only finalization arms the
        // endpoint that submits it exactly once.
        if (Voice.applyFinal(payload.text, generation)) scheduleSubmit(generation);
        heightTick?.();
      }
      break;
    case "utterance_sealed":
      // Capture is still open: the sealed audio is decoding. The deck keeps
      // its live captions and never claims it stopped listening.
      break;
    case "wake_on":
      Voice.state.wakeOn = true;
      Voice.notify();
      break;
    case "wake_off":
      Voice.state.wakeOn = false;
      Voice.notify();
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
    case "transcribing":
      // Local Whisper finished capture and is transcribing offline.
      // Final transcription only, no live provisional captions.
      if (!fenced(generation)) break;
      Voice.state.runtime = "processing";
      Voice.state.partial = "";
      Voice.notify();
      break;
    case "empty":
      if (!["listening", "processing"].includes(Voice.state.runtime)) break;
      rearmAfterTerminal = true;
      // Silence or blank audio is discarded, never submitted. Visible hint.
      if (!fenced(generation)) break;
      Voice.state.partial = "";
      Voice.state.pendingSegments = [];
      Voice.state.runtime = "standby";
      Voice.state.error = "No speech detected. Try again.";
      Voice.notify();
      break;
    case "speech_started":
      Voice.state.runtime = "speaking";
      Voice.notify();
      break;
    case "speech_ended":
      if (agentSpeech?.generation === generation) {
        agentSpeech.playing = false;
        agentSpeech.finish();
        if (followupArmed !== generation) {
          if (agentSpeech.working) {
            Voice.state.runtime = "working";
            Voice.notify();
          }
          break;
        }
      }
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
    case "routing_cancelled":
      // Native intent survives event/reply reordering. A routing retirement
      // preserves text; an explicit Stop always follows the cancelled case.
      break;
    case "cancelled":
      clearFollowup();
      ++listenOperation;
      // Stop or a routing retirement: capture and everything queued for it
      // are gone, whatever the runtime was showing.
      retireContinuousFlow();
      Voice.cancelTurn(generation);
      break;
    case "recovered":
      Voice.state.deviceError = false;
      Voice.state.error = null;
      Voice.state.runtime = "standby";
      Voice.notify();
      break;
    case "helper_exited":
      clearFollowup();
      ++listenOperation;
      if (activeRequestOwner !== 0) retireRequest(activeRequestOwner);
      retireContinuousFlow();
      cancelFlowQueue();
      Voice.state.generation = Math.max(Voice.state.generation, generation);
      Voice.state.runtime = "error";
      Voice.state.error = "Voice helper exited. Start listening again to recover.";
      Voice.notify();
      break;
    case "stopped":
      // The native side closed capture, whether that came from mute, pause,
      // lock, suspend or a cancel. Nothing may still be queued for it, and the
      // deck must stop claiming it is listening.
      if (activeCapture() == null) break;
      retireContinuousFlow();
      cancelFlowQueue();
      Voice.state.partial = "";
      Voice.state.pendingSegments = [];
      Voice.state.runtime = "standby";
      Voice.notify();
      break;
    case "error": {
      const message = payload.message ?? payload.text ?? "Voice error.";
      const speech = agentSpeech;
      const playbackFailed = speech?.generation === generation
        && (speech.playing || /^Speech failed:/i.test(message));
      clearFollowup(!playbackFailed);
      if (playbackFailed && speech) {
        speech.playing = false;
        speech.failed = true;
      }
      if (!playbackFailed) {
        // Capture is over: the deck must not go on showing itself as listening,
        // and nothing still queued for this session may run.
        if (activeRequestOwner !== 0) retireRequest(activeRequestOwner);
        retireContinuousFlow();
        cancelFlowQueue();
        Voice.state.generation = Math.max(Voice.state.generation, generation);
      }
      Voice.state.runtime = "error";
      // Captions preserve text after errors: stable lines stay, and errors
      // stay visible until the next explicit start, retry or cancel.
      Voice.state.error = message;
      Voice.state.deviceError = /microphone|device|audio|recognizer/i.test(message);
      Voice.notify();
      break;
    }
    default:
      break;
  }
  // Manual mic stop waited for this terminal: return to keyword standby now
  // that the authoritative result is in. Errors stay visible instead.
  if (rearmAfterTerminal) {
    void rearmWake();
  }
  heightTick?.();
}

/** Handles one identified continuous event. Returns true when the event was
 * a continuous one and must not fall through to the one-shot path.
 *
 * A live caption updates the card and may dispatch a clause prefix that has
 * survived the correction window. A sealed final is authoritative: it joins
 * the transcript without ending the turn, and it may extend what the captions
 * already dispatched but never replay it. Nothing here closes the microphone:
 * capture ownership is separate from what the card is displaying. */
function handleContinuousEvent(
  kind: string,
  payload: { text?: string; utterance?: number; sequence?: number },
  generation: number,
): boolean {
  if (kind !== "partial" && kind !== "final" && kind !== "empty") return false;
  if (!fenced(generation)) return true;
  const snapshot = {
    utterance: payload.utterance as number,
    sequence: payload.sequence as number,
    text: payload.text ?? "",
  };
  if (kind === "partial") {
    // Live caption only. A snapshot never submits and never ends the turn.
    if (snapshot.text) Voice.applyPartial(snapshot.text, generation);
    feedContinuousFlow(clauseTracker.observePartial(snapshot), generation);
    Voice.notify();
    return true;
  }
  if (kind === "empty") {
    // A silent utterance: capture keeps running, nothing was said and
    // nothing is submitted. No error is shown for a pause between commands.
    Voice.state.partial = "";
    Voice.notify();
    return true;
  }
  // A sealed utterance. The transcript records it, the runtime stays
  // listening because the device is still open, and the tracker decides
  // whether any complete clause is still to run.
  if (snapshot.text) Voice.recordContinuousFinal(snapshot.text, generation);
  Voice.state.partial = "";
  Voice.notify();
  const verdict = clauseTracker.observeFinal(snapshot);
  if (verdict.kind === "not-flow") {
    // A spoken correction is deliberately not a Flow command, so the tracker
    // never dispatches one. It is applied here through the existing verified
    // correction rules instead: pending work is edited in place, work that
    // already ran gets a distinct rename step, and nothing in flight is ever
    // rewritten under its dispatch.
    applySpokenCorrection(snapshot.text, generation);
    return true;
  }
  feedContinuousFlow(verdict, generation);
  // Every identified event is handled here and never falls through: the
  // one-shot path would stop capture and auto-submit, and a continuous
  // session must do neither. A sealed utterance that is not Flow and is not
  // a correction simply stays on the transcript for the user to send with the
  // Input control.
  return true;
}

/** Applies a spoken correction inside a continuous session, with the same
 * fences and receipts as the one-shot path. A correction that is not
 * recognized changes nothing at all. */
function applySpokenCorrection(text: string, generation: number): void {
  if (!fenced(generation)) return;
  let corrected: { request: import("./flow").FlowPlanRequest; note: string } | null = null;
  try {
    corrected = correctFlowTurn(text);
  } catch {
    return;
  }
  if (!corrected) return;
  prepareFlowGeneration(generation);
  setStaleCheck((gen) => !fenced(gen));
  const planned = planFromRequest(corrected.request, Date.now(), flowRegistry());
  if (!planned.plan) {
    if (!fenced(generation)) return;
    Voice.state.error = planned.error ?? "That correction cannot run.";
    Voice.notify();
    heightTick?.();
    return;
  }
  rememberFlowRequest(corrected.request);
  feedContinuousFlow({
    kind: "dispatch",
    utterance: 0,
    sequence: 0,
    final: true,
    steps: planned.plan.steps.map((s) => ({ ...s, value: s.value ?? undefined })),
    text: corrected.note,
  }, generation);
}

/** Follow-up window: real recognition now, wake re-arm or shutdown at the end.
 * The start is owned by an operation token, not the old generation: the
 * native reply carries the actual new generation, and the timeout is
 * scheduled against it, so a delayed reply after cancel cannot resurrect. */
async function beginFollowup(completedGeneration: number): Promise<void> {
  if (followupArmed !== completedGeneration || !fenced(completedGeneration)) return;
  followupArmed = null;
  clearPendingFinish();
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
  initializeListeningSession(next);
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
  if (activeCapture() != null) {
    const retirement = retireContinuousCapture(true);
    const operation = listenOperation;
    await retirement;
    if (operation !== listenOperation) return;
    Voice.state.runtime = "standby";
    Voice.notify();
    rearmWake();
    heightTick?.();
    return;
  }
  await deps.voiceListenStop();
  if (currentGeneration() !== generation) return;
  // The window ends by actual wake re-arm or capture shutdown, never drift.
  if (State.settings.voiceWakeEnabled && State.settings.voiceEnabled) {
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

// â”€â”€ Deck view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let mountedVoiceCard: HTMLElement | null = null;

/** Measure natural copy demand, independently of the bounded scroll area,
 * so content grows and shrinks without feeding the current panel size back. */
export function voiceIslandHeight(): number {
  const copy = mountedVoiceCard?.querySelector(".voice-copy") as HTMLElement | null;
  const actions = mountedVoiceCard?.querySelector(".voice-actions") as HTMLElement | null;
  if (copy?.isConnected) {
    const demand = Math.max(Number(copy.scrollHeight) || 0, Number(actions?.scrollHeight) || 0) + 78;
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
    type: "text", class: "voice-edit", placeholder: "Edit your words, then press Enter", spellcheck: "false",
    "aria-label": "Edit your words, then press Enter",
  }) as HTMLInputElement;
  const editClose = h("button", {
    class: "voice-edit-close", text: "Done", title: "Close editor, keep draft",
    "aria-label": "Close editor, keep draft",
  });
  const editWrap = h("div", { class: "voice-editor" }, edit, editClose);
  editWrap.style.display = "none";
  const status = h("div", { class: "voice-status" });
  const slot = h("button", {
    class: "voice-slot", title: "Click to show next status",
    "aria-label": "Task status. Click to show next status.",
  }) as HTMLButtonElement;
  slot.style.display = "none";
  const top = h("div", { class: "voice-top" }, status, slot);

  const micBtn = h("button", {
    class: "voice-mic", title: "Talk (Ctrl+Shift+V)",
    "aria-label": "Start listening",
  }, svg(ICONS.mic, 15));
  micBtn.addEventListener("click", () => {
    if (!State.settings.voiceEnabled) {
      void deps.openSettings();
      return;
    }
    if (Voice.state.runtime === "listening") void stopVoice();
    else void startVoice();
  });
  const inputBtn = h("button", {
    class: "voice-input", title: "Type or edit",
    "aria-label": "Open typing", "aria-expanded": "false",
  }, svg(ICONS.keyboard, 15));
  const stopIcon = svg(ICONS.plus, 11);
  const stopLabel = h("span", { text: "Stop" });
  const stopBtn = h("button", {
    class: "voice-stop", title: "Stop (Esc)",
    "aria-label": "Stop voice turn",
  }, stopIcon, stopLabel);
  stopBtn.addEventListener("click", () => void cancelVoice());
  stopBtn.style.display = "none";
  // Draft survives editor closes, mode changes and hidden time. Enter
  // submits the draft or, when empty, the aggregated utterance, so
  // confirm first turns always have an explicit path. Escape closes the
  // editor and keeps the draft.
  let draft = "";
  let editorOpen = false;
  function setEditor(open: boolean, focusInput = false): void {
    editorOpen = open;
    if (!open) draft = edit.value;
    editWrap.style.display = open ? "" : "none";
    inputBtn.setAttribute("aria-expanded", String(open));
    inputBtn.setAttribute("aria-label", open ? "Close typing" : "Open typing");
    if (open) {
      edit.value = draft;
      if (focusInput) edit.focus();
    }
    onHeightChange();
  }
  inputBtn.addEventListener("click", () => setEditor(!editorOpen, true));
  editClose.addEventListener("click", () => {
    draft = edit.value;
    setEditor(false);
    inputBtn.focus();
  });
  // Typing stops the endpoint and holds auto dispatch: an edited turn never
  // auto submits mid edit, and later partials cannot re arm it until Enter.
  edit.addEventListener("input", () => {
    draft = edit.value;
    clearEndpoint();
    editHold = true;
  });
  edit.addEventListener("keydown", (e) => {
    e.stopPropagation();
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      const text = edit.value;
      draft = "";
      edit.value = "";
      setEditor(false);
      void manualVoiceSubmit(text);
    }
    if (key === "Escape") {
      e.preventDefault();
      draft = edit.value;
      setEditor(false);
      inputBtn.focus();
    }
  });
  // Jev clarify refills this field with the submitted request for editing;
  // the owned filler is registered below, next to dispose.
  const openEditor = () => {
    if (disposed) return;
    setEditor(true, true);
  };
  voiceEditorOpener = openEditor;

  // Manual pins and the B conversation alternative live in Voice settings.
  // The card keeps Mic and Input only.
  const attachWindow = h("button", {
    class: "voice-attach-btn", text: "Attach window",
    onclick: () => void snapshotWindowContext(),
  });
  const attachFile = h("button", {
    class: "voice-attach-btn", text: "Attach file",
    onclick: () => void attachDocument(),
  });
  attachRow.append(attachWindow, attachFile);

  const copy = h("div", { class: "voice-copy" }, top, stable, pager, partial, error, receipt, choices, ctxRow, attachRow, editWrap);
  const body = h("div", { class: "voice-body", tabindex: "0", "aria-label": "Voice content" }, copy);
  const actions = h("div", { class: "voice-actions", role: "group", "aria-label": "Voice actions" }, micBtn, inputBtn, stopBtn);
  const card = h("div", { class: "card wash voice-card" }, h("div", { class: "voice-main" }, body, actions));
  card.style.setProperty("--wash", "rgba(34,211,238,0.30)");
  mountedVoiceCard = card;
  const el = h("div", { class: "view" }, card);

  const offVoice = Voice.subscribe(() => sync());
  const offState = State.subscribe(() => sync());
  let disposed = false;

  /** Key of the rendered transcript: mode, page and line ids. Unchanged
   * content keeps its DOM nodes, so partial updates never restart the
   * line fade animations. */
  let renderedStableKey = "";
  let slotTips: string[] = [];
  let slotIndex = 0;
  let slotTimer: number | null = null;

  function onVisibility(): void {
    if (disposed) return;
    if (!el.isConnected) {
      clearSlotTimer();
      return;
    }
    if (document.hidden) clearSlotTimer();
    else sync();
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onJevClarify(text: string): void {
    if (disposed) return;
    draft = text;
    editHold = false;
    setEditor(true, false);
    edit.value = text;
  }
  activeJevFiller = onJevClarify;
  setJevEditFiller(onJevClarify);

  function sync(): void {
    if (disposed) return;
    if (!el.isConnected) {
      if (slotTimer != null) {
        window.clearTimeout(slotTimer);
        slotTimer = null;
      }
    }
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
    if (State.settings.flowEnabled && (activeCapture() != null || Voice.state.flowRecentReceipts.length > 0)) {
      if (Voice.state.flowCurrentAction) {
        receipt.append(h("div", { class: "voice-receipt-line", text: Voice.state.flowCurrentAction }));
      }
      for (const step of Voice.state.flowRecentReceipts) {
        receipt.append(h("div", { class: "voice-receipt-line", text: `${step.kind.replace(".", " ")}: ${flowStepLabel(step)}` }));
      }
    }
    // The owned result excerpt reads on the card in every deck: compact in
    // A, beside the transcript in B, with approvals in C.
    if (Voice.state.receipt && !(State.settings.flowEnabled && Voice.state.flowRecentReceipts.length > 0)) {
      receipt.append(h("div", {
        class: "voice-receipt-line",
        text: `${Voice.state.receipt.target}: ${Voice.state.receipt.message}`,
      }));
    }
    // Routing diagnostics remain in Settings History, outside the voice card.
    if (mode === "c") {
      if (Voice.state.routinePreview) {
        const id = Voice.state.routinePreview.routineId;
        const routine = routineById(id);
        const steps = routine ? resolveRoutineSteps(routine) : [];
        const list = h("ol", { class: "voice-steps", tabindex: "0", "aria-label": "Saved task steps" });
        for (const step of steps) {
          const description = step.missing ? "Shortcut missing"
            : step.kind === "folder" ? "Open folder"
            : step.kind === "app" ? "Open application"
            : step.kind === "file" ? "Open file"
            : step.kind === "url" ? "Open link" : "Saved shortcut";
          list.append(h("li", { class: "voice-step", title: step.target },
            svg(step.kind === "folder" ? ICONS.folder : step.kind === "app" ? ICONS.app : ICONS.doc, 18),
            h("div", { class: "voice-step-copy" },
              h("strong", { text: step.name }), h("small", { text: description })),
          ));
        }
        const run = h("button", {
          class: "btn primary",
          text: `Run ${routine?.name ?? id}`,
          onclick: () => void runVoiceRoutine(),
        });
        receipt.append(h("div", { class: "voice-routine" }, list, run));
      }
      // Expandable ordered queue receipts: every step with its honest state.
      if (Voice.state.flowReceipt) {
        const steps = Voice.state.flowReceipt.steps;
        const details = h("details", { class: "voice-flow" });
        details.append(h("summary", {
          class: "voice-receipt-line",
          text: `Flow: ${steps.length} step(s) in order`,
        }));
        const list = h("ol", {
          class: "voice-steps", tabindex: "0", "aria-label": "Flow step receipts",
        });
        for (const step of steps) {
          list.append(h("li", { class: "voice-step", title: step.message },
            h("div", { class: "voice-step-copy" },
              h("strong", { text: step.kind.replace(".", " ") }),
              h("small", { text: flowStepLabel(step) })),
          ));
        }
        details.append(list);
        receipt.append(details);
      }
      // Compact supported/unavailable capability view, with a precise reason
      // for everything the queue cannot run.
      if (State.settings.flowEnabled) {
        const view = flowCapabilityView();
        const details = h("details", { class: "voice-flow" });
        details.append(h("summary", {
          class: "voice-receipt-line",
          text: `Flow capabilities: ${view.supported.length} ready, ${view.unavailable.length} unavailable`,
        }));
        const list = h("ol", {
          class: "voice-steps", tabindex: "0", "aria-label": "Flow capabilities",
        });
        for (const line of [...view.supported, ...view.unavailable]) {
          list.append(h("li", { class: "voice-step", title: line.reason || line.id },
            h("div", { class: "voice-step-copy" },
              h("strong", { text: line.label }),
              h("small", { text: line.ready ? "ready" : line.reason })),
          ));
        }
        details.append(list);
        receipt.append(details);
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
    const listening = Voice.state.runtime === "listening";
    micBtn.classList.toggle("on", listening);
    micBtn.title = !State.settings.voiceEnabled
      ? "Voice is off. Open Settings to turn it on."
      : listening ? "Stop listening" : "Talk (Ctrl+Shift+V)";
    micBtn.setAttribute("aria-label", !State.settings.voiceEnabled
      ? "Voice is off. Open Settings to turn it on."
      : listening ? "Stop listening" : "Start listening");
    micBtn.setAttribute("aria-pressed", String(listening));
    inputBtn.classList.toggle("on", editorOpen);
    const showStop = Voice.state.runtime === "speaking"
      || Voice.state.runtime === "working"
      || Voice.state.runtime === "processing"
      // Continuous capture holds the microphone open across utterances, so
      // the card offers Stop while it is live rather than only while work is
      // running. Outside Flow the existing states decide exactly as before.
      || activeCapture() != null;
    stopBtn.style.display = showStop ? "" : "none";
    stopIcon.style.display = State.settings.flowEnabled ? "none" : "";
    stopLabel.style.display = State.settings.flowEnabled ? "" : "none";
    syncSlot(mode);
  }

  function reducedMotion(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function isCardHidden(): boolean {
    if (disposed) return true;
    if (!el.isConnected) return true;
    if (typeof document !== "undefined" && document.hidden) return true;
    const inIsland = typeof el.closest === "function" && el.closest("#island") != null;
    if (inIsland) {
      if (State.mode === "hidden") return true;
      if (State.view !== "voice") return true;
      if (!el.classList.contains("on")) return true;
    }
    return false;
  }

  function clearSlotTimer(): void {
    if (slotTimer != null) {
      window.clearTimeout(slotTimer);
      slotTimer = null;
    }
  }

  function slotTipsForState(): string[] | null {
    if (Voice.deckMode() !== "c") return null;
    if (Voice.state.routinePreview) {
      const routine = routineById(Voice.state.routinePreview.routineId);
      const steps = routine ? resolveRoutineSteps(routine) : [];
      const name = routine?.name ?? Voice.state.routinePreview.name;
      return [`${steps.length} saved steps`, "Runs only after your click", name];
    }
    if (Voice.state.ambiguity.length > 0) {
      return [`${Voice.state.ambiguity.length} choices`, "Choose one to continue", "Nothing runs until you pick"];
    }
    if (Voice.state.approvalNote) {
      return ["Approval needed", Voice.state.approvalNote.slice(0, 80), "Decide in its card"];
    }
    if (Voice.state.context) {
      return ["Context attached", Voice.state.context.label.slice(0, 80), "Remove when done"];
    }
    if (Voice.state.runtime === "working" || Voice.state.runtime === "speaking" || Voice.state.runtime === "processing") {
      return [runtimeLabel(), "Result appears here", "Esc cancels"];
    }
    return null;
  }

  function renderSlot(animate: boolean): void {
    const tip = slotTips[slotIndex] ?? "";
    slot.textContent = tip;
    slot.setAttribute("aria-label", tip ? `${tip}. Click to show next status.` : "Task status. Click to show next status.");
    if (!animate || reducedMotion()) {
      slot.classList.remove("voice-slot-enter");
      return;
    }
    slot.classList.remove("voice-slot-enter");
    void slot.offsetWidth;
    slot.classList.add("voice-slot-enter");
  }

  function scheduleSlot(): void {
    clearSlotTimer();
    if (disposed) return;
    if (reducedMotion()) return;
    if (slotTips.length <= 1) return;
    if (isCardHidden()) return;
    slotTimer = window.setTimeout(() => {
      slotTimer = null;
      if (disposed) return;
      if (reducedMotion()) return;
      if (isCardHidden()) return;
      if (slot.matches(":hover") || slot.matches(":focus") || slot.matches(":focus-within")) {
        scheduleSlot();
        return;
      }
      slotIndex = (slotIndex + 1) % slotTips.length;
      renderSlot(true);
      scheduleSlot();
    }, 4000);
  }

  function syncSlot(mode: "a" | "b" | "c"): void {
    void mode;
    if (disposed) return;
    const tips = slotTipsForState();
    if (!tips || tips.length === 0) {
      slotTips = [];
      slotIndex = 0;
      slot.style.display = "none";
      clearSlotTimer();
      return;
    }
    slot.style.display = "";
    const key = tips.join("|");
    if (key !== slotTips.join("|")) {
      slotTips = tips;
      slotIndex = 0;
      renderSlot(false);
    } else {
      slotTips = tips;
      if (slotIndex >= slotTips.length) slotIndex = 0;
      if (slot.textContent !== (slotTips[slotIndex] ?? "")) renderSlot(false);
    }
    if (isCardHidden()) {
      clearSlotTimer();
      return;
    }
    if (slotTimer == null) scheduleSlot();
  }

  slot.addEventListener("click", () => {
    if (disposed) return;
    if (slotTips.length <= 1) return;
    slotIndex = (slotIndex + 1) % slotTips.length;
    renderSlot(true);
    scheduleSlot();
  });
  slot.addEventListener("mouseenter", () => clearSlotTimer());
  slot.addEventListener("mouseleave", () => { if (!disposed) scheduleSlot(); });
  slot.addEventListener("focus", () => clearSlotTimer());
  slot.addEventListener("blur", () => { if (!disposed) scheduleSlot(); });

  sync();
  return {
    el,
    sync,
    focus() {
      if (editorOpen) edit.focus();
      else micBtn.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSlotTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      offVoice();
      offState();
      if (voiceEditorOpener === openEditor) voiceEditorOpener = null;
      if (activeJevFiller === onJevClarify) {
        activeJevFiller = null;
        setJevEditFiller(null);
      }
      if (mountedVoiceCard === card) mountedVoiceCard = null;
    },
  };
}

/** Authoritative mute: closes capture natively and blocks every re-arm. */
export async function toggleMute(): Promise<void> {
  const next = !Voice.state.muted;
  // Muting ends a continuous session whatever the deck is showing: the
  // capture owner, not the runtime, decides.
  if (next && activeCapture() != null) await retireContinuousCapture(false);
  try {
    await deps.voiceMute(next);
  } catch (err) {
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }
  Voice.state.muted = next;
  if (!next) await rearmWake();
  if (next) {
    clearEndpoint();
    clearFollowup(false);
    clearPendingFinish();
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
    clearPendingFinish();
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

// â”€â”€ Settings section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  const status = h("div", { class: "hint", text: "Checking speech enginesâ€¦" });
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
    try {
      await Bridge.voiceAudition();
    } catch (err) {
      audition.textContent = String(err).replace(/^Error:\s*/, "");
    }
  });

  const whisperStatus = h("div", { class: "hint", text: "Local transcription: checking Whisper files." });
  const backend = h("select", {}) as HTMLSelectElement;
  backend.append(
    h("option", { value: "system", text: "Windows dictation" }),
    h("option", { value: "whisper", text: "Local Whisper (offline)" }),
  );
  backend.value = s().voiceBackend === "whisper" ? "whisper" : "system";
  backend.addEventListener("change", async () => {
    const voiceBackend = backend.value === "whisper" ? "whisper" : "system";
    await applyRoutingSettings({ voiceBackend });
    s().voiceBackend = voiceBackend;
    void opts.save();
    void refreshWhisperStatus();
  });
  const model = h("select", {}) as HTMLSelectElement;
  model.append(
    h("option", { value: "base", text: "Base (bundled, English dictation)" }),
    h("option", { value: "small", text: "Small (explicit setup)" }),
  );
  model.value = s().voiceModel === "small" ? "small" : "base";
  model.addEventListener("change", () => {
    s().voiceModel = model.value === "small" ? "small" : "base";
    void opts.save();
    void refreshWhisperStatus();
  });

  async function refreshWhisperStatus(): Promise<void> {
    const st = await deps.voiceWhisperStatus().catch(() => null);
    if (!st) {
      whisperStatus.textContent = "Local transcription status unavailable outside Choom. Whisper gives final transcription only, no live captions.";
      return;
    }
    const parts: string[] = [];
    if (st.binary && st.base) {
      parts.push("Whisper ready: Base bundled.");
    } else if (st.error) {
      parts.push(st.error);
    }
    if (!st.small) {
      parts.push("Small shows unavailable until an explicit local model setup. It is not bundled.");
    } else {
      parts.push("Small available.");
    }
    parts.push("6 threads. Hints: Choom, Spotify, Visual Studio Code.");
    parts.push("Whisper gives final transcription only, no live captions. Provisional text never runs tasks.");
    whisperStatus.textContent = parts.join(" ");
    backend.value = s().voiceBackend === "whisper" ? "whisper" : "system";
    model.value = s().voiceModel === "small" ? "small" : "base";
  }

  const memInput = h("input", {
    type: "text", placeholder: "Add a fact to rememberâ€¦", style: "flex:1 1 auto;min-width:0",
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

  // Deck view pin. The card keeps Mic and Input only; Auto, A, B and C
  // are chosen here and saved with the rest of Voice settings.
  const viewSelect = h("select", {}) as HTMLSelectElement;
  viewSelect.append(
    h("option", { value: "auto", text: "Auto (ribbon, task instance as needed)" }),
    h("option", { value: "a", text: "A ribbon" }),
    h("option", { value: "b", text: "B conversation" }),
    h("option", { value: "c", text: "C action preview" }),
  );
  viewSelect.value = validDeckMode(s().voiceMode) ? s().voiceMode : "auto";
  viewSelect.addEventListener("change", () => {
    const next = validDeckMode(viewSelect.value) ? viewSelect.value : "auto";
    s().voiceMode = next;
    Voice.state.deckPin = next;
    Voice.notify();
    void opts.save();
  });

  // Flow settings, same row style as the rest of Voice: the opt-in, the
  // required notes folder, the note editor, the browser and the engine.
  function flowText(value: string, placeholder: string, apply: (v: string) => void): HTMLInputElement {
    const input = h("input", {
      type: "text", value, placeholder, style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      apply(input.value.trim());
      void opts.save();
    });
    return input;
  }
  const flowFolderInput = flowText(
    s().flowNotesFolder, "Folder that holds Flow notes", (v) => { s().flowNotesFolder = v; },
  );
  const flowEditorInput = flowText(
    s().flowEditor, "Editor that opens a note (exe path)", (v) => { s().flowEditor = v; },
  );
  const flowBrowserInput = flowText(
    s().flowBrowser, "Browser exe (empty uses the default)", (v) => { s().flowBrowser = v; },
  );
  const flowEngineInput = flowText(
    s().flowSearchEngine, "https://duckduckgo.com/?q={q}", (v) => { s().flowSearchEngine = v; },
  );

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
    h("div", { class: "row" }, h("label", { text: "Transcription" }), backend),
    h("div", { class: "row" }, h("label", { text: "Whisper model" }), model),
    whisperStatus,
    h("div", { class: "row" }, h("label", { text: "Auto-send" }), toggle(s().voiceAutoSubmit ?? true, (v) => {
      s().voiceAutoSubmit = v;
      void opts.save();
    })),
    h("div", { class: "row" }, h("label", { text: "View" }), viewSelect),
    h("div", { class: "hint", text: "Flow actions: spoken commands run typed, validated capabilities only. Each capability shows when it is ready or why it is unavailable." }),
    h("div", { class: "row" }, h("label", { text: "Flow actions" }), toggle(s().flowEnabled, async (v) => {
      await applyRoutingSettings({ flowEnabled: v });
      s().flowEnabled = v;
      void opts.save();
    })),
    h("div", { class: "row" }, h("label", { text: "Notes folder" }), flowFolderInput),
    h("div", { class: "row" }, h("label", { text: "Note editor" }), flowEditorInput),
    h("div", { class: "row" }, h("label", { text: "Flow browser" }), flowBrowserInput),
    h("div", { class: "row" }, h("label", { text: "Search engine" }), flowEngineInput),
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
  void refreshWhisperStatus();
  if (s().voiceMemoryEnabled) void refreshMemories();
  return section;
}

// Request routing settings owned by the Brain detail. Same controls, row
// styles and behavior as before, only the host category changed: nothing
// duplicates Voice fields. The engine selector sits above both engines and is
// independent of the chat provider, which stays exactly as the user selected
// it.

export function jevSettingsSection(opts: VoiceSectionOpts): HTMLElement {
  const s = () => opts.getSettings();

  // ── Engine selection ──────────────────────────────────────────────────
  const engine = h("select", {}) as HTMLSelectElement;
  engine.append(
    h("option", { value: "jev", text: "Online Jev" }),
    h("option", { value: "laya", text: "Local Laya" }),
  );
  engine.value = normalizeDecisionEngine(s().decisionEngine);
  engine.addEventListener("change", () => {
    // Switching retires the old engine's ownership and advances the shared
    // generation. The request draft, the transcript and the attached context
    // are left exactly as they are.
    void switchDecisionEngine(normalizeDecisionEngine(engine.value)).then(() => {
      engine.value = normalizeDecisionEngine(State.settings.decisionEngine);
      void opts.save();
      void refreshEngineViews();
    });
  });

  // ── Online Jev, unchanged ─────────────────────────────────────────────
  const jevReceipt = h("div", { class: "hint", text: "Jev is off." });
  async function refreshJevReceipt(): Promise<void> {
    try {
      const history = await Bridge.jevHistory();
      const list = history ?? [];
      if (list.length === 0) {
        jevReceipt.textContent = normalizeJevMode(s().jevMode ?? "shadow") === "off" || !s().jevEnabled
          ? "Jev is off."
          : "No Jev decision yet. Shadow records here without changing answers.";
        return;
      }
      const last = list[list.length - 1];
      jevReceipt.textContent = formatJevReceipt(last);
    } catch {
      jevReceipt.textContent = "Jev history unavailable outside Choom.";
    }
  }
  const jevMode = h("select", {}) as HTMLSelectElement;
  jevMode.append(
    h("option", { value: "off", text: "Off" }),
    h("option", { value: "shadow", text: "Shadow (record only)" }),
    h("option", { value: "assisted", text: "Assisted (answer or clarify)" }),
  );
  jevMode.value = normalizeJevMode(s().jevMode ?? "shadow");
  jevMode.addEventListener("change", () => {
    s().jevMode = normalizeJevMode(jevMode.value);
    void opts.save();
    void refreshJevReceipt();
  });
  const jevThreshold = h("input", {
    type: "range", min: "75", max: "95", step: "5",
    value: String(Math.round(clampJevThreshold(s().jevThreshold ?? 0.75) * 100)),
  }) as HTMLInputElement;
  const jevThresholdLabel = h("span", {
    class: "hint",
    text: `${clampJevThreshold(s().jevThreshold ?? 0.75).toFixed(2)}`,
  });
  jevThreshold.addEventListener("input", () => {
    s().jevThreshold = clampJevThreshold(Number(jevThreshold.value) / 100);
    jevThresholdLabel.textContent = s().jevThreshold.toFixed(2);
    void opts.save();
  });
  const jevDeadline = h("input", {
    type: "range", min: "500", max: "8000", step: "250",
    value: String(clampJevDeadlineMs(s().jevDeadlineMs ?? 2500)),
  }) as HTMLInputElement;
  const jevDeadlineLabel = h("span", {
    class: "hint",
    text: `${clampJevDeadlineMs(s().jevDeadlineMs ?? 2500)} ms`,
  });
  jevDeadline.addEventListener("input", () => {
    s().jevDeadlineMs = clampJevDeadlineMs(Number(jevDeadline.value));
    jevDeadlineLabel.textContent = `${s().jevDeadlineMs} ms`;
    void opts.save();
  });
  const jevClear = h("button", { text: "Clear Jev history" });
  jevClear.addEventListener("click", async () => {
    try {
      await Bridge.jevClearHistory();
    } catch {
      // Outside Choom there is nothing to clear.
    }
    lastJevReceipt = null;
    await refreshJevReceipt();
  });

  const jevBlock = h(
    "div",
    { class: "routing-block" },
    h("div", {
      class: "hint",
      text: "Optional classifier jev-1.13-free at https://opencode.ai/zen/v1/systemone. Off by default. When on, only the current request plus short capability names are sent. History keeps route, mode, confidence, latency and fallback only. Your provider and model stay as selected.",
    }),
    h("div", { class: "row" }, h("label", { text: "Jev" }), toggle(!!s().jevEnabled, (v) => {
      s().jevEnabled = v;
      void opts.save();
      void refreshJevReceipt();
    })),
    h("div", { class: "row" }, h("label", { text: "Mode" }), jevMode),
    h("div", { class: "row" }, h("label", { text: "Threshold" }), jevThreshold, jevThresholdLabel),
    h("div", { class: "row" }, h("label", { text: "Deadline" }), jevDeadline, jevDeadlineLabel),
    jevReceipt,
    h("div", { class: "row" }, jevClear),
  );

  // ── Local Laya, the offline engine ────────────────────────────────────
  // Readiness is whatever the native warm-up earned. A file that exists on
  // disk never shows Ready, so the honest states stay visible from the start.
  const layaStatus = h("div", {
    class: "hint routing-status", role: "status", text: "Checking local engine…",
  });
  async function refreshLayaStatus(): Promise<void> {
    const status = await deps.layaStatus().catch(() => null);
    layaStatus.textContent = formatLayaStatus(status);
    layaStatus.dataset.busy = "false";
  }
  function layaText(value: string, placeholder: string, apply: (v: string) => void): HTMLInputElement {
    const input = h("input", {
      type: "text", value, placeholder, style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      apply(input.value.trim());
      // A different interpreter, model or manifest retires the worker that was
      // bound to the old one, so a startup still in flight cannot answer for
      // the new setup.
      noteLocalSetupChange();
      void opts.save();
      // The setup may have changed, so readiness is re-read rather than kept.
      void refreshLayaStatus();
    });
    return input;
  }
  const layaRuntimeInput = layaText(
    s().layaRuntimePath, "Python that has Laya already installed", (v) => { s().layaRuntimePath = v; },
  );
  const layaModelInput = layaText(
    s().layaModelPath, "Folder holding the local model", (v) => { s().layaModelPath = v; },
  );
  const layaManifestInput = layaText(
    s().layaManifestPath, "Model manifest file the worker verifies", (v) => { s().layaManifestPath = v; },
  );
  const layaThreshold = h("input", {
    type: "range", min: "75", max: "95", step: "5",
    value: String(Math.round(clampLayaThreshold(s().layaThreshold ?? 0.85) * 100)),
  }) as HTMLInputElement;
  const layaThresholdLabel = h("span", {
    class: "hint",
    text: `${clampLayaThreshold(s().layaThreshold ?? 0.85).toFixed(2)}`,
  });
  layaThreshold.addEventListener("input", () => {
    s().layaThreshold = clampLayaThreshold(Number(layaThreshold.value) / 100);
    layaThresholdLabel.textContent = s().layaThreshold.toFixed(2);
    void opts.save();
  });
  layaThreshold.addEventListener("change", () => {
    // The threshold is part of what a pending decision was measured against,
    // so letting go of the slider retires the in-flight one too.
    noteLocalSetupChange();
    void opts.save();
  });
  const layaCheck = h("button", { text: "Check local engine" });
  layaCheck.addEventListener("click", async () => {
    layaStatus.dataset.busy = "true";
    layaStatus.textContent = "Loading Laya on this computer…";
    const status = await checkLocalEngine();
    if (status) layaStatus.textContent = formatLayaStatus(status);
    else layaStatus.textContent = "Local engine check unavailable outside Choom.";
    layaStatus.dataset.busy = "false";
  });
  const layaClear = h("button", { text: "Clear Laya history" });
  layaClear.addEventListener("click", async () => {
    try {
      await deps.layaClearHistory();
    } catch {
      // Outside Choom there is nothing to clear.
    }
    lastLayaReceipt = null;
  });
  const layaReceipt = h("div", { class: "hint", text: "No local Laya decision yet." });
  async function refreshLayaReceipt(): Promise<void> {
    const list = await deps.layaHistory().catch(() => null);
    if (list == null) {
      layaReceipt.textContent = "Laya history unavailable outside Choom.";
      return;
    }
    if (list.length === 0) {
      layaReceipt.textContent = "No local Laya decision yet.";
      return;
    }
    layaReceipt.textContent = formatLayaReceipt(list[list.length - 1]);
  }

  const layaBlock = h(
    "div",
    { class: "routing-block" },
    h("div", {
      class: "hint",
      text: "Laya runs on this computer. It reads what you ask and decides what should happen, without sending anything anywhere. When it is not sure, it asks you instead of guessing. It cannot answer questions, look anything up, or reach anything online: ask it to open something you have saved. Point it at a Python and a model you already have in the rows below.",
    }),
    h("div", { class: "row" }, h("label", { text: "Python" }), layaRuntimeInput),
    h("div", { class: "row" }, h("label", { text: "Model folder" }), layaModelInput),
    h("div", { class: "row" }, h("label", { text: "Manifest" }), layaManifestInput),
    h("div", { class: "row" }, h("label", { text: "Threshold" }), layaThreshold, layaThresholdLabel),
    h("div", { class: "row" }, h("label", { text: "Readiness" }), layaStatus),
    h("div", { class: "row" }, layaCheck, layaClear),
    layaReceipt,
  );

  /** True when the user asked for less motion, or the fixture asked for the
 *  same end state so a browser audit needs no OS preference change. */
function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("fixture-reduced")) {
    return true;
  }
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Shows or hides one engine block without a cut. The arriving block settles
 *  in, the leaving one fades out and is only removed once it is invisible.
 *  With reduced motion both end states are applied at once, which is the
 *  same place the reduced-motion policy puts every other hub animation. */
function showRoutingBlock(block: HTMLElement, shown: boolean): void {
  // Before the section reaches the document there is nothing on screen to
  // fade from, so the first paint is applied at once and only later changes
  // are animated.
  const firstPaint = !block.isConnected;
  if (shown) {
    block.hidden = false;
    block.classList.remove("routing-leave");
    if (firstPaint || block.classList.contains("routing-arrive")) return;
    // A reflow restarts the settle animation when the same block comes back.
    void block.offsetWidth;
    block.classList.add("routing-arrive");
    return;
  }
  if (block.hidden) return;
  block.classList.remove("routing-arrive");
  if (firstPaint) {
    block.hidden = true;
    return;
  }
  block.classList.add("routing-leave");
  let done = false;
  let timer: number | null = null;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (timer != null) window.clearTimeout(timer);
    block.removeEventListener("transitionend", finish);
    block.hidden = true;
  };
  block.addEventListener("transitionend", finish);
  // With reduced motion no transition runs, and a backgrounded tab may drop
  // the event entirely, so the hide never waits on one alone.
  if (reducedMotion()) {
    finish();
    return;
  }
  timer = window.setTimeout(finish, 400);
}

function refreshEngineViews(): void {
    const local = isLocalEngine(State.settings);
    showRoutingBlock(layaBlock, local);
    showRoutingBlock(jevBlock, !local);
    if (local) {
      void refreshLayaStatus();
      void refreshLayaReceipt();
    } else {
      void refreshJevReceipt();
    }
  }

  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Request routing" })),
    h("div", {
      class: "hint",
      text: "Pick who reads a spoken request. Online Jev sends it to a hosted classifier. Laya reads it on this computer. Switching stops the microphone if it was listening, and keeps what you had already said, so start listening again when you are ready. Your chat provider and model stay exactly as you picked them either way.",
    }),
    h("div", { class: "row" }, h("label", { text: "Engine" }), engine),
    jevBlock,
    layaBlock,
  );
  refreshEngineViews();
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
