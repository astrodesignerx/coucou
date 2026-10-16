// Local Laya routing regression: the real production decision controller
// (voiceSection) and the real policy module (choom/laya), compiled against
// isolated adapters that record every call. Nothing here reimplements the
// production rule: the assertions read the actual exported functions.
//
// The contract under test is negative on purpose. While Local Laya is the
// selected engine, no Jev request, no provider check and no remote agent
// chat may happen on any outcome or on any failure, and an engine switch must
// retire the old owner, advance the shared generation, preserve the request
// draft and reject the late answer of the replaced engine.
//
// Run from windows/: node scripts/laya-routing-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-laya-routing-"));

// The controller reaches for window only to arm and clear its endpoint timer.
// This regression submits by hand, so the shim is timers alone.
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

function compile(rel) {
  const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  return dest;
}

function stub(rel, exports) {
  const dest = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, "module.exports = {};");
  require(dest);
  require.cache[dest].exports = exports;
}

const NOTES = { id: "notes", name: "Notes", kind: "folder", target: "D:/notes" };
const CODE = { id: "code", name: "Code", kind: "app", target: "C:/code.exe" };

/** Counts Flow queue cancellations, so a late callback can be shown not to
 *  cancel the queue a newer request is using. */
let flowCancels = 0;

/** Every adapter call, in order, so a test can assert what never happened. */
const calls = [];
function record(name) {
  calls.push(name);
}

function layaOutcome(over = {}) {
  return {
    route: "answer", confidence: 0.93, latencyMs: 180,
    fallbackReason: null, mode: "local", candidateId: null, ...over,
  };
}

