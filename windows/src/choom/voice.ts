// Choom voice store: transcript deck modes, turn generations, wake, tools,
// context and memory. Pure helpers are unit tested without a microphone.
// No simulated wake events in production: every wake comes from the helper.

export type VoiceDeckMode = "auto" | "a" | "b" | "c";
export type VoiceBackend = "system" | "whisper";
export type VoiceModel = "base" | "small";
export type VoiceRuntimeState =
  | "disabled" | "standby" | "listening" | "processing" | "working" | "speaking" | "error";

export interface VoiceLine {
  id: number;
  text: string;
  final: boolean;
}

export interface VoiceContextTarget {
  kind: "window" | "file";
  label: string;
  appName?: string;
  title?: string;
  name?: string;
  path?: string;
}

import type { VoiceToolOption } from "../core/bridge";

export interface VoiceMemory {
  id: string;
  text: string;
  createdMs: number;
  source: string;
}

/** Duplicate final guard: same generation and text submits exactly once. */
export function isDuplicateFinal(
  seen: { generation: number; text: string } | null,
  generation: number,
  text: string,
): boolean {
  return seen != null && seen.generation === generation && seen.text === text;
}

/** Stale guard: late partials, finals and replies never act on the next turn. */
export function isStale(current: number, incoming: number): boolean {
  return current !== incoming;
}

/** Deck mode resolution: manual pin wins, Auto picks by content. */
export function resolveDeckMode(
  pin: VoiceDeckMode,
  stableLines: number,
  hasContext: boolean,
  hasReceipt: boolean,
): "a" | "b" | "c" {
  if (pin === "a" || pin === "b" || pin === "c") return pin;
  if (hasContext || hasReceipt) return "c";
  if (stableLines > 1) return "b";
  return "a";
}

export function validDeckMode(mode: string): mode is VoiceDeckMode {
  return mode === "auto" || mode === "a" || mode === "b" || mode === "c";
}

/** Local Whisper uses 6 CPU threads initially, names-only vocabulary prompt. */
export const WHISPER_THREADS = 6;
export const WHISPER_PROMPT = "Choom, Spotify, Visual Studio Code";
/** Maximum utterance duration in seconds: bounded temp WAV, bounded worker. */
export const WHISPER_MAX_SECONDS = 30;

/** Backend validation: Windows dictation or local Whisper only. */
export function validVoiceBackend(value: string): value is VoiceBackend {
  return value === "system" || value === "whisper";
}

/** Model validation: Base bundled, Small via explicit local setup. */
export function validVoiceModel(value: string): value is VoiceModel {
  return value === "base" || value === "small";
}

/** Normalizes stored prefs: unknown values fall back without silent switching. */
export function normalizeVoiceBackend(value: string | null | undefined): VoiceBackend {
  return value === "whisper" ? "whisper" : "system";
}

export function normalizeVoiceModel(value: string | null | undefined): VoiceModel {
  return value === "small" ? "small" : "base";
}

/** Blank or silence output is discarded, never submitted. */
export function isWhisperBlank(text: string): boolean {
  const clean = text.trim().toLowerCase();
  if (!clean) return true;
  const markers = [
    "[blank_audio]",
    "[blank audio]",
    "[silence]",
    "(silence)",
    "*silence*",
    "[no speech]",
    "(no speech)",
  ];
  for (const m of markers) {
    if (clean === m || clean === m.replace(/[\[\]()_*]/g, "").trim()) return true;
  }
  if (/^[\[\]().*_\s]*silence[\[\]().*_\s]*$/.test(clean)) return true;
  if (/^[\[\]().*_\s]*blank[\s_]*audio[\[\]().*_\s]*$/.test(clean)) return true;
  return false;
}

/** Endpoint delay clamp: 300 to 3000 ms so thinking pauses survive. */
export function clampEndpointMs(ms: number): number {
  if (!Number.isFinite(ms)) return 900;
  return Math.min(3000, Math.max(300, Math.round(ms)));
}

