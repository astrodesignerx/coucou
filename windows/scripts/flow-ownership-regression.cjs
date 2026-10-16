// Capture and pump ownership regression.
//
// The deck shows one runtime, but capture ownership is its own fact: the
// speech pump shows `working` while the microphone is still open, and Flow or
// the backend can be switched off mid session. This suite drives the real
// controller against mock adapters and proves that every control path retires
// the ACTUAL capture, that an old pump can never consume a newer session's
// work, and that text survives a routing retirement.
//
//   node scripts/flow-ownership-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compileTo(tmp, rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out, "utf8");
}

function stub(tmp, rel, code) {
  const dest = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-ownership-test-"));
  try {
    for (const rel of [
      "src/choom/voice.ts",
      "src/choom/jev.ts",
      "src/choom/voiceSection.ts",
      "src/core/state.ts",
      "src/core/layout.ts",
    ]) compileTo(tmp, rel);

    // Deterministic Flow stand-ins. The controller's ownership rules are what
    // is under test, not the grammar, so Flow is stubbed the same way the
    // neighbouring controller regressions stub it.
    stub(tmp, "src/choom/flowGrammar.js", "module.exports.parseFlowCommand = () => globalThis.__parseFlow || null;");
    stub(tmp, "src/choom/flowClauseTracker.js", `
      const real = globalThis.__trackerFactory;
      class T {
        constructor() { this.i = 0; this.ctx = null; this.verdicts = []; }
        begin(gen, ctx) { globalThis.__trackerGen = gen; this.ctx = ctx; this.i = 0; this.verdicts = []; }
        reset() { globalThis.__trackerGen = null; this.ctx = null; this.verdicts = []; }
        emittedSteps() { return []; }
        next(verdict) { this.verdicts.push(verdict); return this.verdicts[this.verdicts.length - 1]; }
        observePartial(s) { return this.next(globalThis.__trackerVerdict(s, false)); }
        observeFinal(s) { return this.next(globalThis.__trackerVerdict(s, true)); }
      }
      class A {
        constructor() { this.q = []; this.generation = 0; }
        get depth() { return this.q.length; }
        admit(b) { if (this.q.length >= 4) return false; this.q.push(b); return true; }
        take() { return this.q.shift() || null; }
        clear() { this.q = []; }
        setGeneration(g) { if (g !== this.generation) { this.generation = g; this.q = []; } }
      }
      module.exports.FlowClauseTracker = T;
      module.exports.FlowAdmission = A;
    `);
    stub(tmp, "src/choom/flow.js", `
      module.exports.planFromRequest = (req) => {
        if (globalThis.__planFails) return { plan: null, error: "That request cannot run." };
        return { plan: { generation: req.generation, createdAtMs: 1, steps: req.steps }, error: null };
      };
      module.exports.planSummary = () => ({ completed: 1, dispatched: 0, awaiting: 0, pending: 0, failed: 0, cancelled: 0, total: 1 });
      module.exports.formatPlanReceipt = () => "Ran 1 of 1 step(s).";
    `);
    stub(tmp, "src/choom/flowController.js", `
      let generation = 0;
      const session = { run: (...a) => globalThis.__runPlan(...a) };
      module.exports.resetSession = () => { globalThis.__sessionResets = (globalThis.__sessionResets || 0) + 1; };
      module.exports.cancelFlow = () => { generation += 1; globalThis.__cancelFlowCalls.push(generation); };
      module.exports.runPlan = (plan) => session.run(plan, { cancelled: () => false }, () => 1);
      module.exports.setVoiceGeneration = g => { globalThis.__flowGen = g; };
      module.exports.setStaleCheck = () => {};
      module.exports.savedShortcuts = () => globalThis.__shortcuts || [];
      module.exports.correctFlowTurn = () => null;
      module.exports.rememberFlowRequest = () => {};
      module.exports.flowRegistry = () => ({ has: () => true, get: () => null, list: () => [] });
      module.exports.flowCapabilityView = () => ({ supported: [], unavailable: [] });
      module.exports.runMediaFlow = async () => ({ receipt: null, error: null });
      module.exports.runRoutineFlow = async () => ({ receipt: null, error: null });
      module.exports.runLaunchFlow = async () => ({ receipt: null, error: null });
    `);
    stub(tmp, "src/core/bridge.js", "module.exports.Bridge = globalThis.__bridge;");
    stub(tmp, "src/core/sound.js", "module.exports.Sound = { play: () => {} };");
    stub(tmp, "src/views/dom.js", `
      const el = () => ({ className: "", textContent: "", style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        append(){}, appendChild(){}, remove(){}, addEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
        focus(){}, querySelector(){ return null; }, querySelectorAll(){ return []; }, set innerHTML(v){}, get innerHTML(){ return ""; },
        set textContent(v){}, get textContent(){ return ""; } });
      module.exports.h = el; module.exports.svg = () => el(); module.exports.clear = () => {};
    `);
    stub(tmp, "src/views/icons.js", "module.exports.ICONS = {};");
    stub(tmp, "src/views/views.js", "module.exports = {};");
    stub(tmp, "src/views/chat.js", `
      module.exports.submitChatTurn = async () => ({ text: "x" });
      module.exports.currentChatOwner = () => 0;
      module.exports.cancelChatTurn = () => { globalThis.__cancelChat.push(1); };
    `);
    stub(tmp, "src/choom/tools.js", "module.exports = { assistedNextStep: () => null, resolveRoutineSteps: () => [], routineById: () => null };");
    stub(tmp, "src/choom/laya.js", `
      module.exports.LAYA_CLARIFY_PROMPT = "";
      module.exports.LAYA_OFFLINE_LIMIT = "";
      module.exports.canCheckLocalEngine = () => false;
      module.exports.clampLayaThreshold = () => 0;
      module.exports.formatLayaReceipt = () => "";
      module.exports.formatLayaStatus = () => "";
      module.exports.isLocalEngine = () => true;
      module.exports.layaNextStep = () => null;
      module.exports.layaShowsClarification = () => false;
      module.exports.layaShowsOptions = () => false;
      module.exports.normalizeDecisionEngine = (v) => v || "jev";
      module.exports.outcomeToLayaReceipt = () => ({});
    `);

    require("./lib/compile-deps.cjs").compileDeps(ROOT, tmp, ["src/core/state.ts"]);

    // ── Fixture state ───────────────────────────────────────────────────────
    let generation = 100;
    const calls = [];
    let runGate = null;
    let gateRelease = null;
    let runEntered = 0;
    globalThis.__cancelFlowCalls = [];
    globalThis.__cancelChat = [];
    globalThis.__planFails = false;
    globalThis.__shortcuts = [
      { id: "code", name: "Code", kind: "app", target: "C:\\apps\\code.exe" },
      { id: "notes", name: "Notes", kind: "folder", target: "D:\\work\\notes" },
    ];
    globalThis.__runPlan = async () => {
      runEntered += 1;
      if (runGate) await runGate;
      return { generation: 0, stopped: false, finishedAtMs: 1, steps: [] };
    };
    // A verdict that dispatches two steps on every partial, so the pump is
    // always busy while the assertions run.
    globalThis.__trackerVerdict = () => ({
      kind: "dispatch",
      utterance: 1, sequence: 1, final: true,
      steps: [{ id: "c1-1", kind: "app.launch", target: "C:\\apps\\code.exe" }],
      text: "open code",
    });
    globalThis.__bridge = {
      voiceCapability: async () => ({ supported: true, recognizers: ["r"], voices: ["v"], microphone: true, error: null }),
      voiceWhisperStatus: async () => ({ binary: true, base: true, small: false, error: null }),
      voiceListenStart: async () => { calls.push("listenStart"); generation += 1; return generation; },
      voiceListenStop: async () => { calls.push("listenStop"); globalThis.__onStop?.(); },
      voiceWhisperFinish: async () => { calls.push("finish"); },
      voiceCancel: async (preserve) => { calls.push(preserve ? "cancelPreserve" : "cancel"); generation += 1; return generation; },
      voiceSpeak: async () => { calls.push("speak"); },
      voiceSpeakStop: async () => { calls.push("speakStop"); },
      voiceWakeSet: async () => { calls.push("wakeSet"); },
      voiceMute: async () => { calls.push("mute"); },
      voiceDeviceRecover: async () => { calls.push("recover"); },
      voiceToolRun: async () => null,
      voiceWindowSnapshot: async () => null,
      voiceToolResolve: async () => ({ kind: "agent", target: null, action: null, routineId: null, candidates: [], options: [], reason: null }),
      voiceProviderCheck: async () => {},
      voiceMemoryList: async () => [],
      voiceMemoryAdd: async () => ({}),
      voiceMemoryUpdate: async () => ({}),
      voiceMemoryRemove: async () => {},
      voiceMemoryClear: async () => {},
      toolsPickDocument: async () => null,
      toolsRoutineStart: async () => [],
      mediaControl: async () => {},
      saveSettings: async () => {},
      chatTurn: async () => ({ text: "x" }),
      layaStatus: async () => ({ ready: false, reason: "stub" }),
      layaCancel: async () => { calls.push("layaCancel"); return generation; },
      jevStatus: async () => ({ ready: false, reason: "stub" }),
    };

    const timers = new Map();
    let timerId = 0;
    globalThis.window = {
      setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
      clearTimeout: id => timers.delete(id),
    };
    const VS = require(path.join(tmp, "src/choom/voiceSection.js"));
    const V = require(path.join(tmp, "src/choom/voice.js")).Voice;
    const ST = require(path.join(tmp, "src/core/state.js")).State;

    ST.settings.voiceEnabled = true;
    ST.settings.voiceWakeEnabled = false;
    ST.settings.flowEnabled = true;
    ST.settings.voiceBackend = "whisper";
    ST.settings.flowNotesFolder = "D:\\notes";
    ST.settings.decisionEngine = "laya";
    V.state.muted = false;
    ST.paused = false;

    const event = (kind, generation_, extra = {}) => VS.handleVoiceEvent({
      name: "voice-event",
      payload: { kind, generation: generation_, utterance: 1, sequence: 1, ...extra },
    });

    // ── 1. A routing change retires a real capture while the deck shows work ─
    await VS.startVoice();
    const gen1 = V.state.generation;
    runGate = new Promise((r) => { gateRelease = r; });
    // Start the pump: a dispatched batch puts the deck into `working` while
    // the microphone is still open.
    event("partial", gen1, { text: "open code" });
    await wait(30);
    assert.equal(V.state.runtime, "working",
      "the deck shows work while the capture is still live: this is the case a runtime check misses");
    const atRouting = calls.length;
    await VS.applyRoutingSettings({ decisionEngine: "jev" });
    await wait(50);
    const routingCalls = calls.slice(atRouting);
    check_nativeStop(routingCalls);
    function check_nativeStop(list) {
      assert.ok(list.includes("cancelPreserve") || list.includes("layaCancel"),
        `a routing change must retire the capture natively, saw ${JSON.stringify(list)}`);
    }
    assert.ok(V.state.runtime !== "working", "the deck stops claiming it is working after retirement");
    assert.equal(V.state.stable.length, 0, "no text was invented by the retirement");
    if (gateRelease) gateRelease();
    runGate = null;
    await wait(40);
    assert.equal(V.state.runtime, "standby", "a retired pump cannot change the runtime of the live session");

    // ── 2. Rapid new listens: an old pump cannot consume a newer session ───
    runGate = new Promise((r) => { gateRelease = r; });
    await VS.startVoice();
    const gen2 = V.state.generation;
    const enteredBefore = runEntered;
    event("partial", gen2, { text: "open code" });
    await wait(20);
    assert.ok(runEntered > enteredBefore, "the new session dispatches its own work");
    // Start again immediately: the in-flight pump belongs to the old session.
    await VS.startVoice();
    const gen3 = V.state.generation;
    assert.ok(gen3 > gen2, "each listen is a new generation");
    event("partial", gen3, { text: "open code" });
    await wait(30);
    if (gateRelease) gateRelease();
    runGate = null;
    await wait(60);
    assert.notEqual(V.state.runtime, "working",
      "an old pump finishing cannot drag the newest session into its own state");

    // ── 3. Disabling Flow retires the capture, not just the display ─────────
    await VS.startVoice();
    const gen4 = V.state.generation;
    const atDisable = calls.length;
    runGate = new Promise(r => { gateRelease = r; });
    event("partial", gen4, { text: "open code" });
    await wait(20);
    event("partial", gen4, { utterance: 2, text: "open mail" });
    const beforeDisable = runEntered;
    await VS.applyRoutingSettings({ flowEnabled: false });
    gateRelease();
    runGate = null;
    await wait(30);
    const disableCalls = calls.slice(atDisable);
    assert.ok(disableCalls.includes("cancelPreserve") || disableCalls.includes("listenStop"),
      `switching Flow off must retire the live capture, saw ${JSON.stringify(disableCalls)}`);
    assert.equal(V.state.runtime, "standby", "the deck returns to standby");
    assert.equal(runEntered, beforeDisable, "opt-out discards every queued admission");
    ST.settings.flowEnabled = true;

    // ── 4. Mute retires a live capture ──────────────────────────────────────
    // Fix 2: an utterance-only empty event retains live capture ownership.
    await VS.startVoice();
    const emptyGen = V.state.generation;
    const beforeEmpty = calls.length;
    globalThis.__trackerVerdict = () => ({ kind: "hold", reason: "no-speech" });
    event("empty", emptyGen, { sequence: undefined });
    assert.equal(V.state.runtime, "listening");
    assert.equal(V.state.error, null);
    assert.equal(calls.length, beforeEmpty, "empty does not stop a live capture");
    // Capture, not the displayed runtime, keeps the mic finish control live.
    V.state.runtime = "working";
    ST.settings.voiceWakeEnabled = true;
    await VS.stopVoice();
    assert.ok(calls.slice(beforeEmpty).includes("finish"));
    event("final", emptyGen, { sequence: 2, text: "hello there" });
    await wait(10);
    assert.equal(V.state.runtime, "standby", "Fix 7: a closed final retires capture");
    assert.equal(V.state.error, null);
    assert.equal([...timers.values()].filter(t => t.delay === 135000).length, 0, "the finish timeout is cleared");
    assert.ok(calls.includes("wakeSet"), "manual finish restores wake handling");
    ST.settings.voiceWakeEnabled = false;

    await VS.startVoice();
    const gen5 = V.state.generation;
    const atMute = calls.length;
    event("partial", gen5, { text: "open code" });
    await wait(20);
    await VS.toggleMute();
    await wait(20);
    const muteCalls = calls.slice(atMute);
    assert.ok(muteCalls.includes("cancel") || muteCalls.includes("mute"),
      `mute must retire the capture, saw ${JSON.stringify(muteCalls)}`);
    V.state.muted = false;
    await VS.toggleMute();
    V.state.muted = false;

    // ── 5. Lock and suspend retire the capture too ──────────────────────────
    await VS.startVoice();
    const gen6 = V.state.generation;
    event("partial", gen6, { text: "open code" });
    await wait(20);
    const beforeLock = globalThis.__cancelFlowCalls.length;
    VS.localVoiceStandby();
    await wait(20);
    assert.ok(globalThis.__cancelFlowCalls.length > beforeLock,
      "a session lock fences Flow, so nothing queued can still run");
    assert.equal(V.state.runtime, "standby", "a lock returns the deck to standby");

    // ── 6. The helper's stopped event retires capture the frontend owns ────
    await VS.startVoice();
    const gen7 = V.state.generation;
    event("partial", gen7, { text: "open code" });
    await wait(20);
    const beforeStopped = globalThis.__cancelFlowCalls.length;
    event("stopped", gen7);
    await wait(20);
    assert.ok(globalThis.__cancelFlowCalls.length > beforeStopped,
      "a native stop retires the queue instead of leaving it to run");
    assert.equal(V.state.runtime, "standby", "the deck stops claiming it is listening");

    await VS.startVoice();
    const exitedGeneration = V.state.generation + 1;
    const beforeExit = globalThis.__cancelFlowCalls.length;
    event("helper_exited", exitedGeneration);
    assert.equal(V.state.generation, exitedGeneration, "owned helper EOF adopts the retired native generation");
    assert.equal(V.state.runtime, "error", "helper EOF stops the listening display");
    assert.ok(globalThis.__cancelFlowCalls.length > beforeExit, "helper EOF retires the queue");
    event("partial", exitedGeneration - 1, { text: "stale words" });
    assert.notEqual(V.state.partial, "stale words", "old helper output cannot return after EOF");

    // Fix 6: follow-up listening initializes all the same session owners.
    await VS.startVoice();
    const manualGen = V.state.generation;
    globalThis.__onStop = () => event("stopped", manualGen);
    globalThis.__parseFlow = { kind: "plan", request: { generation: manualGen, steps: [
      { id: "manual1", kind: "app.launch", target: "C:\\apps\\code.exe" },
    ] } };
    await VS.manualVoiceSubmit("open code");
    globalThis.__onStop = null;
    globalThis.__parseFlow = null;
    assert.equal(V.state.runtime, "speaking");
    const resets = globalThis.__sessionResets;
    event("speech_ended", manualGen, { utterance: undefined, sequence: undefined });
    await wait(10);
    const followGen = V.state.generation;
    assert.ok(followGen > manualGen);
    assert.equal(globalThis.__sessionResets, resets + 1);
    assert.equal(globalThis.__flowGen, followGen);
    assert.equal(globalThis.__trackerGen, followGen);
    assert.equal(V.state.runtime, "listening");
    globalThis.__trackerVerdict = () => ({ kind: "dispatch", utterance: 1, sequence: 1, final: true,
      steps: [{ id: "follow1", kind: "app.launch", target: "C:\\apps\\mail.exe" }], text: "open mail" });
    const beforeFollow = runEntered;
    event("final", followGen, { text: "open mail" });
    await wait(10);
    assert.equal(runEntered, beforeFollow + 1, "the follow-up final reaches admission");
    const endWindow = [...timers.values()].find(t => t.delay === 8000);
    assert.ok(endWindow, "a follow-up window is armed");
    endWindow.fn(); await wait(10); assert.equal(V.state.runtime, "standby");

    // Opt-out also fences an explicit listen whose native startup is pending.
    const oldStart = globalThis.__bridge.voiceListenStart;
    let releaseStart;
    const startGate = new Promise(resolve => { releaseStart = resolve; });
    globalThis.__bridge.voiceListenStart = async () => {
      const requested = ++generation;
      await startGate;
      return requested;
    };
    const starting = VS.startVoice();
    await wait(5);
    await VS.applyRoutingSettings({ flowEnabled: false });
    const cancelledGen = V.state.generation;
    releaseStart();
    await starting;
    assert.equal(V.state.generation, cancelledGen, "retired startup cannot adopt its old generation");
    assert.equal(V.state.runtime, "standby");
    globalThis.__bridge.voiceListenStart = oldStart;

    const source = fs.readFileSync(path.join(ROOT, "src/choom/voiceSection.ts"), "utf8");
    const stopCondition = source.slice(source.indexOf("const showStop ="), source.indexOf("stopBtn.style.display =", source.indexOf("const showStop =")));
    assert.match(stopCondition, /activeCapture\(\) != null/, "Stop visibility follows the live capture owner");

    console.log("flow ownership regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
