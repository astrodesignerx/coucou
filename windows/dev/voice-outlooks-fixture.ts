// Voice outlooks fixture: the real production buildVoiceView, production
// choom.css and the code drawn BotEngine, driven by isolated mock adapters.
// Deterministic preview only; nothing here reaches production. Synthetic
// preview data only, no native actions and no private data.
// Served by dev server at /dev/voice-outlooks-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import { BotEngine } from "../src/mochi/engine";
import { State } from "../src/core/state";
import { Voice } from "../src/choom/voice";
import {
  buildVoiceView, cancelVoice, handleVoiceEvent, manualVoiceSubmit,
  setVoiceDeps, startVoice, registerVoiceIsland, setLastJevReceipt,
  type VoiceDeps,
} from "../src/choom/voiceSection";

const log = document.getElementById("log") as HTMLElement;
function say(line: string): void {
  log.textContent += line + "\n";
}

let generation = 0;
const calls: string[] = [];
let mockRoute: {
  kind: string; action?: string; target?: string; routineId?: string;
  options?: { id: string; name: string; kind: string; target: string }[];
  reason?: string;
} = { kind: "agent" };
let mockChatReply = "Preview reply: finished.";
let mockChatError: string | null = null;

const mock: VoiceDeps = {
  voiceCapability: () => Promise.resolve({
    supported: true, recognizers: ["preview-recognizer"], voices: ["Preview Voice"], error: null,
  }),
  voiceWhisperStatus: () => Promise.resolve({ binary: true, base: true, small: false, error: null }),
  openSettings: () => { calls.push("openSettings"); return Promise.resolve(); },
  voiceListenStart: (muted) => {
    calls.push(`listenStart muted=${muted}`);
    generation += 1;
    return Promise.resolve(generation);
  },
  voiceListenStop: () => { calls.push("listenStop"); return Promise.resolve(); },
  voiceWhisperFinish: () => { calls.push("whisperFinish"); return Promise.resolve(); },
  voiceCancel: () => { calls.push("cancel"); generation += 1; return Promise.resolve(generation); },
  voiceSpeak: (text, gen) => {
    calls.push(`speak gen=${gen} chars=${text.length}`);
    return Promise.resolve();
  },
  voiceSpeakStop: () => { calls.push("speakStop"); return Promise.resolve(); },
  voiceWakeSet: (on) => { calls.push(`wakeSet ${on}`); return Promise.resolve(); },
  voiceMute: (muted) => { calls.push(`mute ${muted}`); return Promise.resolve(); },
  voiceDeviceRecover: () => { calls.push("deviceRecover"); return Promise.resolve(); },
  voiceToolRun: (kind, target, gen) => {
    calls.push(`toolRun ${kind} ${target} gen=${gen}`);
    return Promise.resolve(target);
  },
  voiceWindowSnapshot: () => Promise.resolve({ appName: "Preview Notes", title: "Q3 plan" }),
  voiceToolResolve: (utterance) => {
    calls.push(`resolve ${utterance}`);
    return Promise.resolve({
      kind: mockRoute.kind,
      target: mockRoute.target ?? null,
      action: mockRoute.action ?? null,
      routineId: mockRoute.routineId ?? null,
      candidates: (mockRoute.options ?? []).map((o) => o.name),
      options: mockRoute.options ?? [],
      reason: mockRoute.reason ?? null,
    });
  },
  voiceProviderCheck: () => Promise.resolve(),
  voiceMemoryList: () => Promise.resolve([]),
  voiceMemoryAdd: (text) => Promise.resolve({ id: "mem-preview", text, createdMs: 1, source: "user" }),
  voiceMemoryUpdate: (id, text) => Promise.resolve({ id, text, createdMs: 1, source: "user" }),
  voiceMemoryRemove: () => Promise.resolve(),
  voiceMemoryClear: () => Promise.resolve(),
  toolsPickDocument: () => Promise.resolve("C:\\preview\\notes.txt"),
  toolsRoutineStart: (routineId, steps) => {
    calls.push(`routineStart ${routineId} steps=${steps.length}`);
    return Promise.resolve(steps.map((s) => ({ id: s.id, status: "ok", message: "Opened." })));
  },
  mediaControl: (action) => { calls.push(`media ${action}`); return Promise.resolve(); },
  saveSettings: () => Promise.resolve(),
  jevDecide: () => Promise.resolve({
    route: "unknown", confidence: 0, latencyMs: 1, fallbackReason: "preview", mode: "off", candidateId: null,
  }),
  jevConfigured: () => Promise.resolve(false),
  chatTurn: (query) => {
    calls.push(`chatTurn chars=${query.length}`);
    if (mockChatError) return Promise.resolve({ error: mockChatError });
    return Promise.resolve({ text: mockChatReply });
  },
};

setVoiceDeps(mock);

