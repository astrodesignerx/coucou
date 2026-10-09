// Voice deck fixture: the real production buildVoiceView, production
// choom.css and the code-drawn BotEngine, driven by isolated mock Bridge
// adapters. Deterministic preview only; nothing here reaches production.
// Served by `npm run dev` at /dev/voice-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import { BotEngine } from "../src/mochi/engine";
import { State } from "../src/core/state";
import { Voice } from "../src/choom/voice";
import {
  buildVoiceView, cancelVoice, handleVoiceEvent, manualVoiceSubmit, setVoiceDeps,
  startVoice, registerVoiceIsland, type VoiceDeps,
} from "../src/choom/voiceSection";

const log = document.getElementById("log")!;
function say(line: string) {
  log.textContent += line + "\n";
}

// ── Deterministic mock adapters ─────────────────────────────────────────────

let generation = 0;
const calls: string[] = [];
let mockRoute: { kind: string; action?: string; target?: string; routineId?: string; options?: { id: string; name: string; kind: string; target: string }[]; reason?: string } = { kind: "agent" };
let mockChatReply = "Preview reply: finished.";
let mockChatError: string | null = null;
const memories: { id: string; text: string; createdMs: number; source: string }[] = [
  { id: "mem-1", text: "Preview fact: likes tea", createdMs: Date.now(), source: "user" },
];

const mock: VoiceDeps = {
  voiceCapability: () => Promise.resolve({ supported: true, recognizers: ["en-US MS-1033-80-DESK"], voices: ["David"], error: null }),
  openSettings: () => { calls.push("openSettings"); return Promise.resolve(); },
  voiceListenStart: (muted) => { calls.push(`listenStart muted=${muted}`); generation += 1; return Promise.resolve(generation); },
  voiceListenStop: () => { calls.push("listenStop"); return Promise.resolve(); },
  voiceCancel: () => { calls.push("cancel"); generation += 1; return Promise.resolve(generation); },
  voiceSpeak: (text, gen) => { calls.push(`speak gen=${gen} chars=${text.length}`); return Promise.resolve(); },
  voiceSpeakStop: () => { calls.push("speakStop"); return Promise.resolve(); },
  voiceWakeSet: (on) => { calls.push(`wakeSet ${on}`); return Promise.resolve(); },
  voiceMute: (muted) => { calls.push(`mute ${muted}`); return Promise.resolve(); },
  voiceDeviceRecover: () => { calls.push("deviceRecover"); return Promise.resolve(); },
  voiceToolRun: (kind, target, gen) => { calls.push(`toolRun ${kind} ${target} gen=${gen}`); return Promise.resolve(target); },
  voiceWindowSnapshot: () => Promise.resolve({ appName: "Preview Notes", title: "Q3 plan" }),
  voiceToolResolve: (utterance) => {
    calls.push(`resolve ${utterance}`);
    return Promise.resolve({
      kind: mockRoute.kind, target: mockRoute.target ?? null, action: mockRoute.action ?? null,
      routineId: mockRoute.routineId ?? null, candidates: (mockRoute.options ?? []).map((o) => o.name),
      options: mockRoute.options ?? [], reason: mockRoute.reason ?? null,
    });
  },
  voiceProviderCheck: () => Promise.resolve(),
  voiceMemoryList: () => Promise.resolve(memories.map((m) => ({ ...m }))),
  voiceMemoryAdd: (text) => {
    const entry = { id: `mem-${memories.length + 1}`, text, createdMs: Date.now(), source: "user" };
    memories.push(entry);
    return Promise.resolve({ ...entry });
  },
  voiceMemoryUpdate: (id, text) => {
    const found = memories.find((m) => m.id === id);
    if (!found) return Promise.reject(new Error("That memory was not found."));
    found.text = text;
    return Promise.resolve({ ...found });
  },
  voiceMemoryRemove: (id) => {
    const at = memories.findIndex((m) => m.id === id);
    if (at >= 0) memories.splice(at, 1);
    return Promise.resolve();
  },
  voiceMemoryClear: () => { memories.length = 0; return Promise.resolve(); },
  toolsPickDocument: () => Promise.resolve("C:\\preview\\notes.txt"),
  toolsRoutineStart: (routineId, steps) => {
    calls.push(`routineStart ${routineId} steps=${steps.length}`);
    return Promise.resolve(steps.map((s) => ({ id: s.id, status: "ok", message: "Opened." })));
  },
  mediaControl: (action) => { calls.push(`media ${action}`); return Promise.resolve(); },
  saveSettings: () => Promise.resolve(),
  chatTurn: (query) => {
    calls.push(`chatTurn chars=${query.length}`);
    if (mockChatError) return Promise.resolve({ error: mockChatError });
    return Promise.resolve({ text: mockChatReply });
  },
};

