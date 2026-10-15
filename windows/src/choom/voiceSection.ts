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
import { Bridge, onEvent, type ChatContext, type JevCandidate, type JevOutcome, type JevReceipt, type RoutineStep, type VoiceMemory, type VoiceToolOption, type VoiceToolRoute } from "../core/bridge";
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
  Voice, TRANSCRIPT_PAGE, WHISPER_FINISH_TIMEOUT_MS, clampEndpointMs, noteSubmittedSegments, speakPreview,
  validDeckMode, wasSubmitted, type VoiceDeckMode,
} from "./voice";

/** Everything the deck touches outside itself. Production default is live. */
export interface VoiceDeps {
  voiceCapability: () => Promise<{ supported: boolean; recognizers: string[]; voices: string[]; error: string | null } | null>;
  voiceWhisperStatus: () => Promise<{ binary: boolean; base: boolean; small: boolean; error: string | null } | null>;
  openSettings: () => Promise<void>;
  voiceListenStart: (muted: boolean) => Promise<number>;
  voiceListenStop: () => Promise<void>;
  voiceWhisperFinish: () => Promise<void>;
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
  jevDecide: (request: string, candidates: JevCandidate[], generation: number | null) => Promise<JevOutcome>;
  jevConfigured: () => Promise<boolean>;
  chatDeltas: (handler: (text: string) => void) => Promise<() => void>;
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
  jevDecide: (request, candidates, generation) => Bridge.jevDecide(request, candidates, generation),
  jevConfigured: async () => (await Bridge.jevStatus())?.configured ?? false,
  chatDeltas: (handler) => onEvent<string>("chat-delta", handler),
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
  Voice.state.generation = generation;
  Voice.state.runtime = "listening";
  Voice.state.deviceError = false;
  Voice.state.error = null;
  Voice.notify();
  heightTick?.();
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

function isWhisperFinishing(): boolean {
  return pendingFinish != null;
}

function isWhisperRecording(): boolean {
  return isWhisperBackend()
    && Voice.state.generation > 0
    && Voice.state.runtime === "listening";
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
  if (Voice.state.runtime === "working" || Voice.state.runtime === "speaking") return;
  clearFollowup();
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
 * Returns true when the turn is complete (Assisted showed options or
 * clarification). Shadow never completes here: it records and falls through.
 * Local media, saved launches, routines, wake and cancellation never reach it.
 */
export async function decideWithJev(clean: string, generation: number): Promise<boolean> {
  let configured = false;
  try {
    configured = await deps.jevConfigured();
  } catch {
    configured = false;
  }
  if (!isJevEligible(State.settings, configured)) return false;
  const mode = normalizeJevMode(State.settings.jevMode);
  const candidates = buildJevCandidates();
  if (mode === "shadow") {
    // Recording must not delay the user's agent response.
    void deps.jevDecide(clean.slice(0, 500), candidates, generation).then((outcome) => {
      if (!fenced(generation)) return;
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
  if (Voice.state.runtime === "working" || agentSpeech?.working) return;
  noteSubmittedSegments(generation, clean, opts.segments ?? [clean]);
  clearEndpoint();
  // Stop actual capture once a turn submits.
  await deps.voiceListenStop();
  if (!fenced(generation)) return;
  Voice.clearTurnUI();
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

  // Bounded Jev classifier after deterministic local routes, before the
  // generative fallback. Shadow records without altering execution.
  // Local routes above already returned, so they always bypass Jev.
  if (shouldAskJev("agent")) {
    const done = await decideWithJev(clean, generation);
    if (!fenced(generation)) return;
    if (done) return;
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
  const speech = { generation, owner, working: true, playing: false, failed: false, spoken: "", dispatch: Promise.resolve(), ended: Promise.resolve(), finish: () => {} };
  agentSpeech = speech;
  let unlisten = () => {};
  try {
    unlisten = await deps.chatDeltas((text) => {
      if (!fenced(generation) || currentChatOwner() !== owner || agentSpeech !== speech || !speech.working) return;
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
  if (!fenced(generation) || currentChatOwner() !== owner || agentSpeech !== speech) {
    unlisten();
    return;
  }
  State.stateOverride = "thinking";
  State.notify();
  let outcome: { text: string } | { error: string };
  try {
    outcome = await deps.chatTurn(query, context, () => heightTick?.(), owner);
  } finally {
    speech.working = false;
    unlisten();
  }
  if (!fenced(generation) || currentChatOwner() !== owner || agentSpeech !== speech) return;
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
  // A pending manual finish settles only on its own terminal event. Final
  // and empty re-arm wake after handling; errors stay visible instead.
  let rearmAfterTerminal = false;
  if (pendingFinish?.generation === generation
    && (kind === "final" || kind === "empty" || kind === "error" || kind === "helper_exited")) {
    if (pendingFinish.timer != null) window.clearTimeout(pendingFinish.timer);
    pendingFinish = null;
    rearmAfterTerminal = kind === "final" || kind === "empty";
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
    case "cancelled":
      clearFollowup();
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
      clearFollowup();
      Voice.state.runtime = "error";
      Voice.state.error = "Voice helper exited. Start listening again to recover.";
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
  const stopBtn = h("button", {
    class: "voice-stop", title: "Stop (Esc)",
    "aria-label": "Stop voice turn",
  }, svg(ICONS.plus, 11));
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
    // The owned result excerpt reads on the card in every deck: compact in
    // A, beside the transcript in B, with approvals in C.
    if (Voice.state.receipt) {
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
      || Voice.state.runtime === "processing";
    stopBtn.style.display = showStop ? "" : "none";
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
  backend.addEventListener("change", () => {
    s().voiceBackend = backend.value === "whisper" ? "whisper" : "system";
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

// Jev settings owned by the Brain detail. Same controls and behavior as
// before, only the host category changed: nothing duplicates Voice fields.

export function jevSettingsSection(opts: VoiceSectionOpts): HTMLElement {
  const s = () => opts.getSettings();

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

  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Request routing (Jev)" })),
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
  void refreshJevReceipt();
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
