// Request routing fixture: the real production Brain routing section and the
// real production voice deck, driven by injected typed native responses.
//
// Everything here is a SIMULATION. The readiness states are typed fixture
// values pushed into the production VoiceDeps, not a measured local warm-up:
// no Python worker, no model and no network exists on this page. A Ready state
// shown here proves only that the production copy renders it; in the app,
// Ready is only ever earned by a real local warm-up inference.
//
// Served by `npm run dev` at /dev/settings-routing-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import "../src/settings/settings.css";
import "../src/settings/hub.css";

import { State } from "../src/core/state";
import type { LayaOutcome, LayaStatus } from "../src/core/bridge";
import { Voice } from "../src/choom/voice";
import {
  buildVoiceView, getLastLayaReceipt, handleVoiceEvent, jevSettingsSection,
  registerVoiceIsland, setVoiceDeps, submitVoiceFinal, switchDecisionEngine, type VoiceDeps,
} from "../src/choom/voiceSection";

const log = document.getElementById("log")!;
function say(line: string) {
  log.textContent += line + "\n";
}

// ── Typed fixture responses ────────────────────────────────────────────────
// These stand in for the native commands laya_status, laya_check and
// laya_decide. Every shape matches the real Bridge types, so a rendering
// difference here is a real rendering difference in the app.

type Readiness = "missing" | "loading" | "ready" | "error";

/** Mutable staged readiness, so a button can move the local engine between
 *  its four honest states without reloading the page. */
const staged: { readiness: Readiness } = { readiness: "loading" };
const calls: string[] = [];
let nextOutcome: LayaOutcome = {
  route: "clarify", confidence: 0.88, latencyMs: 210,
  fallbackReason: null, mode: "local", candidateId: null,
};
let nextFailure: string | null = null;
/** Parks the next classifier call so a switch can happen while it is pending. */
let parkLaya = false;
let parkJev = false;

const DETAIL: Record<Readiness, string> = {
  missing: "No Laya runtime. Set the interpreter path in Settings.",
  loading: "Laya is set up. The first request loads it on this computer.",
  ready: "Laya is loaded and warm.",
  error: "Laya did not answer in time.",
};

function fixtureStatus(state: Readiness): LayaStatus {
  return {
    enabled: state !== "missing" || true,
    state,
    // Ready is false everywhere but the ready case, exactly as the native
    // adapter reports it: existence of a file never sets this to true.
    ready: state === "ready",
    detail: DETAIL[state],
    labels: ["answer", "options", "clarify", "supported_local", "unknown"],
    runtimePath: state === "missing" ? null : "C:\\laya\\venv\\Scripts\\python.exe",
    modelPath: state === "missing" ? null : "C:\\laya\\model",
    manifestPath: state === "missing" ? null : "C:\\laya\\model-manifest.json",
    workerPath: "C:\\laya\\choom-laya.py",
    loadMs: state === "ready" ? 11400 : null,
    startupTimeoutMs: 120000,
    decisionTimeoutMs: 10000,
    idleUnloadMs: 30000,
    threshold: State.settings.layaThreshold,
    lastReason: state === "missing" ? "missing-runtime" : state === "error" ? "decision-timeout" : null,
  };
}

