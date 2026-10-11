// Whisper finish/discard controller regression. Drives the ACTUAL
// voiceSection controller (real voice store, real state, real Jev policy)
// against a fake command adapter (stubbed Bridge plus UI seams) and fake
// timers. No microphone, no helper, no network.
//
// What this proves on production paths: manual mic stop finishes and does
// not re-arm wake until the authoritative terminal; close discards and
// re-arms at once; the Windows backend path is unchanged; stale terminals
// after cancel never submit; manual submit clears a pending finish.
//
// Run from windows/: node scripts/whisper-controller-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

function transpileTo(tmp, rel) {
  const source = fs.readFileSync(path.join(SRC, rel), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
}

async function main() {
  let failed = 0;
  const check = (label, value) => {
    console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
    if (!value) failed++;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-whisper-ctl-"));
  try {
    for (const rel of [
      "choom/voice.ts",
      "choom/jev.ts",
      "choom/voiceSection.ts",
      "core/state.ts",
      "core/layout.ts",
    ]) {
      transpileTo(tmp, rel);
    }
    const writeStub = (rel, content) => {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    };

    // Fake command adapter: every native call is recorded, nothing leaves
    // the process. liveDeps delegates to this Bridge object at call time.
    const calls = [];
    const behaviors = {
      toolResolve: { kind: "agent", target: null, action: null, routineId: null, candidates: [], options: [], reason: null },
    };
    let nextGen = 6;
    const bridgeFake = {
      voiceCapability: async () => ({ supported: true, recognizers: ["r"], voices: ["v"], microphone: true, error: null }),
      voiceWhisperStatus: async () => ({ binary: true, base: true, small: false, error: null }),
      voiceListenStart: async (muted) => {
        calls.push(["listenStart", muted]);
        nextGen += 1;
        return nextGen;
      },
      voiceListenStop: async () => {
        calls.push(["stop"]);
      },
      voiceWhisperFinish: async () => {
        calls.push(["finish"]);
      },
      voiceCancel: async () => {
        calls.push(["cancel"]);
        nextGen += 1;
        return nextGen;
      },
      voiceSpeak: async (text, generation) => {
        calls.push(["speak", text, generation]);
      },
      voiceSpeakStop: async () => {
        calls.push(["speakStop"]);
      },
      voiceWakeSet: async (enabled) => {
        calls.push(["wake", enabled]);
      },
      voiceMute: async (muted) => {
        calls.push(["mute", muted]);
      },
      voiceDeviceRecover: async () => {
        calls.push(["recover"]);
      },
      voiceToolRun: async () => {
        throw new Error("unexpected tool run");
      },
      voiceWindowSnapshot: async () => null,
      voiceToolResolve: async () => {
        calls.push(["toolResolve"]);
        return { ...behaviors.toolResolve };
      },
      voiceProviderCheck: async () => {
        calls.push(["providerCheck"]);
      },
      voiceMemoryList: async () => [],
      voiceMemoryAdd: async (text) => ({ id: "m1", text, createdMs: 1, source: "user" }),
      voiceMemoryUpdate: async (id, text) => ({ id, text, createdMs: 1, source: "user" }),
      voiceMemoryRemove: async () => {},
      voiceMemoryClear: async () => {},
      toolsPickDocument: async () => null,
      toolsRoutineStart: async () => [],
      mediaControl: async () => {},
      saveSettings: async () => {},
      jevDecide: async () => {
        throw new Error("jev must stay off in these scenarios");
      },
      jevStatus: async () => ({ enabled: false, mode: "shadow", configured: false, model: "", endpoint: "", threshold: 0.75, deadlineMs: 2500 }),
      jevHistory: async () => [],
      jevClearHistory: async () => {},
    };
    writeStub("core/bridge.js", `module.exports.Bridge = globalThis.__choomBridgeFake;`);
    writeStub("core/sound.js", `module.exports.Sound = { play: (name) => globalThis.__choomPlayed.push(name) };`);
    writeStub("views/dom.js", `module.exports.h = () => ({}); module.exports.svg = () => ({}); module.exports.clear = () => {};`);
    writeStub("views/icons.js", `module.exports.ICONS = {};`);
    writeStub("views/views.js", ``);
    writeStub("views/chat.js", [
      `module.exports.submitChatTurn = async (query) => { globalThis.__choomCalls.push(["chatTurn", query]); return { text: "done" }; };`,
      `module.exports.currentChatOwner = () => 1;`,
      `module.exports.cancelChatTurn = () => {};`,
    ].join("\n"));
    writeStub("choom/tools.js", [
      `module.exports.routineById = () => undefined;`,
      `module.exports.resolveRoutineSteps = () => [];`,
    ].join("\n"));

    globalThis.__choomBridgeFake = bridgeFake;
    globalThis.__choomCalls = calls;
    globalThis.__choomPlayed = [];

    // Fake timers: endpoint and finish backstop fire only when advanced.
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    globalThis.window = {
      setTimeout: (fn, ms) => {
        timerId += 1;
        timers.set(timerId, { fn, at: now + ms });
        return timerId;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
    };
    const flush = async (rounds = 30) => {
      for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
      }
    };
    const advance = (ms) => {
      const target = now + ms;
      for (;;) {
        let best = null;
        let bestAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < bestAt) {
            best = id;
            bestAt = t.at;
          }
        }
        if (best === null) break;
        now = bestAt;
        const t = timers.get(best);
        timers.delete(best);
        t.fn();
      }
      now = target;
    };

    const VS = require(path.join(tmp, "choom/voiceSection.js"));
    const V = require(path.join(tmp, "choom/voice.js"));
    const ST = require(path.join(tmp, "core/state.js"));
    const { Voice } = V;
    const { State, DEFAULT_SETTINGS } = ST;
    VS.registerVoiceIsland(() => {}, () => {});

    const kinds = (name) => calls.filter((c) => c[0] === name).length;
    const resetScenario = (backend) => {
      calls.length = 0;
      timers.clear();
      nextGen = 100 + Math.floor(Math.random() * 0);
      State.settings = {
        ...DEFAULT_SETTINGS,
        voiceEnabled: true,
        voiceWakeEnabled: true,
        voiceBackend: backend,
        voiceEndpointMs: 900,
        voiceFollowupMs: 8000,
        voiceAutoSubmit: true,
        jevEnabled: false,
      };
      State.paused = false;
      State.stateOverride = null;
      V.resetSubmissionGuard();
      Voice.state.generation = 0;
      Voice.state.runtime = "standby";
      Voice.state.partial = "";
      Voice.state.pendingSegments = [];
      Voice.state.stable = [];
      Voice.state.page = 0;
      Voice.state.error = null;
      Voice.state.deviceError = false;
      Voice.state.muted = false;
      Voice.state.wakeOn = false;
      Voice.state.receipt = null;
      Voice.state.routinePreview = null;
      Voice.state.approvalNote = null;
      Voice.state.ambiguity = [];
    };
    const gen = () => Voice.state.generation;
    const event = (kind, extra = {}) => ({ name: "voice-event", payload: { kind, generation: gen(), ...extra } });

    // A. Manual mic stop finishes and waits: no re-arm until the terminal.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    const genA = gen();
    check("A: whisper start listens", Voice.state.runtime === "listening" && kinds("listenStart") === 1);
    await VS.stopVoice();
    await flush();
    check("A: manual stop finishes instead of discarding", kinds("finish") === 1 && kinds("stop") === 0);
    check("A: wake is not re-armed at stop time", kinds("wake") === 0);
    check("A: finishing shows processing", Voice.state.runtime === "processing");
    VS.handleVoiceEvent(event("transcribing"));
    await flush();
    check("A: transcribing still waits for the terminal", kinds("wake") === 0 && kinds("toolResolve") === 0);
    VS.handleVoiceEvent({ name: "voice-event", payload: { kind: "final", text: "open spotify", generation: genA } });
    await flush();
    check("A: wake re-arms after the authoritative final", kinds("wake") === 1);
    advance(900);
    await flush();
    check("A: endpoint submits exactly once", kinds("toolResolve") === 1 && kinds("speak") === 1);
    check("A: submit discards capture natively", kinds("stop") === 1);

    // B. Closing the panel discards at once and re-arms immediately.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    await VS.closeVoicePanel();
    await flush();
    check("B: close discards instead of finishing", kinds("stop") === 1 && kinds("finish") === 0);
    check("B: close re-arms wake at once", kinds("wake") === 1);
    check("B: close returns to standby", Voice.state.runtime === "standby");

    VS.handleVoiceEvent(event("final", "late words"));
    await flush();
    check("B: late final after close never submits", kinds("toolResolve") === 0);

    // C. Windows backend semantics are unchanged.
    resetScenario("system");
    await VS.startVoice();
    await flush();
    await VS.stopVoice();
    await flush();
    check("C: system stop discards and re-arms", kinds("stop") === 1 && kinds("wake") === 1 && kinds("finish") === 0);

    // D. Stale terminal after cancel never submits and never re-arms again.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    const genD = gen();
    await VS.stopVoice();
    await flush();
    await VS.cancelVoice();
    await flush();
    const wakesAfterCancel = kinds("wake");
    VS.handleVoiceEvent({ name: "voice-event", payload: { kind: "final", text: "late words", generation: genD } });
    await flush();
    check("D: stale final after cancel never submits", kinds("toolResolve") === 0);
    check("D: stale final never re-arms again", kinds("wake") === wakesAfterCancel);

    // E. Manual submit during a pending finish takes over and clears it.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    const genE = gen();
    await VS.stopVoice();
    await flush();
    await VS.manualVoiceSubmit("hello");
    await flush();
    check("E: manual submit runs the turn", kinds("toolResolve") === 1);
    const wakesE = kinds("wake");
    VS.handleVoiceEvent({ name: "voice-event", payload: { kind: "final", text: "hello", generation: genE } });
    await flush();
    check("E: cleared finish never re-arms late", kinds("wake") === wakesE);

    // F. Silence terminal re-arms with a hint and never submits.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    await VS.stopVoice();
    await flush();
    VS.handleVoiceEvent(event("empty"));
    await flush();
    check("F: empty shows a hint and stands by", Voice.state.runtime === "standby" && Voice.state.error !== null);
    check("F: empty re-arms wake without submitting", kinds("wake") === 1 && kinds("toolResolve") === 0);

    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    VS.handleVoiceEvent(event("empty"));
    await flush();
    check("F: automatic empty re-arms wake", kinds("wake") === 1 && kinds("toolResolve") === 0);

    // G. Failure terminal stays visible with no re-arm.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    await VS.stopVoice();
    await flush();
    VS.handleVoiceEvent({ name: "voice-event", payload: { kind: "error", message: "Transcription failed.", generation: gen() } });
    await flush();
    check("G: error stays visible with no re-arm", Voice.state.runtime === "error" && kinds("wake") === 0);

    // H. A second mic press while finishing is ignored, not doubled.
    resetScenario("whisper");
    await VS.startVoice();
    await flush();
    await VS.stopVoice();
    await flush();
    await VS.stopVoice();
    await flush();
    check("H: double stop finishes once", kinds("finish") === 1);

    // A new typed turn must not keep an old task or error visible.
    resetScenario("whisper");
    Voice.state.error = "Old error";
    Voice.state.routinePreview = { routineId: "old", name: "Old routine" };
    Voice.state.approvalNote = "Old approval";
    Voice.state.ambiguity = [{ id: "old", name: "Old choice", kind: "app", target: "old.exe" }];
    await VS.manualVoiceSubmit("new request");
    await flush();
    check("I: new typed turn clears the previous task UI", Voice.state.error === null
      && Voice.state.routinePreview === null && Voice.state.approvalNote === null
      && Voice.state.ambiguity.length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete globalThis.window;
    delete globalThis.__choomBridgeFake;
    delete globalThis.__choomCalls;
    delete globalThis.__choomPlayed;
  }

  console.log(failed === 0 ? "whisper controller: all assertions passed" : `whisper controller: ${failed} FAILURES`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
