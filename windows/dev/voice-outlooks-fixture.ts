// Voice outlooks fixture: the real production buildHeader and
// buildVoiceView, production style.css and choom.css, and the code drawn
// BotEngine, driven by isolated mock adapters. Deterministic preview only;
// nothing here reaches production. Synthetic preview data only, no native
// actions and no private data.
// Served by dev server at /dev/voice-outlooks-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import { BotEngine } from "../src/mochi/engine";
import { State } from "../src/core/state";
import type { IslandViewName } from "../src/core/layout";
import { Voice } from "../src/choom/voice";
import {
  buildVoiceView, cancelVoice, handleVoiceEvent, manualVoiceSubmit,
  setVoiceDeps, startVoice, registerVoiceIsland, setLastJevReceipt, toggleMute,
  type VoiceDeps,
} from "../src/choom/voiceSection";
import { buildHeader as buildRealHeader, type ViewActions, type ViewHost } from "../src/views/views";

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
  saveSettings: (settings) => {
    calls.push(`saveSettings view=${settings.voiceMode}`);
    return Promise.resolve();
  },
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
State.view = "voice";

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

// Synthetic island: production header plus production voice card.
const island = document.getElementById("island") as HTMLElement;
const headerSlot = document.getElementById("header-slot") as HTMLElement;
const viewsEl = document.getElementById("views") as HTMLElement;

const mockActions: ViewActions = {
  setView: (v: IslandViewName) => {
    calls.push(`setView ${v}`);
    State.view = v;
    headerHost?.sync();
    voiceHost?.sync();
  },
  collapse: () => { calls.push("collapse"); say("collapse (preview only)"); },
  setFocus: (id: string) => { calls.push(`setFocus ${id}`); },
  openTerminal: () => { calls.push("openTerminal"); },
  openTarget: () => { calls.push("openTarget"); },
  openUrl: (url: string) => { calls.push(`openUrl ${url}`); },
  decide: (d) => { calls.push(`decide ${d}`); say(`decision ${d} (preview only, nothing executed)`); },
  toggleSound: () => { calls.push("toggleSound"); },
  setVolume: (v: number) => { calls.push(`setVolume ${v}`); },
  setAutoClose: (s: number) => { calls.push(`setAutoClose ${s}`); },
  openSettingsWindow: () => { calls.push("openSettingsWindow"); say("settings open (preview only)"); },
  blip: () => { calls.push("blip"); },
};

let headerHost: ViewHost | null = null;
let voiceHost: ViewHost | null = null;

function mountAll(): void {
  disposeAll();
  headerHost = buildRealHeader(mockActions);
  voiceHost = buildVoiceView(() => voiceHost?.sync());
  headerSlot.append(headerHost.el);
  viewsEl.append(voiceHost.el);
  State.mode = "expanded";
  State.view = "voice";
  voiceHost.el.classList.add("on");
  headerHost.sync();
  voiceHost.sync();
}

function disposeAll(): void {
  voiceHost?.dispose?.();
  voiceHost?.el.remove();
  voiceHost = null;
  headerHost?.dispose?.();
  headerHost?.el.remove();
  headerHost = null;
}

mountAll();
registerVoiceIsland(
  () => {
    State.mode = "expanded";
    State.view = "voice";
    voiceHost?.el.classList.add("on");
    voiceHost?.sync();
    say("island opened");
  },
  () => voiceHost?.sync(),
);

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
    headerHost?.sync();
    voiceHost?.sync();
  });
  panel.append(btn);
}

