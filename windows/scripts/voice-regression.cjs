// Voice frontend regression: duplicate finals, stale guards, deck pins,
// muted wake, echo rejection, malformed JSON limits and memory/context rules.
// Run from windows/: node scripts/voice-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["src/choom/voice.ts", "src/choom/jev.ts", "src/choom/voiceSection.ts"];

function compile(tmp) {
  for (const rel of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: rel,
    }).outputText;
    const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-voice-test-"));
  try {
    compile(tmp);
    const V = require(path.join(tmp, "src/choom/voice.js"));

    // Duplicate final submission: same generation and text submits once.
    V.resetSubmissionGuard();
    V.noteSubmitted(3, "open notes");
    assert.equal(V.wasSubmitted(3, "open notes"), true);
    assert.equal(V.wasSubmitted(3, "open notes!"), false);
    assert.equal(V.wasSubmitted(4, "open notes"), false);

    // Stale partial/final/reply after cancellation never acts.
    assert.equal(V.isStale(5, 4), true);
    assert.equal(V.isStale(5, 5), false);

    // Mode selection and pinning: manual pin wins, Auto stays on the ribbon
    // unless context or actionable work needs the instance. B is manual only.
    assert.equal(V.resolveDeckMode("b", 0, false, false), "b");
    assert.equal(V.resolveDeckMode("auto", 0, false, false), "a");
    assert.equal(V.resolveDeckMode("auto", 2, false, false), "a");
    assert.equal(V.resolveDeckMode("auto", 0, true, false), "c");
    assert.equal(V.resolveDeckMode("auto", 0, false, true), "c");
    assert.equal(V.validDeckMode("auto"), true);
    assert.equal(V.validDeckMode("c"), true);
    assert.equal(V.validDeckMode("d"), false);

    // Store guards: muted wake, echo rejection, helper shutdown shape.
    const { Voice } = V;
    Voice.state.generation = 7;
    Voice.state.runtime = "standby";
    Voice.state.muted = true;
    assert.equal(Voice.applyPartial("hello", 7), false);
    Voice.state.muted = false;
    Voice.state.runtime = "speaking";
    assert.equal(Voice.applyPartial("hello", 7), false);
    assert.equal(Voice.applyFinal("hello", 7), null);
    Voice.state.runtime = "listening";
    assert.equal(Voice.applyPartial("hello", 7), true);
    assert.equal(Voice.applyPartial("hello", 8), false);
    V.resetSubmissionGuard();
    assert.equal(Voice.applyFinal("open notes", 7), "open notes");
    assert.equal(Voice.applyFinal("open notes", 7), null);
    Voice.cancelTurn(8);
    assert.equal(Voice.state.generation, 8);
    assert.equal(Voice.state.partial, "");
    // Stable lines survive cancellation for context; transcript is kept.
    assert.equal(Voice.state.stable.length, 1);

    // Endpoint clamp and short talkback.
    assert.equal(V.clampEndpointMs(50), 300);
    assert.equal(V.clampEndpointMs(900), 900);
    assert.equal(V.clampEndpointMs(9000), 3000);
    const spoken = V.speakPreview("one\ntwo\nthree\nfour\nfive\nsix");
    assert.ok(!spoken.includes("five"));

    // Memory opt-in bounds and context removal.
    assert.equal(V.cleanMemoryInput("  remember tea  "), "remember tea");
    assert.equal(V.cleanMemoryInput(" "), null);
    Voice.clearContext();
    assert.equal(Voice.state.context, null);

    // Multi-segment endpoint: finals aggregate into one utterance, once.
    V.resetSubmissionGuard();
    Voice.state.generation = 11;
    Voice.state.runtime = "listening";
    Voice.state.stable = [];
    Voice.state.pendingSegments = [];
    assert.equal(Voice.applyFinal("open my notes", 11), "open my notes");
    assert.equal(Voice.applyFinal("and file it", 11), "and file it");
    assert.deepEqual(Voice.state.pendingSegments, ["open my notes", "and file it"]);
    const taken = Voice.takeSegments();
    assert.equal(taken.aggregate, "open my notes and file it");
    assert.deepEqual(Voice.state.pendingSegments, []);
    // Production notes the aggregate plus its segments: re-delivered finals
    // can never rebuild the same submit.
    V.noteSubmittedSegments(11, taken.aggregate, taken.segments);
    assert.equal(Voice.applyFinal("open my notes", 11), null);
    assert.equal(Voice.applyFinal("and file it", 11), null);

    // Cancel then a new request: the old generation stays late forever.
    Voice.cancelTurn(12);
    assert.equal(Voice.applyFinal("late words", 11), null);
    assert.deepEqual(Voice.state.pendingSegments, []);
    // The full transcript survives cancel and errors.
    assert.ok(Voice.state.stable.length >= 2);
    Voice.state.runtime = "listening";
    Voice.state.generation = 12;
    assert.equal(Voice.applyFinal("fresh words", 12), "fresh words");

    // Bounded transcript: 100 lines newest last, deck B pages of 6.
    Voice.state.stable = [];
    Voice.state.generation = 13;
    Voice.state.runtime = "listening";
    V.resetSubmissionGuard();
    for (let i = 0; i < 105; i++) {
      Voice.state.runtime = "listening";
      Voice.applyFinal(`line ${i}`, 13);
    }
    assert.equal(Voice.state.stable.length, V.MAX_TRANSCRIPT_LINES);
    assert.equal(Voice.state.stable[0].text, "line 5");
    assert.equal(Voice.state.stable[99].text, "line 104");

    // Selected memories only: nothing injects while opt-in is off.
    Voice.state.memoryEnabled = false;
    Voice.state.memories = [{ id: "a", text: "tea", createdMs: 1, source: "user" }];
    Voice.state.selectedMemoryIds = ["a"];
    assert.deepEqual(Voice.selectedMemories(), []);
    Voice.state.memoryEnabled = true;
    assert.deepEqual(Voice.selectedMemories().map((m) => m.id), ["a"]);
    Voice.state.selectedMemoryIds = [];
    assert.deepEqual(Voice.selectedMemories(), []);

    // Exercise the production voice turn against actual streamed events.
    function stub(rel, exports) {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'module.exports = {};');
      require(dest);
      require.cache[dest].exports = exports;
    }
    const state = { settings: { voiceEnabled: true, voiceAutoSubmit: true, flowEnabled: false }, notify() {} };
    let owner = 1;
    stub('src/core/state.js', { State: state });
    stub('src/core/bridge.js', { Bridge: {} });
    stub('src/core/sound.js', { Sound: {} });
    stub('src/views/dom.js', {});
    stub('src/views/icons.js', { ICONS: {} });
    stub('src/views/chat.js', { currentChatOwner: () => owner, cancelChatTurn: () => { owner++; } });
    const routine = { id: "r1", name: "Work", steps: ["code"] };
    stub('src/choom/tools.js', { routineById: () => routine, resolveRoutineSteps: () => [{ id: "code", name: "Code", kind: "app", target: "C:/Code.exe" }] });
    let flowCalls = 0;
    const unexpectedFlow = () => { flowCalls++; throw new Error("Flow ran while disabled"); };
    stub('src/choom/flowController.js', new Proxy({}, { get: () => unexpectedFlow }));
    stub('src/choom/flowGrammar.js', { parseFlowCommand: unexpectedFlow });
    stub('src/choom/flowClauseTracker.js', {
      FlowClauseTracker: class { begin() { unexpectedFlow(); } reset() { unexpectedFlow(); } },
      FlowAdmission: class { clear() { unexpectedFlow(); } setGeneration() { unexpectedFlow(); } },
    });
    global.window = { setTimeout, clearTimeout };
    require("./lib/compile-deps.cjs").compileDeps(ROOT, tmp, SOURCES);
    const controller = require(path.join(tmp, 'src/choom/voiceSection.js'));
    assert.equal(controller.firstSentence('A complete sentence. More'), 'A complete sentence.');
    assert.equal(controller.firstSentence('Not a complete sentence'), '');
    assert.equal(controller.firstSentence('Too short.'), '');
    let delta, finish, unsubscribed = 0, followups = 0;
    const said = [];
    const deps = {
      voiceListenStop: async () => {},
      voiceToolResolve: async () => null,
      voiceProviderCheck: async () => {},
      chatDeltas: async callback => { delta = callback; return () => { unsubscribed++; }; },
      chatTurn: () => new Promise(resolve => { finish = resolve; }),
      voiceSpeak: async text => { said.push(text); },
      voiceListenStart: async () => { followups++; return Voice.state.generation + 1; },
      voiceCancel: async () => Voice.state.generation + 1,
      voiceSpeakStop: async () => {},
      voiceMute: async () => {},
    };
    controller.setVoiceDeps(deps);
    async function turn(generation) {
      Voice.state.generation = generation;
      Voice.state.runtime = 'listening';
      Voice.state.muted = false;
      V.resetSubmissionGuard();
      finish = null;
      const pending = controller.submitVoiceFinal(`Request ${generation}`, generation);
      for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
      assert.ok(finish, 'Agent turn started');
      return { pending };
    }
    const first = await turn(30);
    delta('This is the first');
    assert.deepEqual(said, []);
    delta('This is the first sentence. ');
    delta('This is the first sentence. The rest arrives.');
    assert.deepEqual(said, ['This is the first sentence.']);
    assert.equal(Voice.state.receipt.message, 'This is the first sentence. The rest arrives.');
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 30 } });
    assert.equal(followups, 0, 'Early speech cannot arm recognition during agent work');
    assert.equal(Voice.state.runtime, 'working');
    finish({ text: 'This is the first sentence. The rest arrives.' });
    await first.pending;
    assert.deepEqual(said, ['This is the first sentence.', 'The rest arrives.']);
    assert.equal(unsubscribed, 1);
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 30 } });
    await Promise.resolve();
    assert.equal(followups, 1, 'Follow-up waits until final talkback ends');
    controller.localVoiceStandby();

    const second = await turn(40);
    delta('Another complete sentence. More words');
    finish({ text: 'Another complete sentence. More words.' });
    await Promise.resolve();
    assert.equal(said.at(-1), 'Another complete sentence.', 'Remainder must wait for first completion');
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 40 } });
    await second.pending;
    assert.deepEqual(said.slice(-2), ['Another complete sentence.', 'More words.'], 'Remainder queues after early audio finishes');
    controller.localVoiceStandby();

    const third = await turn(50);
    delta('This first sentence starts before cancel.');
    await controller.cancelVoice();
    const afterCancel = said.length;
    delta('This late sentence must be ignored.');
    finish({ text: 'This late sentence must be ignored. More.' });
    await third.pending;
    assert.equal(said.length, afterCancel, 'Cancel prevents all late speech');
    assert.equal(unsubscribed, 3);

    const fourth = await turn(60);
    await controller.toggleMute();
    const beforeMute = said.length;
    const beforeMutedFollowup = followups;
    let displayedMutedReceipt;
    const offMuted = Voice.subscribe(() => {
      if (Voice.state.runtime === 'standby') displayedMutedReceipt = Voice.state.receipt?.message;
    });
    delta('This muted sentence must be ignored.');
    finish({ text: 'This muted sentence must be ignored.' });
    await fourth.pending;
    assert.equal(said.length, beforeMute, 'Mute blocks early and final speech');
    assert.equal(Voice.state.receipt.message, 'This muted sentence must be ignored.', 'Mute keeps the text result');
    assert.equal(Voice.state.runtime, 'standby', 'Muted completion settles the finished turn');
    assert.equal(displayedMutedReceipt, 'This muted sentence must be ignored.', 'Muted final receipt is notified');
    assert.equal(followups, beforeMutedFollowup, 'Muted completion cannot arm follow-up');
    offMuted();
    controller.localVoiceStandby();

    const fifth = await turn(70);
    const beforeSingle = said.length;
    delta('This is the whole answer.');
    finish({ text: 'This is the whole answer.' });
    await Promise.resolve();
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 70 } });
    await fifth.pending;
    assert.deepEqual(said.slice(beforeSingle), ['This is the whole answer.'], 'A single sentence is never repeated');
    controller.localVoiceStandby();

    const sixth = await turn(80);
    delta('Cancel while the first sentence plays.');
    finish({ text: 'Cancel while the first sentence plays. Never speak this remainder.' });
    await Promise.resolve();
    const beforeWaitingCancel = said.length;
    await controller.cancelVoice();
    await sixth.pending;
    assert.equal(said.length, beforeWaitingCancel, 'Cancelling a queued remainder drops it');

    const paused = await turn(90);
    state.paused = true;
    const beforePaused = said.length;
    const beforePausedFollowup = followups;
    finish({ text: 'The answer still arrives while paused.' });
    await paused.pending;
    assert.equal(Voice.state.runtime, 'standby', 'Paused completion settles the finished turn');
    assert.equal(Voice.state.receipt.message, 'The answer still arrives while paused.');
    assert.equal(said.length, beforePaused);
    assert.equal(followups, beforePausedFollowup);
    state.paused = false;

    const failed = await turn(100);
    delta('The first sentence starts playing.');
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_started', generation: 100 } });
    finish({ error: 'Agent failed after starting playback.' });
    await failed.pending;
    assert.equal(Voice.state.runtime, 'error');
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 100 } });
    assert.equal(Voice.state.runtime, 'error', 'Late audio completion preserves the terminal agent error');
    assert.equal(Voice.state.error, 'Agent failed after starting playback.');
    controller.localVoiceStandby();

    const playbackFailed = await turn(110);
    delta('An early sentence starts playing.');
    const beforePlaybackFailure = said.length;
    const beforeFailureFollowup = followups;
    controller.handleVoiceEvent({ name: 'voice-event', payload: {
      kind: 'error', message: 'Speech failed: output device unavailable.', generation: 110,
    } });
    delta('An early sentence starts playing. The completed answer arrives later.');
    finish({ text: 'The authoritative final answer replaces the streamed receipt.' });
    await playbackFailed.pending;
    assert.equal(Voice.state.receipt.message, 'The authoritative final answer replaces the streamed receipt.', 'Synthesis failure preserves result ownership');
    assert.equal(Voice.state.runtime, 'standby');
    assert.equal(said.length, beforePlaybackFailure, 'A failed playback is not retried automatically');
    assert.equal(followups, beforeFailureFollowup);
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 110 } });
    assert.equal(Voice.state.runtime, 'standby', 'Late failed-playback completion cannot restore Working');

    const twoParts = await turn(120);
    const beforeTwoParts = said.length;
    delta('Here is the');
    delta('Here is the\nanswer. More details.');
    finish({ text: 'Here is the\nanswer. More details.' });
    controller.handleVoiceEvent({ name: 'voice-event', payload: { kind: 'speech_ended', generation: 120 } });
    await twoParts.pending;
    assert.deepEqual(said.slice(beforeTwoParts), ['Here is the answer.', 'More details.'], 'Text-part separators preserve the spoken prefix');
    controller.localVoiceStandby();

    // Disabled Flow never enters its grammar, capture tracker or action queue.
    const legacyCalls = [];
    deps.mediaControl = async action => legacyCalls.push(`media:${action}`);
    deps.voiceToolRun = async (kind, target) => legacyCalls.push(`${kind}:${target}`);
    deps.toolsRoutineStart = async () => { legacyCalls.push("routine"); return [{ status: "ok" }]; };
    deps.voiceWindowSnapshot = async () => null;
    Voice.state.muted = false;
    await controller.startVoice();
    controller.localVoiceStandby();
    for (const [index, route] of [
      { kind: "media", action: "pause" },
      { kind: "app", target: "C:/Code.exe" },
      { kind: "folder", target: "C:/Notes" },
    ].entries()) {
      Voice.state.generation = 200 + index;
      Voice.state.runtime = "listening";
      Voice.state.muted = true;
      deps.voiceToolResolve = async () => route;
      await controller.submitVoiceFinal(`Local command ${index}`, 200 + index);
      assert.equal(Voice.state.receipt.status, "ok");
    }
    await controller.runVoiceChoice({ id: "code", name: "Code", kind: "app", target: "C:/Code.exe" });
    Voice.state.routinePreview = { routineId: "r1", name: "Work" };
    await controller.runVoiceRoutine();
    await controller.cancelVoice();
    assert.deepEqual(legacyCalls, ["media:pause", "app:C:/Code.exe", "folder:C:/Notes", "app:C:/Code.exe", "routine"]);
    assert.equal(flowCalls, 0, "Flow-off turns never execute Flow code");
    console.log("PASS: Flow off: zero grammar, capture tracker or action queue calls; legacy actions, streaming, talkback and Stop pass");

    // No banned sentence connectors in new voice copy.
    for (const rel of ["src/choom/voice.ts", "src/choom/voiceSection.ts", "src-tauri/src/choom/voice.rs"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("voice regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
