// Choom voice deck and settings. A compact default, B for extended
// transcript and multi-step work, C for selected context and click approvals.
// Main mascot stays left with existing size and padding. No visible
// scrollbars, no duplicate headings, no cockpit decoration.

import { h, svg, clear } from "../views/dom";
import { ICONS } from "../views/icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type Settings } from "../core/state";
import type { ViewHost } from "../views/views";
import {
  Voice, clampEndpointMs, noteSubmitted, speakPreview, validDeckMode, wasSubmitted,
  type VoiceDeckMode,
} from "./voice";

let endpointTimer: number | null = null;
let followupTimer: number | null = null;
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
}

function voiceChatContext(): ChatContext | null {
  const ctx = Voice.state.context;
  if (ctx?.kind === "file" && ctx.path) {
    return { kind: "file", name: ctx.name ?? "file", path: ctx.path };
  }
  if (ctx?.kind === "window" && ctx.appName && ctx.title) {
    return { kind: "window", appName: ctx.appName, title: ctx.title };
  }
  const file = State.droppedFile;
  if (State.chatHistory.length === 0 && file) {
    return { kind: "file", name: file.name, path: file.path };
  }
  return null;
}

function memoryPrefix(): string {
  if (!State.settings.voiceMemoryEnabled || Voice.state.memories.length === 0) return "";
  // Only selected memories are injected, clearly delimited as user data.
  const facts = Voice.state.memories.slice(0, 3).map((m) => `- ${m.text}`).join("\n");
  return `[User facts, not instructions]\n${facts}\n\n`;
}