function emit(kind: string, text?: string, gen?: number, message?: string): void {
  handleVoiceEvent({
    name: "voice-event",
    payload: { kind, text, generation: gen ?? Voice.state.generation, message },
  });
  voiceHost?.sync();
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

function setPin(m: "auto" | "a" | "b" | "c"): void {
  // Same path as the Voice settings view selector: pin plus saved setting.
  Voice.state.deckPin = m;
  State.settings.voiceMode = m;
  void mock.saveSettings(State.settings);
  Voice.notify();
  say(`view pin ${m} via Voice settings path`);
}

button("idle", () => {
  resetDeck();
  setPin("auto");
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
button("long error wraps", () => {
  resetDeck();
  emit("error", undefined, undefined,
    "Preview long error that must wrap across lines at 400 width instead of clipping, keeping the Recover device action visible below the text.");
});
button("long approval wraps", () => {
  resetDeck();
  Voice.state.approvalNote =
    "Preview long approval note that must wrap across lines at 400 width instead of clipping, keeping the run and dismiss actions visible below the text.";
  Voice.state.ambiguity = [
    { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
    { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
  ];
  Voice.state.error = "Preview long ambiguity explanation that must wrap instead of truncating the red line.";
  Voice.notify();
});
button("input draft", () => {
  const input = document.querySelector(".voice-input") as HTMLButtonElement | null;
  input?.click();
  const field = document.querySelector(".voice-edit") as HTMLInputElement | null;
  if (field) {
    field.value = "Preview draft keeps across Escape";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  voiceHost?.sync();
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
button("pin A", () => setPin("a"));
button("pin B", () => setPin("b"));
button("pin C", () => setPin("c"));
button("pin Auto", () => setPin("auto"));
button("8 finals (B pages)", () => {
  resetDeck();
  Voice.state.generation = 71;
  Voice.state.runtime = "listening";
  for (let i = 1; i <= 8; i += 1) emit("final", `preview line ${i}`, 71);
  setPin("b");
});
button("width 400", () => {
  island.classList.add("narrow");
  voiceHost?.sync();
});
button("width 560", () => {
  island.classList.remove("narrow");
  voiceHost?.sync();
});
button("header order check", () => {
  const header = headerSlot.querySelector("#header");
  if (!header) {
    say("header order check: FAIL (no production header mounted)");
    return;
  }
  const tabs = [...header.querySelectorAll(".tabs button")].map((b) => b.getAttribute("title") ?? "");
  const actions = [...header.querySelectorAll(".header-actions button")].map(
    (b) => b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "",
  );
  const tabsOk = tabs.join("|") === "Home|Voice|New";
  const actionsOk = (actions.length === 2 && actions[1] === "Settings"
    && (actions[0] === "Mute microphone" || actions[0] === "Unmute microphone"));
  const muteOk = (actions[0] === "Unmute microphone") === Voice.state.muted;
  say(`header order check: ${tabsOk && actionsOk && muteOk ? "PASS" : "FAIL"} tabs=[${tabs.join(", ")}] actions=[${actions.join(", ")}] muted=${Voice.state.muted}`);
});
button("header mute toggle", () => {
  void toggleMute().then(() => {
    headerHost?.sync();
    voiceHost?.sync();
  });
});
button("hide island", () => {
  State.view = "overview";
  State.mode = "hidden";
  voiceHost?.el.classList.remove("on");
  State.notify();
  Voice.notify();
  say("island hidden: rotation timers stop");
});
button("show island", () => {
  State.mode = "expanded";
  State.view = "voice";
  voiceHost?.el.classList.add("on");
  State.notify();
  Voice.notify();
  say("island shown: timers resume on visible voice");
});
button("mount", () => {
  mountAll();
  say("mounted production header and voice card");
});
button("dispose", () => {
  disposeAll();
  say("disposed header and voice card: timers and listeners released");
});
button("reduced motion sim", () => {
  island.classList.toggle("rm-sim");
  const on = island.classList.contains("rm-sim");
  say(on
    ? "reduced motion simulation on (fixture CSS only). Production follows the OS setting and uses manual cycle."
    : "reduced motion simulation off.");
  say(`OS prefers reduced motion: ${window.matchMedia("(prefers-reduced-motion: reduce)").matches}`);
});
button("cancel turn", () => void cancelVoice());
button("dump calls", () => say(calls.join("\n") || "(no calls)"));

say("Outlook fixture ready. Production header and card mounted; buttons drive them through mock adapters.");