async function main() {
  try {
    const state = {
      settings: {
        jevEnabled: true, jevMode: "assisted", jevThreshold: 0.75, jevDeadlineMs: 2500,
        decisionEngine: "jev", layaRuntimePath: "", layaModelPath: "",
        layaManifestPath: "", layaThreshold: 0.85,
        voiceEnabled: true, voiceWakeEnabled: true, voiceAutoSubmit: false,
        flowEnabled: false, voiceMemoryEnabled: false,
        tools: { version: 1, colours: [], shortcuts: [NOTES, CODE], routines: [] },
      },
      stateOverride: null,
      notify() { record("state.notify"); },
    };
    stub("src/core/state.js", { State: state });
    stub("src/core/bridge.js", { Bridge: {} });
    stub("src/core/sound.js", { Sound: {} });
    stub("src/views/dom.js", {});
    stub("src/views/icons.js", { ICONS: {} });
    stub("src/views/chat.js", {
      submitChatTurn: async () => ({ text: "cloud reply" }),
      currentChatOwner: () => 1,
      cancelChatTurn: () => {},
    });
    stub("src/choom/tools.js", { routineById: () => null, resolveRoutineSteps: () => [] });
    // Flow is stubbed inert: this regression is about the decision engine,
    // and Flow has its own regressions.
    stub("src/choom/flow.js", {
      planFromRequest: () => ({ plan: null, error: "Flow is not part of this regression." }),
      planSummary: () => ({ failed: 0 }),
      formatPlanReceipt: () => "",
    });
    stub("src/choom/flowGrammar.js", { parseFlowCommand: () => null });
    stub("src/choom/flowClauseTracker.js", {
      FlowClauseTracker: class { observePartial() { return { kind: "hold", reason: "no-speech" }; } observeFinal() { return { kind: "not-flow" }; } begin() {} reset() {} },
      FlowAdmission: class { admit() { return false; } take() { return null; } clear() {} setGeneration() {} },
    });
    stub("src/choom/flowController.js", {
      resetSession: () => {}, cancelFlow: () => { flowCancels += 1; }, runPlan: async () => ({}),
      setVoiceGeneration: () => {}, setStaleCheck: () => {}, savedShortcuts: () => [],
      correctFlowTurn: () => null, rememberFlowRequest: () => {}, flowRegistry: () => [],
      flowCapabilityView: () => [], runMediaFlow: async () => ({ receipt: null }),
      runRoutineFlow: async () => ({}), runLaunchFlow: async () => ({}),
    });

    compile("src/choom/jev.ts");
    compile("src/choom/laya.ts");
    const { Voice, resetSubmissionGuard } = require(compile("src/choom/voice.ts"));
    const policy = require(compile("src/choom/laya.ts"));
    const controller = require(compile("src/choom/voiceSection.ts"));

    // ── Every injected adapter records its call, and can be delayed ──────
    let layaResult = layaOutcome();
    let layaError = null;
    let pendingLaya = null;
    let jevResult = { route: "answer", confidence: 0.95, latencyMs: 40, fallbackReason: null, mode: "assisted", candidateId: null };
    let pendingJev = null;
    let route = { kind: "agent", target: null, action: null, routineId: null, options: [], reason: null };
    let providerGate = null;
    let pendingProvider = null;
    let cancelGeneration = 100;
    let cancelReply = null;
    let checkRuns = 0;

    /**
     * The native generation counter, modeled faithfully. The helper reader
     * drops any partial, final, transcribing or empty event whose generation is
     * below this value, so a capture left running after the counter moved on
     * is deaf even though it keeps sending. Every retirement advances it.
     */
    let nativeGeneration = 0;

    /** The native retirement reply. One definition, so a group that swaps it
     *  out and puts it back cannot silently lose a behavior another group
     *  relies on. A queued reply is returned once, then the counter resumes. */
    /** Waits until `seen` becomes true, draining the pending promises. */
    async function until(seen, label) {
      for (let tick = 0; tick < 50 && !seen(); tick++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      assert.ok(seen(), label);
    }

    function nativeCancel() {
      record("LAYA_CANCEL");
      nativeGeneration += 1;
      if (cancelReply != null) {
        const value = cancelReply;
        cancelReply = null;
        nativeGeneration = value;
        return Promise.resolve(value);
      }
      return Promise.resolve(nativeGeneration);
    }

    /** What the native voice_cancel does: mint the next generation, stop the
     *  capture, retire the local worker and raise one cancelled event carrying
     *  the new generation. The event is delivered through the real event
     *  handler, and it can land before the command reply. */
    function nativeVoiceCancel(deliverCancelled, preserveDraft = false) {
      record("voiceCancel");
      nativeGeneration += 1;
      const generation = nativeGeneration;
      const deliver = () => {
        if (deliverCancelled === false) return;
        controller.handleVoiceEvent({
          name: "voice-event", payload: { kind: preserveDraft ? "routing_cancelled" : "cancelled", generation },
        });
      };
      deliver();
      return Promise.resolve(generation);
    }

    /** Delivers a captured utterance the way the helper would, so the native
     *  stale filter is exercised rather than assumed. Returns whether the
     *  event survived the native side. */
    function nativeSpeech(kind, text, generation) {
      if (generation < nativeGeneration) {
        record(`DROPPED_STALE_${kind}`);
        return false;
      }
      controller.handleVoiceEvent({ name: "voice-event", payload: { kind, text, generation } });
      return true;
    }

    const deps = {
      voiceCapability: async () => ({ supported: true, recognizers: [], voices: [], error: null }),
      voiceWhisperStatus: async () => ({ binary: false, base: false, small: false, error: null }),
      openSettings: async () => { record("openSettings"); },
      voiceListenStart: async () => {
        record("listenStart");
        nativeGeneration += 1;
        return nativeGeneration;
      },
      voiceListenStop: async () => { record("listenStop"); },
      voiceWhisperFinish: async () => {},
      voiceCancel: async (preserveDraft) => nativeVoiceCancel(undefined, preserveDraft),
      voiceSpeak: async () => { record("voiceSpeak"); },
      voiceSpeakStop: async () => {},
      voiceWakeSet: async () => {},
      voiceMute: async () => {},
      voiceDeviceRecover: async () => {},
      voiceToolRun: async () => { record("toolRun"); return "target"; },
      voiceWindowSnapshot: async () => null,
      voiceToolResolve: async () => { record("resolve"); return route; },
      voiceProviderCheck: async () => {
        record("PROVIDER_CHECK");
        if (pendingProvider) {
          await pendingProvider();
          pendingProvider = null;
        }
        if (providerGate) throw new Error(providerGate);
      },
      voiceMemoryList: async () => [],
      voiceMemoryAdd: async () => ({}),
      voiceMemoryUpdate: async () => ({}),
      voiceMemoryRemove: async () => {},
      voiceMemoryClear: async () => {},
      toolsPickDocument: async () => null,
      toolsRoutineStart: async () => [],
      mediaControl: async () => { record("MEDIA_CONTROL"); },
      saveSettings: async () => { record("saveSettings"); },
      jevDecide: async () => {
        record("JEV_DECIDE");
        if (pendingJev) return pendingJev();
        return jevResult;
      },
      jevConfigured: async () => { record("jevConfigured"); return true; },
      layaDecide: async (request) => {
        record(`layaDecide:${request.slice(0, 20)}`);
        if (pendingLaya) return pendingLaya();
        if (layaError) throw new Error(layaError);
        return layaResult;
      },
      layaStatus: async () => {
        record("layaStatus");
        return {
          enabled: true, state: "loading", ready: false,
          detail: "Local Laya is set up. The first request loads the model locally.",
          labels: policy.LAYA_LABELS.slice(), runtimePath: "C:/laya/python.exe",
          modelPath: "C:/laya/model", manifestPath: "C:/laya/model-manifest.json",
          workerPath: "C:/laya/choom-laya.py", loadMs: null,
          startupTimeoutMs: 120000, decisionTimeoutMs: 10000, idleUnloadMs: 30000,
          threshold: 0.85, lastReason: null,
        };
      },
      layaCheck: async () => {
        record("layaCheck");
        checkRuns += 1;
        return {
          enabled: true, state: "ready", ready: true,
          detail: "Local Laya is loaded and warm.",
          labels: policy.LAYA_LABELS.slice(), runtimePath: "C:/laya/python.exe",
          modelPath: "C:/laya/model", manifestPath: "C:/laya/model-manifest.json",
          workerPath: "C:/laya/choom-laya.py", loadMs: 11200,
          startupTimeoutMs: 120000, decisionTimeoutMs: 10000, idleUnloadMs: 30000,
          threshold: 0.85, lastReason: null,
        };
      },
      layaCancel: nativeCancel,
      layaHistory: async () => { record("layaHistory"); return []; },
      layaClearHistory: async () => { record("layaClearHistory"); },
      chatTurn: async () => {
        record("CHAT_TURN");
        return { text: "a cloud answer that must never appear in Local mode" };
      },
    };
    controller.setVoiceDeps(deps);

    async function reset(generation = 7, engine = "jev") {
      calls.length = 0;
      layaResult = layaOutcome();
      layaError = null;
      pendingLaya = null;
      pendingJev = null;
      pendingProvider = null;
      providerGate = null;
      cancelReply = null;
      route = { kind: "agent", target: null, action: null, routineId: null, options: [], reason: null };
      state.settings.decisionEngine = engine;
      state.settings.jevEnabled = true;
      state.settings.jevMode = "assisted";
      state.settings.jevThreshold = 0.75;
      state.settings.layaThreshold = 0.85;
      state.settings.layaRuntimePath = "";
      state.settings.layaModelPath = "";
      state.settings.layaManifestPath = "";
      Voice.state.runtime = "standby";
      Voice.state.error = null;
      Voice.state.ambiguity = [];
      Voice.state.receipt = null;
      Voice.state.partial = "";
      Voice.state.pendingSegments = [];
      // The controller keeps its own view of the local setup. Re-syncing it
      // here keeps each group independent of the one before, without touching
      // any adapter, so a group that asserts "cancels nothing" really does
      // start from a clean baseline.
      controller.noteLocalSetupChange();
      resetSubmissionGuard();
      // The retirement it started is asynchronous and adopts a native
      // generation. It is settled here, the log is cleared again, and the
      // deck generation is re-asserted last, so each group starts from exactly
      // the state it asked for.
      await new Promise((r) => setTimeout(r, 0));
      calls.length = 0;
      Voice.state.generation = generation;
    }

    // ── 1. Backward compatibility: the default engine is the online one ──
    assert.equal(policy.normalizeDecisionEngine(undefined), "jev");
    assert.equal(policy.normalizeDecisionEngine("nonsense"), "jev");
    assert.equal(policy.normalizeDecisionEngine("laya"), "laya");
    assert.deepEqual([...policy.LAYA_LABELS], [
      "answer", "options", "clarify", "supported_local", "unknown",
    ], "the local engine returns exactly five fixed labels");
    assert.equal(policy.clampLayaThreshold(0.1), 0.75, "never below the conservative floor");
    assert.equal(policy.clampLayaThreshold(9), 0.95);
    assert.equal(policy.clampLayaThreshold(Number.NaN), 0.85);
    assert.ok(policy.LAYA_THRESHOLD_DEFAULT > 0.75, "the local default stays conservative");

    // The preserved Jev behavior: assisted answer still falls through to the
    // agent exactly as before this phase.
    await reset();
    assert.equal(await controller.decideWithJev("Explain folders", 7), false);
    assert.ok(calls.includes("JEV_DECIDE"));
    await controller.submitVoiceFinal("Explain folders", 7, { manual: true });
    assert.ok(calls.includes("PROVIDER_CHECK"), "online mode still gates on the provider");
    assert.ok(calls.includes("CHAT_TURN"), "online mode still answers through the agent");

    // ── 2. Local mode never calls Jev, the provider or the agent ─────────
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "answer" });
    await controller.submitVoiceFinal("What is a folder", 7, { manual: true });
    assert.ok(!calls.includes("JEV_DECIDE"), "Local mode must not call Jev");
    assert.ok(!calls.includes("PROVIDER_CHECK"), "Local mode must not check a remote provider");
    assert.ok(!calls.includes("CHAT_TURN"), "Local mode must never call remote agent chat");
    assert.ok(!calls.includes("voiceSpeak"), "an offline limitation is shown, not spoken as an answer");
    assert.equal(Voice.state.receipt, null, "no agent receipt is invented");
    assert.match(Voice.state.error, /cannot do anything online/, "the offline limitation is visible");
    assert.equal(Voice.state.runtime, "standby");

    // ── 3. Every route label ends the turn locally ───────────────────────
    for (const routeLabel of policy.LAYA_LABELS) {
      await reset();
      state.settings.decisionEngine = "laya";
      layaResult = layaOutcome({ route: routeLabel });
      await controller.submitVoiceFinal("open my notes", 7, { manual: true });
      assert.ok(!calls.includes("JEV_DECIDE"), `route ${routeLabel} must not call Jev`);
      assert.ok(!calls.includes("CHAT_TURN"), `route ${routeLabel} must not call the agent`);
      assert.ok(!calls.includes("PROVIDER_CHECK"), `route ${routeLabel} must not check a provider`);
    }

    // ── 4. A missing or tampered runtime is a visible limitation ────────
    for (const reason of [
      "No local Laya runtime. Set the interpreter path in Settings.",
      "No local Laya model manifest. Set the manifest path in Settings.",
      "Local Laya could not load the local model.",
      "Local Laya did not answer in time.",
    ]) {
      await reset();
      state.settings.decisionEngine = "laya";
      layaError = reason;
      await controller.submitVoiceFinal("file the report", 7, { manual: true });
      assert.equal(Voice.state.error, reason, "the fixed reason is shown verbatim");
      assert.ok(!calls.includes("CHAT_TURN"), "a missing runtime never falls back to the cloud");
      assert.ok(!calls.includes("JEV_DECIDE"), "a missing runtime never falls back to Jev");
      assert.ok(!calls.includes("PROVIDER_CHECK"));
    }

    // A fallback reason on an otherwise valid outcome is still local.
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "options", confidence: 0.99, fallbackReason: "abstain" });
    await controller.submitVoiceFinal("design something", 7, { manual: true });
    assert.match(Voice.state.error, /cannot do anything online/);
    assert.ok(!calls.includes("CHAT_TURN"));

    // ── 5. Low confidence clarifies and keeps the request editable ───────
    await reset();
    state.settings.decisionEngine = "laya";
    state.settings.layaThreshold = 0.9;
    layaResult = layaOutcome({ route: "clarify", confidence: 0.86 });
    let preserved = null;
    controller.setJevEditFiller((text) => { preserved = text; });
    await controller.submitVoiceFinal("open my notes and file it", 7, { manual: true });
    assert.equal(preserved, "open my notes and file it", "the draft is never lost");
    assert.match(Voice.state.error, /not sure/);
    assert.ok(!calls.includes("CHAT_TURN"));
    controller.setJevEditFiller(null);

    // The threshold is the local one, not the cloud one: a local confidence
    // above the Jev threshold but below the Laya threshold still clarifies.
    await reset();
    state.settings.decisionEngine = "laya";
    state.settings.jevThreshold = 0.75;
    state.settings.layaThreshold = 0.95;
    layaResult = layaOutcome({ route: "answer", confidence: 0.9 });
    assert.equal(await controller.decideWithLaya("open my notes", 7), true);
    assert.match(Voice.state.error, /not sure/);

    // ── 6. Options and supported_local only ever offer real saved targets ─
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "options" });
    await controller.submitVoiceFinal("open my notes", 7, { manual: true });
    assert.deepEqual(Voice.state.ambiguity.map((o) => o.id), ["notes"], "the named saved target is offered");
    assert.match(Voice.state.error, /saved target/);

    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "supported_local" });
    await controller.submitVoiceFinal("open my notes", 7, { manual: true });
    assert.deepEqual(Voice.state.ambiguity.map((o) => o.id), ["notes"]);

    // Nothing the user actually named: an honest limitation, never a guess.
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "options" });
    await controller.submitVoiceFinal("do the thing", 7, { manual: true });
    assert.deepEqual(Voice.state.ambiguity, [], "no invented target is offered");
    assert.match(Voice.state.error, /cannot do anything online/);
    assert.ok(!calls.includes("CHAT_TURN"));

    // supported_local with nothing named comes back as editable clarification.
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "supported_local" });
    let supportedDraft = null;
    controller.setJevEditFiller((text) => { supportedDraft = text; });
    await controller.submitVoiceFinal("do the thing", 7, { manual: true });
    assert.equal(supportedDraft, "do the thing", "the user can reshape and resend it");
    controller.setJevEditFiller(null);

    // ── 7. Deterministic local routes still work, with no provider ───────
    await reset();
    state.settings.decisionEngine = "laya";
    route = { kind: "media", action: "pause", target: null, routineId: null, options: [], reason: null };
    await controller.submitVoiceFinal("pause the music", 7, { manual: true });
    assert.ok(calls.includes("resolve"), "the deterministic resolver still runs first");
    assert.ok(!calls.includes("layaDecide:pause the music"), "a local route never needs the engine");
    assert.ok(!calls.includes("PROVIDER_CHECK"), "a supported local route needs no provider");
    assert.ok(!calls.includes("CHAT_TURN"));

    await reset();
    state.settings.decisionEngine = "laya";
    route = { kind: "app", target: "C:/code.exe", action: null, routineId: null, options: [], reason: null };
    await controller.submitVoiceFinal("open code", 7, { manual: true });
    assert.ok(!calls.includes("PROVIDER_CHECK"));
    assert.ok(!calls.includes("CHAT_TURN"));

    // ── 8. Switching engines retires the old owner and keeps the draft ───
    await reset(11);
    state.settings.decisionEngine = "laya";
    Voice.state.partial = "half said draft";
    Voice.state.pendingSegments = ["half said draft"];
    Voice.state.context = { kind: "window", label: "Notes: Q3" };
    await controller.switchDecisionEngine("jev");
    assert.ok(calls.includes("LAYA_CANCEL"), "the retired engine's ownership is cancelled");
    assert.equal(state.settings.decisionEngine, "jev");
    assert.equal(Voice.state.partial, "half said draft", "the draft survives the switch");
    assert.deepEqual(Voice.state.pendingSegments, ["half said draft"]);
    assert.deepEqual(Voice.state.context, { kind: "window", label: "Notes: Q3" }, "context survives");
    assert.equal(Voice.state.stable.length, 0, "the transcript is untouched, never cleared");

    // Switching to the same engine is a no-op: no cancel, no lost draft.
    await reset(11);
    state.settings.decisionEngine = "laya";
    Voice.state.partial = "kept";
    await controller.switchDecisionEngine("laya");
    assert.ok(!calls.includes("LAYA_CANCEL"), "a no-op switch cancels nothing");
    assert.equal(Voice.state.partial, "kept");

    // ── 9. An engine switch while startup or inference is pending ───────
    // The pending local startup is answered after the user switched away: the
    // late answer must be dropped and must not touch the deck.
    await reset(11);
    state.settings.decisionEngine = "laya";
    let resolveStartup = null;
    pendingLaya = () => new Promise((r) => { resolveStartup = r; });
    const pending = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    calls.length = 0;
    await controller.switchDecisionEngine("jev");
    resolveStartup(layaOutcome({ route: "answer" }));
    assert.equal(await pending, true, "the superseded turn is retired, not answered");
    assert.ok(!calls.includes("layaStatus"));
    assert.ok(Voice.state.receipt == null, "a late local answer never becomes a receipt");

    // The same in the other direction: a pending online decision answered
    // after a switch to Local must not reach the agent or the deck.
    await reset(11);
    let resolveJev = null;
    pendingJev = () => new Promise((r) => { resolveJev = r; });
    const pendingOnline = controller.submitVoiceFinal("Explain folders", 11, { manual: true });
    await until(() => Boolean(resolveJev), "the complete Voice turn must reach deferred Jev");
    calls.length = 0;
    await controller.switchDecisionEngine("laya");
    resolveJev({ route: "answer", confidence: 0.99, latencyMs: 5, fallbackReason: null, mode: "assisted", candidateId: null });
    await pendingOnline;
    assert.ok(!calls.includes("CHAT_TURN"), "no cloud call follows a retired online turn");
    assert.equal(Voice.state.error, null, "the retired turn does not write to the deck");

    // A round trip back to the same engine must not resurrect the old answer:
    // the ownership epoch moved on, so the callback stays refused.
    await reset(11);
    state.settings.decisionEngine = "laya";
    let resolveRoundTrip = null;
    pendingLaya = () => new Promise((r) => { resolveRoundTrip = r; });
    const roundTrip = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    await controller.switchDecisionEngine("jev");
    await controller.switchDecisionEngine("laya");
    Voice.state.error = null;
    resolveRoundTrip(layaOutcome({ route: "options" }));
    assert.equal(await roundTrip, true);
    assert.deepEqual(Voice.state.ambiguity, [], "the stale round-trip result is not reused");
    assert.equal(Voice.state.error, null, "and it writes nothing to the deck");

    // ── 10. A cancelled turn never reaches the engine result path ────────
    await reset(11);
    state.settings.decisionEngine = "laya";
    let resolveCancelled = null;
    pendingLaya = () => new Promise((r) => { resolveCancelled = r; });
    const cancelled = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    Voice.state.generation = 12;
    resolveCancelled(layaOutcome({ route: "options" }));
    assert.equal(await cancelled, true);
    assert.deepEqual(Voice.state.ambiguity, [], "a superseded generation offers nothing");
    assert.equal(Voice.state.error, null, "and shows nothing");

    // A native cancellation error is dropped silently, not shown as a fault.
    await reset(11);
    state.settings.decisionEngine = "laya";
    layaError = "That turn was cancelled.";
    await controller.decideWithLaya("open my notes", 11);
    assert.equal(Voice.state.error, null, "a cancelled turn shows no limitation");

    // ── 11. The readiness check is bounded and changes nothing ───────────
    await reset();
    state.settings.decisionEngine = "laya";
    const checked = await controller.checkLocalEngine();
    assert.equal(checkRuns, 1, "the check warms the local model exactly once");
    assert.equal(checked.state, "ready");
    assert.ok(!calls.includes("JEV_DECIDE"));
    assert.ok(!calls.includes("PROVIDER_CHECK"));
    assert.ok(!calls.includes("CHAT_TURN"));
    assert.equal(Voice.state.receipt, null, "a check never invents a user answer");
    // With the online engine selected there is nothing local to check.
    await reset();
    state.settings.decisionEngine = "jev";
    assert.equal(await controller.checkLocalEngine(), null);
    assert.equal(checkRuns, 1, "the online engine never starts a local worker");

    // ── 12. Receipts carry no raw request text ──────────────────────────
    await reset();
    state.settings.decisionEngine = "laya";
    layaResult = layaOutcome({ route: "clarify" });
    await controller.decideWithLaya("my secret salary number", 7);
    const receipt = controller.getLastLayaReceipt();
    assert.ok(receipt, "a sanitized local receipt is kept");
    const receiptText = JSON.stringify(receipt);
    assert.ok(!receiptText.includes("salary"), "the receipt never carries the request");
    assert.equal(receipt.route, "clarify");
    assert.ok(!("candidateId" in receipt), "the local engine ranks no candidate");
    assert.match(policy.formatLayaReceipt(receipt), /^Laya clarify \(local, 0\.93, 180ms\)$/);

    // ── 13. Readiness copy is honest about every state ───────────────────
    const readyStatus = {
      enabled: true, state: "ready", ready: true, detail: "", labels: [],
      runtimePath: null, modelPath: null, manifestPath: null, workerPath: null,
      loadMs: 11000, startupTimeoutMs: 1, decisionTimeoutMs: 1, idleUnloadMs: 1,
      threshold: 0.85, lastReason: null,
    };
    assert.match(policy.formatLayaStatus(readyStatus), /^Ready\./);
    assert.match(policy.formatLayaStatus({ ...readyStatus, state: "loading", ready: false, loadMs: null }), /^Loading\./);
    assert.match(policy.formatLayaStatus({
      ...readyStatus, state: "missing", ready: false, detail: "No local Laya runtime.",
    }), /^Not ready\. No local Laya runtime\.$/);
    assert.match(policy.formatLayaStatus({
      ...readyStatus, state: "error", ready: false, detail: "Local Laya did not answer in time.",
    }), /^Not ready\./);
    assert.match(policy.formatLayaStatus(null), /unavailable/);

    // ── 14. The local policy module cannot produce a cloud action ────────
    const grounded = { length: 1 };
    for (const routeLabel of policy.LAYA_LABELS) {
      for (const conf of [0.99, 0.5, Number.NaN]) {
        const action = policy.layaNextStep(layaOutcome({ route: routeLabel, confidence: conf }), 0.85, true);
        assert.ok(
          ["clarify", "show_options", "name_saved_target", "offline_limit"].includes(action),
          `route ${routeLabel} at ${conf} produced an unexpected action ${action}`,
        );
      }
    }
    // An unsupported label from a tampered worker is a limitation, not a route.
    assert.equal(policy.layaNextStep(layaOutcome({ route: "launch_everything" }), 0.85, true), "offline_limit");
    assert.equal(policy.layaNextStep(layaOutcome({ route: "options" }), 0.85, false), "offline_limit");
    assert.equal(policy.layaNextStep(layaOutcome({ route: "options" }), 0.85, grounded), "show_options");
    assert.equal(policy.layaNextStep(layaOutcome({ route: "clarify" }), 0.85, false), "clarify");
    assert.equal(policy.layaNextStep(layaOutcome({ route: "answer" }), 0.85, true), "offline_limit");
    // The limitation text never names a provider or promises an answer.
    assert.ok(!/https?:|api key|agent model/i.test(policy.LAYA_OFFLINE_LIMIT));

    // ── 15. A deferred provider readiness is fenced before remote chat ──
    // The provider gate itself was pending when the engine changed. The turn
    // must retire at the gate, not walk through it into a cloud answer.
    await reset(11);
    let releaseProvider = null;
    pendingProvider = () => new Promise((r) => { releaseProvider = r; });
    const pendingGate = controller.submitVoiceFinal("Explain folders", 11, { manual: true });
    await until(() => Boolean(releaseProvider), "the complete Voice turn must reach the deferred provider gate");
    calls.length = 0;
    await controller.switchDecisionEngine("laya");
    releaseProvider();
    await pendingGate;
    assert.ok(!calls.includes("CHAT_TURN"), "no cloud call follows a switch at the provider gate");
    assert.equal(Voice.state.runtime, "standby", "the retired turn is not left on working");
    assert.equal(Voice.state.error, null, "and it does not write to the deck");

    // The same with the engine switched back: an online turn pending at the
    // provider gate must still never reach chat once retired.
    await reset(11);
    let releaseProviderBack = null;
    pendingProvider = () => new Promise((r) => { releaseProviderBack = r; });
    const pendingGateBack = controller.submitVoiceFinal("Explain folders", 11, { manual: true });
    await until(() => Boolean(releaseProviderBack), "the turn reaches the deferred gate again");
    calls.length = 0;
    await controller.switchDecisionEngine("laya");
    await controller.switchDecisionEngine("jev");
    releaseProviderBack();
    await pendingGateBack;
    assert.ok(!calls.includes("CHAT_TURN"), "a round trip does not resurrect the retired turn");

    // ── 16. Both engine directions and a round trip, through the controller ─
    for (const [from, to] of [["jev", "laya"], ["laya", "jev"], ["laya", "laya"], ["jev", "jev"]]) {
      await reset(11);
      state.settings.decisionEngine = from;
      let resolveDeferred = null;
      const defer = () => new Promise((r) => { resolveDeferred = r; });
      if (from === "laya") pendingLaya = defer;
      else pendingJev = defer;
      const turn = controller.submitVoiceFinal("Explain folders", 11, { manual: true });
      await until(() => Boolean(resolveDeferred), `a ${from} turn must reach its classifier`);
      calls.length = 0;
      if (from !== to) await controller.switchDecisionEngine(to);
      resolveDeferred(layaOutcome({ route: "answer", confidence: 0.99 }));
      await turn;
      if (from !== to) {
        assert.ok(!calls.includes("CHAT_TURN"), `${from} to ${to} must not reach cloud chat`);
        assert.equal(Voice.state.error, null, `${from} to ${to} must not write to the deck`);
      }
    }

    // ── 17. Rapid switches: only the current one owns the reply ──────────
    await reset(11);
    state.settings.decisionEngine = "laya";
    let resolveRapid = null;
    pendingLaya = () => new Promise((r) => { resolveRapid = r; });
    const rapid = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    await controller.switchDecisionEngine("jev");
    await controller.switchDecisionEngine("laya");
    await controller.switchDecisionEngine("jev");
    resolveRapid(layaOutcome({ route: "options" }));
    assert.equal(await rapid, true);
    assert.deepEqual(Voice.state.ambiguity, [], "rapid switches retire the pending local decision");
    assert.equal(Voice.state.error, null, "and it shows nothing");

    // ── 18. A same-engine setup change retires pending local work ─────────
    await reset(11);
    state.settings.decisionEngine = "laya";
    state.settings.layaRuntimePath = "C:/laya/python.exe";
    controller.noteLocalSetupChange();
    let resolveSetup = null;
    pendingLaya = () => new Promise((r) => { resolveSetup = r; });
    const pendingSetup = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    calls.length = 0;
    // The same engine, a different model folder: the running worker belongs
    // to the old setup and may no longer answer for this one.
    state.settings.layaModelPath = "C:/laya/model-2";
    controller.noteLocalSetupChange();
    resolveSetup(layaOutcome({ route: "options" }));
    assert.equal(await pendingSetup, true);
    assert.deepEqual(Voice.state.ambiguity, [], "the replaced setup cannot offer a target");
    assert.equal(Voice.state.error, null, "and it writes nothing to the deck");
    // The draft and the transcript are untouched by a setup edit too.
    Voice.state.partial = "half said";
    state.settings.layaManifestPath = "C:/laya/model-2.json";
    controller.noteLocalSetupChange();
    assert.equal(Voice.state.partial, "half said", "a setup change never clears the draft");

    // A late readiness answer for a replaced setup is refused, and the
    // current truth is read instead.
    await reset(11);
    state.settings.decisionEngine = "laya";
    let releaseCheck = null;
    deps.layaCheck = () => {
      record("layaCheck");
      checkRuns += 1;
      return new Promise((r) => { releaseCheck = r; });
    };
    const pendingCheck = controller.checkLocalEngine();
    await Promise.resolve();
    calls.length = 0;
    state.settings.layaRuntimePath = "C:/laya/other/python.exe";
    controller.noteLocalSetupChange();
    releaseCheck({
      enabled: true, state: "ready", ready: true, detail: "", labels: [],
      runtimePath: "C:/laya/python.exe", modelPath: null, manifestPath: null, workerPath: null,
      loadMs: 9000, startupTimeoutMs: 1, decisionTimeoutMs: 1, idleUnloadMs: 1,
      threshold: 0.85, lastReason: null,
    });
    const afterSetupChange = await pendingCheck;
    assert.ok(afterSetupChange, "a replaced setup still reports the current truth");
    assert.ok(calls.includes("layaStatus"), "the stale warm-up answer is not shown");
    deps.layaCheck = async () => {
      record("layaCheck");
      checkRuns += 1;
      return {
        enabled: true, state: "ready", ready: true, detail: "", labels: [],
        runtimePath: "C:/laya/python.exe", modelPath: null, manifestPath: null, workerPath: null,
        loadMs: 11400, startupTimeoutMs: 1, decisionTimeoutMs: 1, idleUnloadMs: 1,
        threshold: 0.85, lastReason: null,
      };
    };

    // ── 19. A routing change arriving from another window ────────────────
    // This is the path the island actually uses: a settings-changed event
    // carries the whole patch, and the controller decides whether anything
    // about the routing moved.
    await reset(11);
    state.settings.decisionEngine = "laya";
    let resolveFromEvent = null;
    pendingLaya = () => new Promise((r) => { resolveFromEvent = r; });
    const pendingEvent = controller.decideWithLaya("open my notes", 11);
    await Promise.resolve();
    calls.length = 0;
    await controller.applyRoutingSettings({ decisionEngine: "laya", layaModelPath: "C:/laya/other" });
    resolveFromEvent(layaOutcome({ route: "options" }));
    assert.equal(await pendingEvent, true);
    assert.deepEqual(Voice.state.ambiguity, [], "a setup change from another window retires the turn");
    assert.ok(calls.includes("LAYA_CANCEL"), "the replaced setup's worker is retired");

    // A patch that touches nothing about the routing changes nothing.
    await reset(11, "laya");
    calls.length = 0;
    await controller.applyRoutingSettings({ voiceFollowupMs: 4000, chatProvider: "anthropic" });
    assert.ok(!calls.includes("LAYA_CANCEL"), "an unrelated settings change cancels nothing");

    // An engine change arriving from another window retires the same way.
    await reset(11);
    calls.length = 0;
    await controller.applyRoutingSettings({ decisionEngine: "laya" });
    assert.equal(state.settings.decisionEngine, "laya");
    assert.ok(calls.includes("LAYA_CANCEL"), "an engine change from another window retires the old owner");

    // The settings-changed application cannot reapply an obsolete generation:
    // a slow event that lands after a newer one is dropped. The first event
    // really changes the routing so it reaches the native retirement, and the
    // second, newer event answers first.
    await reset(11);
    let releaseObsolete = null;
    let obsoleteSeen = 0;
    deps.layaCancel = () => {
      record("LAYA_CANCEL");
      if (obsoleteSeen++ === 0) {
        return new Promise((r) => { releaseObsolete = () => r(95); });
      }
      return Promise.resolve(18);
    };
    const obsoleteEvent = controller.applyRoutingSettings({ decisionEngine: "laya" });
    assert.ok(releaseObsolete, "the first routing event really retires the old owner");
    await controller.applyRoutingSettings({ layaModelPath: "C:/laya/model-3" });
    releaseObsolete();
    await obsoleteEvent;
    assert.equal(state.settings.decisionEngine, "laya", "both events were applied");
    assert.equal(Voice.state.generation, 18, "an obsolete settings event never reapplies its generation");
    deps.layaCancel = nativeCancel;

    // ── 20. A cancellation generation moves the deck forward only ─────────
    await reset(11);
    state.settings.decisionEngine = "laya";
    cancelReply = 40;
    await controller.switchDecisionEngine("jev");
    assert.equal(Voice.state.generation, 40, "a newer native generation is adopted");

    // An older reply never drags the deck backwards.
    await reset(11);
    state.settings.decisionEngine = "laya";
    cancelReply = 3;
    await controller.switchDecisionEngine("jev");
    assert.equal(Voice.state.generation, 11, "an older generation is dropped");

    // A reply from a switch that has already been superseded is dropped even
    // when it is newer than the deck.
    await reset(11);
    state.settings.decisionEngine = "laya";
    let releaseCancel = null;
    let cancelSeen = 0;
    deps.layaCancel = () => {
      record("LAYA_CANCEL");
      if (cancelSeen++ === 0) {
        return new Promise((r) => { releaseCancel = () => r(90); });
      }
      return Promise.resolve(20);
    };
    const slowSwitch = controller.switchDecisionEngine("jev");
    await Promise.resolve();
    await controller.switchDecisionEngine("laya");
    releaseCancel();
    await slowSwitch;
    assert.equal(Voice.state.generation, 20, "a superseded cancellation reply is never applied");
    deps.layaCancel = nativeCancel;

    // ── 21. A routing change stops a live capture, and keeps the text ─────
    // The native counter is modeled faithfully here, so the failure this
    // replaces would show up: a capture left running after the native
    // generation moved on keeps sending a generation the helper discards, so
    // the deck looks like it is listening while every word is dropped.
    await reset(11, "laya");
    nativeGeneration = 11;
    Voice.state.runtime = "listening";
    Voice.state.partial = "half said draft";
    Voice.state.pendingSegments = ["half said draft"];
    Voice.state.stable = [{ id: 1, text: "earlier line", final: true }];
    Voice.state.context = { kind: "window", label: "Notes: Q3" };
    calls.length = 0;

    // Before the change the capture is live and its speech reaches the deck.
    assert.ok(nativeSpeech("partial", "half said draft", 11), "speech reaches a live capture");
    assert.equal(Voice.state.partial, "half said draft");

    await controller.switchDecisionEngine("jev");
    // The capture was stopped deliberately, through the voice command, not by
    // leaving the old worker behind.
    assert.ok(calls.includes("voiceCancel"), "a live capture is stopped with the voice command");
    assert.ok(!calls.includes("LAYA_CANCEL"), "the voice command retires the local worker itself");
    assert.equal(Voice.state.runtime, "standby", "the deck is honest that it stopped listening");
    assert.ok(Voice.state.generation > 11, "the deck moves onto the new native generation");
    // Everything the user said is still there.
    assert.equal(Voice.state.partial, "half said draft", "the draft survives the capture stop");
    assert.deepEqual(Voice.state.pendingSegments, ["half said draft"], "the pending text survives");
    assert.equal(Voice.state.stable.length, 1, "the transcript survives");
    assert.deepEqual(Voice.state.context, { kind: "window", label: "Notes: Q3" }, "the context survives");

    // Event delivery can follow the command reply. Native intent must still
    // preserve text, without swallowing an ordinary explicit Stop.
    controller.handleVoiceEvent({
      name: "voice-event",
      payload: { kind: "routing_cancelled", generation: Voice.state.generation },
    });
    assert.equal(Voice.state.partial, "half said draft", "late routing cancellation preserves the draft");
    assert.deepEqual(Voice.state.pendingSegments, ["half said draft"], "late routing cancellation preserves pending text");

    // A fresh listen on the new engine works, and its speech is heard again.
    const fresh = await deps.voiceListenStart();
    Voice.state.generation = fresh;
    Voice.state.runtime = "listening";
    calls.length = 0;
    assert.ok(nativeSpeech("final", "open my notes", fresh), "a fresh listen is heard");
    assert.deepEqual(Voice.state.pendingSegments.at(-1), "open my notes");

    // A late capture from before the change is dropped by the native filter,
    // which is why stopping it was the only honest outcome.
    calls.length = 0;
    assert.equal(nativeSpeech("final", "stale words", 11), false, "the old capture is deaf natively");
    assert.ok(calls.includes("DROPPED_STALE_final"));

    // The cancelled event the native side raises belongs to this decision, so
    // it must not clear what was preserved, and must not cancel a newer
    // listen. Here it arrives before the command reply.
    await reset(11, "laya");
    nativeGeneration = 11;
    Voice.state.runtime = "listening";
    Voice.state.partial = "kept through the event";
    Voice.state.pendingSegments = ["kept through the event"];
    let releaseVoiceCancel = null;
    deps.voiceCancel = (preserveDraft) => {
      record("voiceCancel");
      nativeGeneration += 1;
      const generation = nativeGeneration;
      // The event lands while the command is still outstanding.
      controller.handleVoiceEvent({
        name: "voice-event", payload: { kind: preserveDraft ? "routing_cancelled" : "cancelled", generation },
      });
      return new Promise((r) => { releaseVoiceCancel = () => r(generation); });
    };
    const stopped = controller.switchDecisionEngine("jev");
    assert.ok(releaseVoiceCancel, "the capture stop is in flight");
    releaseVoiceCancel();
    await stopped;
    deps.voiceCancel = async (preserveDraft) => nativeVoiceCancel(undefined, preserveDraft);
    assert.equal(Voice.state.partial, "kept through the event",
      "the cancelled event of a routing change keeps the draft");
    assert.deepEqual(Voice.state.pendingSegments, ["kept through the event"],
      "and keeps the pending text");

    // A delayed cancellation reply cannot cancel a listen that started after it.
    await reset(11, "laya");
    nativeGeneration = 11;
    Voice.state.runtime = "listening";
    let releaseDelayed = null;
    deps.voiceCancel = (preserveDraft) => {
      record("voiceCancel");
      nativeGeneration += 1;
      return new Promise((r) => { releaseDelayed = () => r(12); });
    };
    const delayed = controller.switchDecisionEngine("jev");
    await Promise.resolve();
    // The user starts listening again before the reply lands.
    const newer = nativeGeneration + 1;
    nativeGeneration = newer;
    Voice.state.generation = newer;
    Voice.state.runtime = "listening";
    releaseDelayed();
    await delayed;
    deps.voiceCancel = async (preserveDraft) => nativeVoiceCancel(undefined, preserveDraft);
    assert.equal(Voice.state.generation, newer, "a delayed cancellation never reaps a newer listen");
    assert.equal(Voice.state.runtime, "listening", "and never stops it either");
    assert.ok(nativeSpeech("final", "still heard", newer), "the newer listen still works");

    // An ordinary explicit Stop is untouched: it still clears the turn.
    await reset(11, "laya");
    nativeGeneration = 11;
    Voice.state.runtime = "listening";
    Voice.state.partial = "stop clears me";
    Voice.state.pendingSegments = ["stop clears me"];
    controller.handleVoiceEvent({
      name: "voice-event", payload: { kind: "cancelled", generation: 12 },
    });
    assert.equal(Voice.state.partial, "", "an explicit Stop still clears the turn");
    assert.deepEqual(Voice.state.pendingSegments, [], "and the pending text with it");

    // ── 22. An old callback never retires a newer request ─────────────────
    // Three kinds of late callback, each settling while a newer request owns
    // the deck: the classifier, the provider gate and the chat reply. None of
    // them may cancel the newer request, touch its queue, or remove its
    // thinking indicator.
    async function lateClassifierWhileNewerWorks() {
      await reset(11);
      state.settings.decisionEngine = "jev";
      state.settings.jevMode = "assisted";
      let releaseOld = null;
      pendingJev = () => new Promise((r) => { releaseOld = r; });
      const old = controller.submitVoiceFinal("first question", 11, { manual: true });
      await until(() => Boolean(releaseOld), "the first request reached its classifier");
      // The first request retires, then a second one starts in the same
      // generation, which is the hardest case: the epoch and the generation
      // are identical for both.
      await controller.switchDecisionEngine("laya");
      await controller.switchDecisionEngine("jev");
      pendingJev = null;
      const newer = controller.submitVoiceFinal("second question", 11, { manual: true });
      await new Promise((r) => setTimeout(r, 0));
      const working = Voice.state.runtime === "standby";
      state.stateOverride = "thinking";
      Voice.state.runtime = "working";
      const cancelsBefore = flowCancels;
      releaseOld({ route: "answer", confidence: 0.99, latencyMs: 5, fallbackReason: null, mode: "assisted", candidateId: null });
      await old;
      assert.equal(Voice.state.runtime, "working", "a late classifier reply leaves the newer request working");
      assert.equal(state.stateOverride, "thinking", "and leaves its thinking indicator alone");
      assert.equal(flowCancels, cancelsBefore, "and does not cancel the newer request's queue");
      state.stateOverride = null;
      Voice.state.runtime = working ? "standby" : Voice.state.runtime;
      await newer;
    }

    async function lateProviderWhileNewerWorks() {
      await reset(11);
      state.settings.decisionEngine = "jev";
      state.settings.jevMode = "off";
      let releaseGate = null;
      pendingProvider = () => new Promise((r) => { releaseGate = r; });
      const old = controller.submitVoiceFinal("first question", 11, { manual: true });
      await until(() => Boolean(releaseGate), "the first request reached the provider gate");
      await controller.switchDecisionEngine("laya");
      await controller.switchDecisionEngine("jev");
      pendingProvider = null;
      const newer = controller.submitVoiceFinal("second question", 11, { manual: true });
      await new Promise((r) => setTimeout(r, 0));
      state.stateOverride = "thinking";
      Voice.state.runtime = "working";
      releaseGate();
      await old;
      assert.equal(Voice.state.runtime, "working", "a late provider reply leaves the newer request working");
      assert.equal(state.stateOverride, "thinking", "and leaves its thinking indicator alone");
      const gateCancels = flowCancels;
      state.stateOverride = null;
      Voice.state.runtime = "standby";
      await newer;
      assert.equal(flowCancels, gateCancels, "and does not cancel the newer request's queue");
    }

    async function lateChatWhileNewerListens() {
      await reset(11);
      state.settings.decisionEngine = "jev";
      state.settings.jevMode = "off";
      let releaseChat = null;
      let chatCalls = 0;
      let parkChat = true;
      deps.chatTurn = async () => {
        chatCalls += 1;
        // The first call parks, so the reply is still out when the newer listen
        // starts. Any later call answers at once.
        if (parkChat) {
          parkChat = false;
          return new Promise((r) => { releaseChat = r; });
        }
        return { text: "second answer" };
      };
      const old = controller.submitVoiceFinal("first question", 11, { manual: true });
      await until(() => Boolean(releaseChat), "the first request reached chat");
      // A new listen generation starts while the first reply is still out.
      const newer = nativeGeneration + 5;
      nativeGeneration = newer;
      Voice.state.generation = newer;
      Voice.state.runtime = "listening";
      Voice.state.partial = "new dictation";
      state.stateOverride = "thinking";
      releaseChat({ text: "first answer" });
      await old;
      assert.equal(chatCalls, 1, "the retired request issued exactly one request");
      assert.equal(state.stateOverride, null,
        "the retired request releases the thinking indicator it set itself");
      assert.equal(Voice.state.runtime, "listening", "and does not stop the newer listen");
      assert.equal(Voice.state.partial, "new dictation", "nor touch the new dictation");
      deps.chatTurn = async () => {
        chatCalls += 1;
        return { text: "a cloud answer" };
      };
    }

    await lateClassifierWhileNewerWorks();
    await lateProviderWhileNewerWorks();
    await lateChatWhileNewerListens();

    // An unrelated typed chat turn keeps its own owner: a routing change never
    // releases a thinking indicator it did not set.
    await reset(11, "laya");
    await controller.submitVoiceFinal("Explain folders", 11, { manual: true });
    assert.equal(Voice.state.runtime, "standby", "the local request has completed before typed chat starts");
    state.stateOverride = "thinking";
    await controller.switchDecisionEngine("jev");
    assert.equal(state.stateOverride, "thinking",
      "a routing change never releases a typed chat turn's thinking indicator");
    state.stateOverride = null;

    // ── 23. An engine change never clears the draft ──────────────────────
    await reset(11);
    state.settings.decisionEngine = "laya";
    Voice.state.partial = "half said draft";
    Voice.state.pendingSegments = ["half said draft"];
    Voice.state.stable = [{ id: 1, text: "earlier line", final: true }];
    Voice.state.context = { kind: "window", label: "Notes: Q3" };
    await controller.switchDecisionEngine("jev");
    assert.equal(Voice.state.partial, "half said draft", "the draft survives");
    assert.deepEqual(Voice.state.pendingSegments, ["half said draft"], "the pending text survives");
    assert.equal(Voice.state.stable.length, 1, "the transcript survives");
    assert.deepEqual(Voice.state.context, { kind: "window", label: "Notes: Q3" }, "the context survives");

    // ── 24. Readiness load timing reads in seconds ───────────────────────
    assert.equal(policy.formatSeconds(11400), "11s");
    assert.equal(policy.formatSeconds(1120), "1.1s", "a short load keeps one decimal");
    assert.equal(policy.formatSeconds(0), "0.0s");
    assert.equal(policy.formatSeconds(-1), "0s");
    assert.equal(policy.formatSeconds(Number.NaN), "0s");
    assert.ok(
      !/Local Laya|route labels?|calibrat|probabilit/i.test(policy.LAYA_OFFLINE_LIMIT),
      "the limitation is plain language, not product jargon",
    );
    assert.ok(
      policy.LAYA_OFFLINE_LIMIT.includes("cannot do anything online"),
      "the online limit is stated explicitly",
    );

    // ── 25. New copy carries no banned punctuation ───────────────────────
    // Only the copy this phase wrote is checked. The first line of chat.ts is
    // pre-existing text that is not this phase's to rewrite.
    const banned = [["\u2014", "em dash"], ["\u2013", "en dash"], ["\u00b7", "middle dot"]];
    for (const [ch, name] of banned) {
      const laya = fs.readFileSync(path.join(ROOT, "src/choom/laya.ts"), "utf8");
      assert.ok(!laya.includes(ch), `src/choom/laya.ts must not contain a ${name}`);
      const chat = fs.readFileSync(path.join(ROOT, "src/views/chat.ts"), "utf8");
      const added = chat.slice(chat.indexOf("With Local Laya selected"), chat.indexOf("const jevMode"));
      assert.ok(added.length > 0, "the Local Laya chat gate comment is present");
      assert.ok(!added.includes(ch), `the chat.ts Local Laya comment must not contain a ${name}`);
    }

    console.log("PASS: Local Laya routing across the full Voice controller: no cloud on any outcome or failure, honest limitation and clarification, bounded readiness check, deferred classifier and provider gates fenced, engine and setup changes retire the old owner, keep the draft and reject stale results and generations.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