State.settings.voiceEnabled = true;
State.settings.voiceWakeEnabled = true;
State.settings.voiceAutoSubmit = true;
State.settings.voiceEndpointMs = 250;
State.settings.voiceFollowupMs = 1200;
State.settings.voiceMemoryEnabled = false;
State.settings.tools = {
  version: 1,
  colours: [],
  shortcuts: [
    { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
    { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
  ],
  routines: [{ id: "design", name: "Design workspace", steps: ["notes", "code"] }],
};
Voice.state.deckPin = "auto";
State.settings.voiceMode = "auto";

const engine = new BotEngine();
const canvas = document.getElementById("mascot") as HTMLCanvasElement;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function drawMascot(): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  engine.setState("idle");
  if (reduced) {
    engine.update(0.016);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    engine.draw(ctx, canvas.width, canvas.height);
    return;
  }
  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    engine.update(dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    engine.draw(ctx, canvas.width, canvas.height);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
drawMascot();

const host = buildVoiceView(() => host.sync());
host.el.classList.add("on");
registerVoiceIsland(() => say("island opened"), () => host.sync());
(document.getElementById("deck") as HTMLElement).append(host.el);

const panel = document.getElementById("panel") as HTMLElement;
function button(label: string, fn: () => void): void {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    try {
      fn();
    } catch (err) {
      say(`button ${label} threw: ${String(err)}`);
    }
    host.sync();
  });
  panel.append(btn);
}

function emit(kind: string, text?: string, gen?: number, message?: string): void {
  handleVoiceEvent({
    name: "voice-event",
    payload: { kind, text, generation: gen ?? Voice.state.generation, message },
  });
  host.sync();
}

function resetDeck(): void {
  Voice.state.runtime = "standby";
  Voice.state.generation = 0;
  Voice.state.partial = "";
  Voice.state.stable = [];
  Voice.state.pendingSegments = [];
  Voice.state.page = 0;
  Voice.state.error = null;
  Voice.state.deviceError = false;
  Voice.state.receipt = null;
  Voice.state.routinePreview = null;
  Voice.state.approvalNote = null;
  Voice.state.ambiguity = [];
  Voice.state.context = null;
  setLastJevReceipt(null);
  Voice.notify();
}

button("idle", () => {
  resetDeck();
  Voice.state.deckPin = "auto";
  Voice.notify();
});
button("listening + partial", () => {
  resetDeck();
  void startVoice();
  emit("partial", "open my design workspace");
});
button("working (agent)", () => {
  resetDeck();
  mockRoute = { kind: "agent" };
  mockChatReply = "Preview reply: workspace ready.";
  mockChatError = null;
  Voice.state.generation = 21;
  Voice.state.runtime = "listening";
  emit("final", "open my design workspace", 21);
  void manualVoiceSubmit("");
});
button("choice (2 options)", () => {
  resetDeck();
  mockRoute = {
    kind: "ambiguous",
    reason: "More than one saved shortcut matches. Pick one.",
    options: [
      { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
      { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
    ],
  };
  Voice.state.generation = 31;
  Voice.state.runtime = "listening";
  emit("final", "open notes", 31);
  void manualVoiceSubmit("");
});
button("approval (needs click)", () => {
  resetDeck();
  mockRoute = { kind: "refused", reason: "That needs an explicit click." };
  Voice.state.generation = 41;
  Voice.state.runtime = "listening";
  emit("final", "run the weekly deploy", 41);
  void manualVoiceSubmit("");
});
button("routine preview", () => {
  resetDeck();
  mockRoute = { kind: "routine", routineId: "design", reason: "Design workspace" };
  Voice.state.generation = 51;
  Voice.state.runtime = "listening";
  emit("final", "set up my design workspace", 51);
  void manualVoiceSubmit("");
});
button("receipt (agent ok)", () => {
  resetDeck();
  Voice.state.receipt = { target: "Agent", status: "ok", message: "Preview workspace is ready." };
  Voice.state.stable = [{ id: 900, text: "open my design workspace", final: true }];
  Voice.notify();
});
button("error (plain)", () => {
  resetDeck();
  emit("error", undefined, undefined, "Preview recognition failed. Try again.");
});
button("error (device)", () => {
  resetDeck();
  emit("error", undefined, undefined, "Microphone unavailable: preview device lost.");
});
button("input draft", () => {
  const input = document.querySelector(".voice-input") as HTMLButtonElement | null;
  input?.click();
  const field = document.querySelector(".voice-edit") as HTMLInputElement | null;
  if (field) {
    field.value = "Preview draft keeps across Escape";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  host.sync();
});
button("mode: manual", () => {
  State.settings.voiceAutoSubmit = false;
  Voice.notify();
  say("manual confirm first: finals wait for Enter");
});
button("mode: auto", () => {
  State.settings.voiceAutoSubmit = true;
  Voice.notify();
  say("auto: finals submit after a pause");
});
button("confirm first submit", () => {
  State.settings.voiceAutoSubmit = false;
  resetDeck();
  mockRoute = { kind: "agent" };
  Voice.state.generation = 61;
  Voice.state.runtime = "listening";
  emit("final", "preview confirm first line", 61);
  void manualVoiceSubmit("");
});
button("pin A", () => { Voice.state.deckPin = "a"; Voice.notify(); });
button("pin B", () => { Voice.state.deckPin = "b"; Voice.notify(); });
button("pin C", () => { Voice.state.deckPin = "c"; Voice.notify(); });
button("pin Auto", () => { Voice.state.deckPin = "auto"; Voice.notify(); });
button("8 finals (B pages)", () => {
  resetDeck();
  Voice.state.generation = 71;
  Voice.state.runtime = "listening";
  for (let i = 1; i <= 8; i += 1) emit("final", `preview line ${i}`, 71);
  Voice.state.deckPin = "b";
  Voice.notify();
});
button("width 400", () => {
  (document.getElementById("stage") as HTMLElement).classList.add("narrow");
  host.sync();
});
button("width 560", () => {
  (document.getElementById("stage") as HTMLElement).classList.remove("narrow");
  host.sync();
});
button("cancel turn", () => void cancelVoice());
button("dump calls", () => say(calls.join("\n") || "(no calls)"));

say("Outlook fixture ready. Buttons drive the production card through mock adapters.");