setVoiceDeps(mock);

// ── Stage: real mascot plus the real production card ────────────────────────

State.settings.voiceEnabled = true;
State.settings.voiceWakeEnabled = true;
State.settings.voiceAutoSubmit = true;
State.settings.voiceEndpointMs = 250;
State.settings.voiceFollowupMs = 1200;
State.settings.voiceMemoryEnabled = true;
State.settings.tools = {
  version: 1,
  colours: [],
  shortcuts: [
    { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
    { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
  ],
  routines: [{ id: "design", name: "Design mode", steps: ["notes", "code"] }],
};
Voice.state.deckPin = "auto";
Voice.state.memoryEnabled = true;

const engine = new BotEngine();
const canvas = document.getElementById("mascot") as HTMLCanvasElement;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function drawMascot() {
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
  const frame = (now: number) => {
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
document.getElementById("deck")!.append(host.el);

// ── Exercise buttons: every production path, all preview ───────────────────

const panel = document.getElementById("panel")!;
function button(label: string, fn: () => void) {
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

function emit(kind: string, text?: string, gen?: number, message?: string) {
  handleVoiceEvent({ name: "voice-event", payload: { kind, text, generation: gen ?? Voice.state.generation, message } });
  host.sync();
}

button("mic start", () => void startVoice());
button("partial: hello", () => emit("partial", "hello there"));
button("final: segment one", () => emit("final", "open my notes"));
button("final: segment two", () => emit("final", "and file the report"));
button("manual send", () => void manualVoiceSubmit(""));
button("speech ended (follow-up)", () => emit("speech_ended"));
button("pin A", () => { Voice.state.deckPin = "a"; Voice.notify(); });
button("pin B", () => { Voice.state.deckPin = "b"; Voice.notify(); });
button("pin C", () => { Voice.state.deckPin = "c"; Voice.notify(); });
button("pin Auto", () => { Voice.state.deckPin = "auto"; Voice.notify(); });
button("route: agent", () => { mockRoute = { kind: "agent" }; });
button("route: media pause", () => { mockRoute = { kind: "media", action: "pause" }; });
button("route: app", () => { mockRoute = { kind: "app", target: "C:\\preview\\code.exe" }; });
button("route: ambiguous", () => {
  mockRoute = {
    kind: "ambiguous", reason: "More than one saved shortcut matches. Pick one.",
    options: [
      { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
      { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
    ],
  };
});
button("route: routine", () => { mockRoute = { kind: "routine", routineId: "design", reason: "Review the steps and press Run." }; });
button("route: refused", () => { mockRoute = { kind: "refused", reason: "That needs an explicit click." }; });
button("device error", () => emit("error", undefined, undefined, "Microphone unavailable: preview device lost."));
button("plain error", () => emit("error", undefined, undefined, "Preview recognition failed."));
button("recovered", () => emit("recovered"));
button("helper exited", () => emit("helper_exited"));
button("cancel turn", () => void cancelVoice());
button("select memory", () => {
  Voice.state.memories = memories.map((m) => ({ ...m }));
  Voice.state.selectedMemoryIds = ["mem-1"];
  Voice.state.deckPin = "c";
  Voice.notify();
});
button("8 finals (pages)", () => {
  for (let i = 1; i <= 8; i++) emit("final", `preview line ${i}`);
  Voice.state.deckPin = "b";
  Voice.notify();
});
button("dump calls", () => say(calls.join("\n") || "(no calls)"));

say("Fixture ready. Buttons drive the production card through mock adapters.");