const mock: VoiceDeps = {
  voiceCapability: () => Promise.resolve({ supported: true, recognizers: ["en-US"], voices: ["David"], error: null }),
  voiceWhisperStatus: () => Promise.resolve({ binary: false, base: false, small: false, error: null }),
  openSettings: () => { calls.push("openSettings"); return Promise.resolve(); },
  voiceListenStart: () => { calls.push("listenStart"); return Promise.resolve(5); },
  voiceListenStop: () => { calls.push("listenStop"); return Promise.resolve(); },
  voiceWhisperFinish: () => Promise.resolve(),
  voiceCancel: () => { calls.push("voiceCancel"); return Promise.resolve(99); },
  voiceSpeak: (text) => { calls.push(`voiceSpeak ${text.length} chars`); return Promise.resolve(); },
  voiceSpeakStop: () => Promise.resolve(),
  voiceWakeSet: () => Promise.resolve(),
  voiceMute: () => Promise.resolve(),
  voiceDeviceRecover: () => Promise.resolve(),
  voiceToolRun: () => Promise.resolve("target"),
  voiceWindowSnapshot: () => Promise.resolve(null),
  voiceToolResolve: () => Promise.resolve({
    kind: "agent", target: null, action: null, routineId: null, candidates: [], options: [], reason: null,
  }),
  // Any provider check here is a finding: Local Laya must never reach it.
  voiceProviderCheck: () => {
    calls.push("VOICE_PROVIDER_CHECK (unexpected in Local mode)");
    return Promise.resolve();
  },
  voiceMemoryList: () => Promise.resolve([]),
  voiceMemoryAdd: () => Promise.reject(new Error("Not part of this fixture.")),
  voiceMemoryUpdate: () => Promise.reject(new Error("Not part of this fixture.")),
  voiceMemoryRemove: () => Promise.resolve(),
  voiceMemoryClear: () => Promise.resolve(),
  toolsPickDocument: () => Promise.resolve(null),
  toolsRoutineStart: () => Promise.resolve([]),
  mediaControl: () => { calls.push("MEDIA_CONTROL"); return Promise.resolve(); },
  saveSettings: () => { calls.push("saveSettings"); return Promise.resolve(); },
  jevDecide: () => {
    calls.push("JEV_DECIDE (only expected while Online Jev is selected)");
    if (parkJev) {
      return new Promise((resolve) => {
        pendingJevReply = () => resolve({
          route: "answer", confidence: 0.95, latencyMs: 40,
          fallbackReason: null, mode: "assisted", candidateId: null,
        });
      });
    }
    return Promise.reject(new Error("Jev must not be called in Local mode."));
  },
  jevConfigured: () => Promise.resolve(true),
  layaDecide: (request) => {
    calls.push(`layaDecide ${request.length} chars`);
    if (parkLaya) {
      return new Promise((resolve, reject) => {
        pendingLayaReply = () => (nextFailure
          ? reject(new Error(nextFailure))
          : resolve(nextOutcome));
      });
    }
    if (nextFailure) return Promise.reject(new Error(nextFailure));
    return Promise.resolve(nextOutcome);
  },
  layaStatus: () => Promise.resolve(fixtureStatus(staged.readiness)),
  layaCheck: () => {
    calls.push("layaCheck (simulated warm-up)");
    staged.readiness = "ready";
    return Promise.resolve(fixtureStatus("ready"));
  },
  layaCancel: () => { calls.push("layaCancel"); return Promise.resolve(98); },
  layaHistory: () => Promise.resolve([]),
  layaClearHistory: () => { calls.push("layaClearHistory"); return Promise.resolve(); },
  // Any agent chat here is a finding: Local Laya must never reach it.
  chatTurn: () => {
    calls.push("CHAT_TURN (unexpected in Local mode)");
    return Promise.resolve({ text: "A cloud answer that Local mode must never show." });
  },
};

setVoiceDeps(mock);

// ── Stage: real settings section plus the real voice deck ──────────────────

State.settings.decisionEngine = "laya";
State.settings.jevEnabled = true;
State.settings.jevMode = "assisted";
State.settings.layaRuntimePath = "C:\\laya\\venv\\Scripts\\python.exe";
State.settings.layaModelPath = "C:\\laya\\model";
State.settings.layaManifestPath = "C:\\laya\\model-manifest.json";
State.settings.tools = {
  version: 1,
  colours: [],
  shortcuts: [
    { id: "notes", name: "Notes", kind: "folder", target: "D:\\preview\\notes" },
    { id: "code", name: "Code", kind: "app", target: "C:\\preview\\code.exe" },
  ],
  routines: [],
};
Voice.state.deckPin = "c";
Voice.state.runtime = "standby";

const section = jevSettingsSection({
  getSettings: () => State.settings,
  save: async () => { calls.push("saveSettings"); },
});
document.getElementById("settings")!.append(section);

const voice = buildVoiceView(() => voice.sync());
voice.el.classList.add("on");
registerVoiceIsland(() => say("island opened"), () => voice.sync());
document.getElementById("voice")!.append(voice.el);

// ── Controls: every one drives the production components ──────────────────

const panel = document.getElementById("panel")!;
function button(label: string, fn: () => void | Promise<void>) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    calls.length = 0;
    void (async () => {
      try {
        await fn();
      } catch (err) {
        say(`${label} threw: ${String(err)}`);
      }
      voice.sync();
      say(`${label}: ${calls.join(", ") || "(no adapter calls)"}`);
    })();
  });
  panel.append(btn);
}

function stage(state: Readiness) {
  // The production section reads readiness on construction, so the staged
  // state is applied by rebuilding the same production component rather than
  // by patching its text.
  staged.readiness = state;
  const fresh = jevSettingsSection({
    getSettings: () => State.settings,
    save: async () => { calls.push("saveSettings"); },
  });
  document.getElementById("settings")!.replaceChildren(fresh);
}

async function speak(text: string) {
  Voice.state.generation += 1;
  const generation = Voice.state.generation;
  handleVoiceEvent({ name: "voice-event", payload: { kind: "final", text, generation } });
  await submitVoiceFinal(text, generation, { manual: true });
}

/** Stages a live capture, the way the helper would have it: a partial on the
 *  deck and the runtime listening on the current generation. */
function listenWithDraft(text: string) {
  Voice.state.partial = text;
  Voice.state.runtime = "listening";
  Voice.notify();
}