/** Short factual talkback: first lines only, never code or long logs. */
export function speakPreview(reply: string, maxChars = 600): string {
  const lines = reply.split("\n").slice(0, 4).join(" ");
  return lines.replace(/```/g, " ").trim().slice(0, maxChars);
}

/** Client memory validation mirrors the backend. */
export function cleanMemoryInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 500) return null;
  return trimmed;
}

let nextLineId = 1;
let lastSubmitted: { generation: number; text: string } | null = null;
let lastDelivered: { generation: number; text: string } | null = null;
/** Every submitted aggregate plus its segments: re-delivered finals never resubmit. */
let submittedSet = new Set<string>();

function submittedKey(generation: number, text: string): string {
  return `${generation}::${text}`;
}

/** Bounded full transcript: 100 lines, newest last. The UI paginates. */
export const MAX_TRANSCRIPT_LINES = 100;
/** Transcript page size for deck B. No visible scrollbars anywhere. */
export const TRANSCRIPT_PAGE = 6;

export function noteSubmitted(generation: number, text: string): void {
  lastSubmitted = { generation, text };
  submittedSet.add(submittedKey(generation, text));
}

/** Notes one aggregate and each segment it was built from. */
export function noteSubmittedSegments(generation: number, aggregate: string, segments: string[]): void {
  noteSubmitted(generation, aggregate);
  for (const segment of segments) submittedSet.add(submittedKey(generation, segment));
}

export function wasSubmitted(generation: number, text: string): boolean {
  return isDuplicateFinal(lastSubmitted, generation, text) || submittedSet.has(submittedKey(generation, text));
}

export function resetSubmissionGuard(): void {
  lastSubmitted = null;
  lastDelivered = null;
  submittedSet = new Set<string>();
}

export interface VoiceStoreShape {
  runtime: VoiceRuntimeState;
  generation: number;
  partial: string;
  /** Bounded full transcript, newest last. Survives cancel and errors. */
  stable: VoiceLine[];
  /** Final segments waiting on the endpoint timer, joined into one submit. */
  pendingSegments: string[];
  /** Transcript page for deck B. */
  page: number;
  error: string | null;
  capabilityError: string | null;
  recognizers: string[];
  voices: string[];
  muted: boolean;
  wakeOn: boolean;
  deckPin: VoiceDeckMode;
  context: VoiceContextTarget | null;
  memories: VoiceMemory[];
  /** User-selected memory ids. Only these inject, never the whole list. */
  selectedMemoryIds: string[];
  memoryEnabled: boolean;
  receipt: { target: string; status: string; message: string } | null;
  routinePreview: { routineId: string; name: string } | null;
  approvalNote: string | null;
  /** Exact ambiguity choices awaiting an explicit click. */
  ambiguity: VoiceToolOption[];
  /** The visible error names a lost device with a Recover action. */
  deviceError: boolean;
}

type Listener = () => void;

class VoiceStore {
  state: VoiceStoreShape = {
    runtime: "disabled",
    generation: 0,
    partial: "",
    stable: [],
    pendingSegments: [],
    page: 0,
    error: null,
    capabilityError: null,
    recognizers: [],
    voices: [],
    muted: false,
    wakeOn: false,
    deckPin: "auto",
    context: null,
    memories: [],
    selectedMemoryIds: [],
    memoryEnabled: false,
    receipt: null,
    routinePreview: null,
    approvalNote: null,
    ambiguity: [],
    deviceError: false,
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Applies a helper partial unless it is stale or echo must reject it. */
  applyPartial(text: string, generation: number): boolean {
    if (isStale(this.state.generation, generation)) return false;
    if (this.state.runtime === "speaking") return false;
    if (this.state.muted) return false;
    this.state.partial = text.slice(0, 500);
    if (this.state.runtime === "standby") this.state.runtime = "listening";
    this.notify();
    return true;
  }

  /** Applies a helper final unless duplicate or stale. Returns text or null. */
  applyFinal(text: string, generation: number): string | null {
    if (isStale(this.state.generation, generation)) return null;
    if (this.state.runtime === "speaking") return null;
    if (this.state.muted) return null;
    const clean = text.trim().slice(0, 2000);
    if (!clean) return null;
    if (isWhisperBlank(clean)) return null;
    if (wasSubmitted(generation, clean)) return null;
    if (lastDelivered && lastDelivered.generation === generation && lastDelivered.text === clean) {
      return null;
    }
    lastDelivered = { generation, text: clean };
    const next = [...this.state.stable, { id: nextLineId++, text: clean, final: true }];
    this.state.stable = next.slice(-MAX_TRANSCRIPT_LINES);
    this.state.pendingSegments = [...this.state.pendingSegments, clean];
    this.state.partial = "";
    this.state.page = Math.max(0, Math.ceil(this.state.stable.length / TRANSCRIPT_PAGE) - 1);
    this.state.runtime = "processing";
    this.notify();
    return clean;
  }

  /** Takes the aggregated utterance for exactly one submit, then clears it. */
  takeSegments(): { aggregate: string; segments: string[] } {
    const segments = [...this.state.pendingSegments];
    const aggregate = segments.join(" ").trim().slice(0, 2000);
    this.state.pendingSegments = [];
    return { aggregate, segments };
  }

  /** Cancels the turn: clears the partial, keeps stable lines for context. */
  cancelTurn(nextGeneration: number): void {
    this.state.generation = nextGeneration;
    this.state.partial = "";
    this.state.pendingSegments = [];
    this.state.runtime = "standby";
    this.state.error = null;
    this.clearTurnUI();
    resetSubmissionGuard();
    this.notify();
  }

  /** Clears per-turn UI (receipts, previews, errors) and leaves the transcript. */
  clearTurnUI(): void {
    this.state.error = null;
    this.state.deviceError = false;
    this.state.receipt = null;
    this.state.routinePreview = null;
    this.state.approvalNote = null;
    this.state.ambiguity = [];
    this.notify();
  }

  /** User-selected memories only. Empty unless opted in with a selection. */
  selectedMemories(): VoiceMemory[] {
    if (!this.state.memoryEnabled) return [];
    const picked = new Set(this.state.selectedMemoryIds);
    return this.state.memories.filter((m) => picked.has(m.id));
  }

  clearContext(): void {
    this.state.context = null;
    this.notify();
  }

  deckMode(): "a" | "b" | "c" {
    return resolveDeckMode(
      this.state.deckPin,
      this.state.stable.length,
      this.state.context != null,
      this.state.receipt != null || this.state.routinePreview != null,
    );
  }
}

export const Voice = new VoiceStore();
