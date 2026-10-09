// Choom voice store: transcript deck modes, turn generations, wake, tools,
// context and memory. Pure helpers are unit tested without a microphone.
// No simulated wake events in production: every wake comes from the helper.

export type VoiceDeckMode = "auto" | "a" | "b" | "c";
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

export function noteSubmitted(generation: number, text: string): void {
  lastSubmitted = { generation, text };
}

export function wasSubmitted(generation: number, text: string): boolean {
  return isDuplicateFinal(lastSubmitted, generation, text);
}

export function resetSubmissionGuard(): void {
  lastSubmitted = null;
  lastDelivered = null;
}

export interface VoiceStoreShape {
  runtime: VoiceRuntimeState;
  generation: number;
  partial: string;
  stable: VoiceLine[];
  error: string | null;
  capabilityError: string | null;
  recognizers: string[];
  voices: string[];
  muted: boolean;
  wakeOn: boolean;
  deckPin: VoiceDeckMode;
  context: VoiceContextTarget | null;
  memories: VoiceMemory[];
  memoryEnabled: boolean;
  receipt: { target: string; status: string; message: string } | null;
  routinePreview: { routineId: string; name: string } | null;
  approvalNote: string | null;
}

type Listener = () => void;

class VoiceStore {
  state: VoiceStoreShape = {
    runtime: "disabled",
    generation: 0,
    partial: "",
    stable: [],
    error: null,
    capabilityError: null,
    recognizers: [],
    voices: [],
    muted: false,
    wakeOn: false,
    deckPin: "auto",
    context: null,
    memories: [],
    memoryEnabled: false,
    receipt: null,
    routinePreview: null,
    approvalNote: null,
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
    const clean = text.trim().slice(0, 2000);
    if (!clean) return null;
    if (wasSubmitted(generation, clean)) return null;
    if (lastDelivered && lastDelivered.generation === generation && lastDelivered.text === clean) {
      return null;
    }
    lastDelivered = { generation, text: clean };
    this.state.stable = [...this.state.stable.slice(-2), { id: nextLineId++, text: clean, final: true }];
    this.state.partial = "";
    this.state.runtime = "processing";
    this.notify();
    return clean;
  }

  /** Cancels the turn: clears the partial, keeps stable lines for context. */
  cancelTurn(nextGeneration: number): void {
    this.state.generation = nextGeneration;
    this.state.partial = "";
    this.state.runtime = "standby";
    this.state.error = null;
    resetSubmissionGuard();
    this.notify();
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