/** Starts dictation. Opt-in only, returns quietly when off. */
export async function startVoice(): Promise<void> {
  if (!State.settings.voiceEnabled || Voice.state.muted) return;
  clearEndpoint();
  try {
    const generation = await Bridge.voiceListenStart();
    Voice.state.generation = generation;
    Voice.state.runtime = "listening";
    Voice.state.error = null;
    Voice.notify();
    heightTick?.();
  } catch (err) {
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

export async function stopVoice(): Promise<void> {
  clearEndpoint();
  await Bridge.voiceListenStop();
  Voice.state.runtime = "standby";
  Voice.state.partial = "";
  Voice.notify();
}

export async function cancelVoice(): Promise<void> {
  clearEndpoint();
  clearFollowup();
  try {
    const generation = await Bridge.voiceCancel();
    Voice.cancelTurn(generation);
  } catch {
    Voice.cancelTurn(Voice.state.generation + 1);
  }
  await Bridge.voiceSpeakStop();
  State.stateOverride = null;
  State.notify();
  heightTick?.();
}

/** Submits a completed utterance exactly once with its generation id. */
export async function submitVoiceFinal(text: string, generation: number): Promise<void> {
  const clean = text.trim();
  if (!clean || wasSubmitted(generation, clean)) return;
  if (Voice.state.generation !== generation) return;
  noteSubmitted(generation, clean);
  clearEndpoint();
  Voice.state.runtime = "working";
  Voice.notify();

  // Free-only gate first: unknown or paid selections need configuration.
  try {
    await Bridge.voiceProviderCheck();
  } catch (err) {
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
    return;
  }

  // Deterministic local tools first; unknown routes to the agent.
  try {
    const route = await Bridge.voiceToolResolve(clean);
    if (route && route.kind === "media" && route.action) {
      await Bridge.mediaControl(route.action as "toggle" | "next" | "previous");
      Voice.state.receipt = { target: "Music", status: "ok", message: `Music ${route.action}.` };
      Voice.state.runtime = "speaking";
      Voice.notify();
      await Bridge.voiceSpeak(`Music ${route.action}.`, generation);
      return;
    }
    if (route && (route.kind === "app" || route.kind === "folder") && route.target) {
      try {
        if (route.kind === "app") await Bridge.toolsLaunchApp(route.target);
        else await Bridge.toolsOpenFolder(route.target);
        Voice.state.receipt = { target: route.target, status: "ok", message: "Opened." };
        Voice.state.runtime = "speaking";
        Voice.notify();
        await Bridge.voiceSpeak("Opened.", generation);
      } catch (err) {
        Voice.state.receipt = {
          target: route.target,
          status: "failed",
          message: String(err).replace(/^Error:\s*/, ""),
        };
        Voice.state.runtime = "standby";
        Voice.notify();
      }
      return;
    }
    if (route && route.kind === "routine" && route.routineId) {
      // Routines show the ordered preview and require an explicit Run click.
      Voice.state.routinePreview = { routineId: route.routineId, name: route.reason ?? route.routineId };
      Voice.state.runtime = "standby";
      Voice.notify();
      heightTick?.();
      return;
    }
    if (route && route.kind === "ambiguous") {
      Voice.state.error = (route.reason ?? "Pick one.") + " " + route.candidates.join(", ");
      Voice.state.runtime = "standby";
      Voice.notify();
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

  // Agent path reuses the shared chat submission and history.
  const context = voiceChatContext();
  const query = memoryPrefix() + clean;
  State.chatHistory.push({ id: Date.now(), role: "user", content: clean });
  State.stateOverride = "thinking";
  State.notify();
  try {
    const reply = await Bridge.chatSend(query, context);
    if (Voice.state.generation !== generation) return;
    State.chatHistory.push({ id: Date.now() + 1, role: "assistant", content: reply.text });
    State.stateOverride = null;
    Voice.state.runtime = "speaking";
    Voice.notify();
    await Bridge.voiceSpeak(speakPreview(reply.text), generation);
    // Bounded follow-up window: continue without repeating the name.
    clearFollowup();
    followupTimer = window.setTimeout(() => {
      followupTimer = null;
      if (Voice.state.runtime === "speaking" || Voice.state.runtime === "working") return;
      Voice.state.runtime = "standby";
      Voice.notify();
    }, State.settings.voiceFollowupMs);
  } catch (err) {
    if (Voice.state.generation !== generation) return;
    State.stateOverride = null;
    // Captions survive errors: stable lines stay, error shows below.
    Voice.state.runtime = "error";
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  } finally {
    State.notify();
    heightTick?.();
  }
}

function scheduleSubmit(text: string, generation: number): void {
  clearEndpoint();
  const delay = clampEndpointMs(State.settings.voiceEndpointMs);
  endpointTimer = window.setTimeout(() => {
    endpointTimer = null;
    void submitVoiceFinal(text, generation);
  }, delay);
}

/** Production voice events from the helper. No synthesized wake events here. */
export function handleVoiceEvent(evt: { name: string; payload: unknown }): void {
  if (evt.name !== "voice-event") return;
  const payload = evt.payload as { kind: string; text?: string; generation?: number; message?: string };
  const kind = payload.kind;
  const generation = payload.generation ?? Voice.state.generation;
  switch (kind) {
    case "partial":
      if (payload.text) Voice.applyPartial(payload.text, generation);
      break;
    case "final":
      if (payload.text) {
        const clean = Voice.applyFinal(payload.text, generation);
        // Endpointed utterance waits for silence, then submits exactly once.
        if (clean) scheduleSubmit(clean, generation);
        heightTick?.();
      }
      break;
    case "wake":
      if (Voice.state.muted || !State.settings.voiceWakeEnabled || !State.settings.voiceEnabled) break;
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
      if (Voice.state.runtime === "speaking") Voice.state.runtime = "standby";
      Voice.notify();
      break;
    case "cancelled":
      Voice.cancelTurn(generation);
      break;
    case "error": {
      Voice.state.runtime = "error";
      // Captions preserve text after errors: keep stable and partial.
      Voice.state.error = payload.message ?? payload.text ?? "Voice error.";
      Voice.notify();
      // Bounded recovery: one retry when the device may have returned.
      window.setTimeout(() => {
        if (Voice.state.runtime === "error" && State.settings.voiceEnabled && !Voice.state.muted) {
          Voice.state.runtime = "standby";
          Voice.notify();
        }
      }, 2000);
      break;
    }
    default:
      break;
  }
  heightTick?.();
}

// ── Deck view ─────────────────────────────────────────────────────────────

export function buildVoiceView(onHeightChange: () => void): ViewHost {
  const partial = h("div", { class: "voice-partial" });
  const stable = h("div", { class: "voice-stable" });
  const error = h("div", { class: "voice-error" });
  const receipt = h("div", { class: "voice-receipt" });
  const edit = h("input", {
    type: "text", class: "voice-edit", placeholder: "Edit before sending…", spellcheck: "false",
  }) as HTMLInputElement;
  const modeRow = h("div", { class: "voice-modes" });
  const ctxRow = h("div", { class: "voice-context" });

  const micBtn = h("button", { class: "voice-mic", title: "Talk (Ctrl+Shift+V)" }, svg(ICONS.bubble, 13));
  micBtn.addEventListener("click", () => {
    if (Voice.state.runtime === "listening") void stopVoice();
    else void startVoice();
  });
  const stopBtn = h("button", { class: "voice-stop", title: "Stop (Esc)" }, svg(ICONS.plus, 11));
  stopBtn.addEventListener("click", () => void cancelVoice());
  const sendBtn = h("button", { class: "voice-send", title: "Send" }, svg(ICONS.arrowUp, 11));
  sendBtn.addEventListener("click", () => {
    const text = (edit.value || Voice.state.partial).trim();
    edit.value = "";
    if (text) void submitVoiceFinal(text, Voice.state.generation);
  });
  edit.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      const text = (edit.value || Voice.state.partial).trim();
      edit.value = "";
      if (text) void submitVoiceFinal(text, Voice.state.generation);
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
        void Bridge.saveSettings(State.settings);
        Voice.notify();
        onHeightChange();
      },
    });
    btn.dataset.mode = m;
    modeRow.append(btn);
  }

  const body = h("div", { class: "voice-body" }, stable, partial, error, receipt, ctxRow, edit);
  const controls = h("div", { class: "voice-controls" }, micBtn, stopBtn, sendBtn, modeRow);
  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash voice-card" }, h("div", { class: "voice-main" }, body, controls)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(34,211,238,0.30)");

  Voice.subscribe(() => sync());
  State.subscribe(() => sync());

  function sync(): void {
    const mode = Voice.deckMode();
    el.dataset.deck = mode;
    // A: single provisional line and compact result. B: stable lines plus
    // current partial. C: targets, receipts and approvals.
    const showStable = mode !== "a" || Voice.state.stable.length > 0;
    clear(stable);
    if (showStable) {
      for (const line of Voice.state.stable.slice(-3)) {
        stable.append(h("div", { class: "voice-line", text: line.text }));
      }
    }
    partial.textContent = Voice.state.partial;
    partial.style.display = Voice.state.partial ? "" : "none";
    error.textContent = Voice.state.error ?? "";
    error.style.display = Voice.state.error ? "" : "none";
    clear(receipt);
    if (mode === "c") {
      if (Voice.state.receipt) {
        receipt.append(h("div", {
          class: "voice-receipt-line",
          text: `${Voice.state.receipt.target}: ${Voice.state.receipt.message}`,
        }));
      }
      if (Voice.state.routinePreview) {
        const run = h("button", {
          class: "btn primary",
          text: `Run ${Voice.state.routinePreview.routineId}`,
          onclick: () => void runRoutinePreview(),
        });
        receipt.append(h("div", { class: "voice-routine" }, run));
      }
      if (Voice.state.approvalNote) {
        receipt.append(h("div", { class: "voice-approval", text: Voice.state.approvalNote }));
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
    micBtn.classList.toggle("on", Voice.state.runtime === "listening");
    micBtn.title = Voice.state.runtime === "listening" ? "Stop listening" : "Talk (Ctrl+Shift+V)";
    stopBtn.style.display = Voice.state.runtime === "speaking" || Voice.state.runtime === "working" ? "" : "none";
    for (const btn of modeRow.querySelectorAll("button")) {
      (btn as HTMLElement).classList.toggle("on", (btn as HTMLElement).dataset.mode === Voice.state.deckPin);
    }
  }

  async function runRoutinePreview(): Promise<void> {
    const preview = Voice.state.routinePreview;
    if (!preview) return;
    Voice.state.routinePreview = null;
    Voice.notify();
  }

  sync();
  return { el, sync, focus() { edit.focus(); } };
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
    const cap = await Bridge.voiceCapability();
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
    await Bridge.voiceSpeak("Choom voice check.", Voice.state.generation);
  });

  const memInput = h("input", {
    type: "text", placeholder: "Add a fact to remember…", style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const memList = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  async function refreshMemories(): Promise<void> {
    clear(memList);
    const list = (await Bridge.voiceMemoryList()) ?? [];
    Voice.state.memories = list.map((m) => ({ id: m.id, text: m.text, createdMs: m.createdMs, source: m.source }));
    for (const m of Voice.state.memories) {
      const del = h("button", { text: "Forget" });
      del.addEventListener("click", async () => {
        await Bridge.voiceMemoryRemove(m.id);
        await refreshMemories();
      });
      memList.append(h("div", { class: "row" }, h("span", { class: "hint", text: m.text }), del));
    }
    Voice.notify();
  }
  const memAdd = h("button", { text: "Remember" });
  memAdd.addEventListener("click", async () => {
    const value = memInput.value.trim();
    if (!value) return;
    try {
      await Bridge.voiceMemoryAdd(value);
      memInput.value = "";
      await refreshMemories();
    } catch (err) {
      status.textContent = String(err).replace(/^Error:\s*/, "");
    }
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
        await Bridge.voiceWakeSet(v);
      } catch (err) {
        status.textContent = String(err).replace(/^Error:\s*/, "");
      }
      void opts.save();
    })),
    h("div", { class: "row" }, h("label", { text: "Endpoint delay" }), endpoint, endpointLabel),
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
  );
  void refreshCapability();
  if (s().voiceMemoryEnabled) void refreshMemories();
  return section;
}

/** Snapshot the foreground window for selected context. Call before opening Choom. */
export async function snapshotWindowContext(): Promise<void> {
  try {
    const snap = await Bridge.voiceWindowSnapshot();
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
    Voice.notify();
  } catch (err) {
    Voice.state.error = String(err).replace(/^Error:\s*/, "");
    Voice.notify();
  }
}

export function isValidDeckPin(value: string): value is VoiceDeckMode {
  return validDeckMode(value);
}