/** Switches through the real controller, so the same ownership rules the app
 *  uses are what this fixture exercises. The visible select is the real one
 *  the production section built, found by its label. */
async function switchEngine(next: "jev" | "laya") {
  await switchDecisionEngine(next);
  const select = document.querySelector<HTMLSelectElement>("#settings select");
  if (select) select.value = next;
  stage(staged.readiness);
}

/** Resolvers for the mid turn switch, set only while a turn is parked. */
let pendingLayaReply: (() => void) | null = null;
let pendingJevReply: (() => void) | null = null;

button("readiness: missing", () => { stage("missing"); });
button("readiness: loading", () => { stage("loading"); });
button("readiness: ready", () => { stage("ready"); });
button("readiness: error", () => { stage("error"); });
button("engine: Local Laya", () => switchEngine("laya"));
button("engine: Online Jev", () => switchEngine("jev"));
button("engine switch while listening", async () => {
  // A live capture is stopped on purpose, because the native generation has
  // already moved on. What the user had said stays on the deck, and the deck
  // is honest that it stopped listening rather than pretending to hear.
  const draft = "half said while the engine changed";
  listenWithDraft(draft);
  Voice.state.pendingSegments = [draft];
  Voice.state.stable = [{ id: 1, text: "an earlier line", final: true }];
  Voice.state.context = { kind: "window", label: "Preview Notes: Q3 plan" };
  calls.length = 0;
  await switchEngine(State.settings.decisionEngine === "jev" ? "laya" : "jev");
  say(`capture stop calls: ${calls.join(", ") || "(none)"}`);
  say(`runtime after the switch: ${Voice.state.runtime}`);
  say(`draft kept: ${Voice.state.partial === draft}`);
  say(`pending text kept: ${JSON.stringify(Voice.state.pendingSegments)}`);
  say(`transcript kept: ${Voice.state.stable.length} line(s)`);
  say(`context kept: ${Voice.state.context?.label ?? "none"}`);
});
button("engine switch mid turn", async () => {
  // The turn is parked in the classifier of the engine that currently owns
  // it, the engine is switched under it, and only then does the classifier
  // answer. Ending on Local, nothing cloud may follow, and the draft must
  // survive. Ending on Online Jev, the provider gate and the agent are the
  // documented behavior of that engine, so they are not findings.
  const before = Voice.state.partial;
  const from = State.settings.decisionEngine === "jev" ? "jev" : "laya";
  const to = from === "jev" ? "laya" : "jev";
  parkLaya = from === "laya";
  parkJev = from === "jev";
  const pending = speak("what is a folder");
  await new Promise((r) => window.setTimeout(r, 0));
  await switchEngine(to);
  pendingLayaReply?.();
  pendingJevReply?.();
  await pending;
  parkLaya = false;
  parkJev = false;
  const cloud = calls.filter((c) => c.startsWith("CHAT_TURN") || c.startsWith("VOICE_PROVIDER_CHECK"));
  say(`switched ${from} to ${to}: ${calls.join(", ") || "(no adapter calls)"}`);
  say(to === "laya"
    ? `cloud calls after the switch: ${cloud.length === 0 ? "none" : cloud.join(", ")}`
    : `cloud calls: ${cloud.length === 0 ? "none" : cloud.join(", ")} (expected while Online Jev is selected)`);
  say(`draft preserved: ${Voice.state.partial === before}`);
});
button("outcome: clarify", () => { nextOutcome = { ...nextOutcome, route: "clarify", confidence: 0.88, fallbackReason: null }; });
button("outcome: low confidence", () => { nextOutcome = { ...nextOutcome, route: "options", confidence: 0.31, fallbackReason: "low-confidence" }; });
button("outcome: answer", () => { nextOutcome = { ...nextOutcome, route: "answer", confidence: 0.97, fallbackReason: null }; });
button("outcome: supported_local", () => { nextOutcome = { ...nextOutcome, route: "supported_local", confidence: 0.91, fallbackReason: null }; });
button("outcome: missing runtime", () => { nextFailure = "No Laya runtime. Set the interpreter path in Settings."; });
button("outcome: clear failure", () => { nextFailure = null; });
button("reduced motion: on", () => { document.documentElement.classList.add("fixture-reduced"); });
button("reduced motion: off", () => { document.documentElement.classList.remove("fixture-reduced"); });
button("say: open my notes", () => speak("open my notes"));
button("say: what is a folder", () => speak("what is a folder"));
button("cancel turn", () => { Voice.state.generation += 1; Voice.cancelTurn(Voice.state.generation); });
button("show local receipt", () => {
  // The bounded local receipt: route, probability, latency and reason only.
  // The utterance the user spoke is never part of it.
  say(`local receipt: ${JSON.stringify(getLastLayaReceipt())}`);
});

say("Fixture ready. SIMULATION ONLY: readiness states and local outcomes are typed fixture responses, not a real local runtime.");