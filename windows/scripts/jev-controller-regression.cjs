// Exercises the actual voice controller with isolated adapters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'choom-jev-controller-'));
function compile(rel) {
  const dest = path.join(tmp, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  return dest;
}
function stub(rel, exports) {
  const dest = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'module.exports = {};');
  require(dest);
  require.cache[dest].exports = exports;
}
async function main() {
  try {
    const state = { settings: { jevEnabled: true, jevMode: 'assisted', jevThreshold: 0.75,
      tools: { shortcuts: [{ id: 'notes', name: 'Notes', kind: 'folder', target: 'C:/test-notes' }], routines: [] } }, notify() {} };
    stub('src/core/state.js', { State: state });
    stub('src/core/bridge.js', { Bridge: {} });
    stub('src/core/sound.js', { Sound: {} });
    stub('src/views/dom.js', {});
    stub('src/views/icons.js', { ICONS: {} });
    stub('src/views/chat.js', {});
    stub('src/choom/tools.js', {});
    // The Flow phase added these imports to the controller module. This
    // regression exercises the Jev decision and the voice lifecycle, never a
    // Flow turn, so the planner, grammar and controller are stubbed with
    // inert stand-ins instead of being reimplemented here. Flow itself has
    // its own regressions.
    stub('src/choom/flow.js', {
      planFromRequest: () => ({ plan: null, error: 'Flow is not part of this regression.' }),
      planSummary: () => ({ failed: 0 }),
      formatPlanReceipt: () => '',
    });
    stub('src/choom/flowGrammar.js', { parseFlowCommand: () => null });
    stub('src/choom/flowClauseTracker.js', {
      FlowClauseTracker: class { observePartial() { return { kind: 'hold', reason: 'no-speech' }; } observeFinal() { return { kind: 'not-flow' }; } begin() {} reset() {} },
      FlowAdmission: class { admit() { return false; } take() { return null; } clear() {} setGeneration() {} },
    });
    stub('src/choom/flowController.js', {
      resetSession: () => {}, cancelFlow: () => {}, runPlan: async () => ({}),
      setVoiceGeneration: () => {}, setStaleCheck: () => {}, savedShortcuts: () => [],
      correctFlowTurn: () => null, rememberFlowRequest: () => {}, flowRegistry: () => [],
      flowCapabilityView: () => [], runMediaFlow: async () => ({}),
      runRoutineFlow: async () => ({}), runLaunchFlow: async () => ({}),
    });
    compile('src/choom/jev.ts');
    compile('src/choom/laya.ts');
    const { Voice } = require(compile('src/choom/voice.ts'));
    const controller = require(compile('src/choom/voiceSection.ts'));
    Voice.state.generation = 7;
    let calls = 0;
    let configured = true;
    let result = { route: 'answer', confidence: 0.9, latencyMs: 1,
      fallbackReason: null, mode: 'assisted', candidateId: null };
    let decide = async () => { calls++; return result; };
    controller.setVoiceDeps({ jevConfigured: async () => configured,
      jevDecide: (...args) => decide(...args) });
    state.settings.jevEnabled = false;
    assert.equal(await controller.decideWithJev('Explain folders', 7), false);
    assert.equal(calls, 0);
    state.settings.jevEnabled = true;
    configured = false;
    assert.equal(await controller.decideWithJev('Explain folders', 7), false);
    assert.equal(calls, 0);
    configured = true;
    state.settings.jevMode = 'shadow';
    let resolve;
    decide = () => { calls++; return new Promise(r => { resolve = r; }); };
    // The production controller must finish while classification is unresolved.
    assert.equal(await controller.decideWithJev('Explain folders', 7), false);
    assert.equal(calls, 1);
    resolve({ ...result, mode: 'shadow' });
    await Promise.resolve();
    state.settings.jevMode = 'assisted';
    controller.setLastJevReceipt(null);
    let lateResolve;
    decide = () => new Promise(resolve => { lateResolve = resolve; });
    const started = Date.now();
    assert.equal(await controller.decideWithJev('Slow assisted decision', 7), false);
    assert.ok(Date.now() - started < 850, 'Assisted must fall through after its 600ms grace');
    assert.equal(controller.getLastJevReceipt(), null);
    let lateActs = 0;
    controller.setJevEditFiller(() => { lateActs++; });
    lateResolve({ ...result, route: 'clarify', latencyMs: 900 });
    await Promise.resolve();
    assert.equal(controller.getLastJevReceipt().route, 'clarify', 'Late receipt is retained');
    assert.equal(lateActs, 0, 'Late classification must never act');
    decide = async () => { calls++; return result; };
    assert.equal(await controller.decideWithJev('Explain folders', 7), false);
    state.settings.jevThreshold = 0.95;
    result = { ...result, route: 'clarify' };
    assert.equal(await controller.decideWithJev('Help', 7), false);
    state.settings.jevThreshold = 0.75;
    let preserved;
    controller.setJevEditFiller(text => { preserved = text; });
    assert.equal(await controller.decideWithJev('Help with this', 7), true);
    assert.equal(preserved, 'Help with this');
    assert.ok(Voice.state.error.includes('?'));
    result = { ...result, route: 'options' };
    assert.equal(await controller.decideWithJev('Give me design options', 7), false);
    assert.equal(await controller.decideWithJev('Show Notes options', 7), true);
    assert.deepEqual(Voice.state.ambiguity.map(s => s.id), ['notes']);
    result = { ...result, route: 'supported_local' };
    assert.equal(await controller.decideWithJev('Launch something', 7), false);
    result = { ...result, route: 'answer' };
    decide = async () => { Voice.state.generation = 8; return result; };
    assert.equal(await controller.decideWithJev('Late request', 7), true);
    Voice.state.generation = 7;
    decide = async () => { throw new Error('That turn was cancelled.'); };
    assert.equal(await controller.decideWithJev('Cancelled request', 7), true);
    decide = async () => { state.settings.jevEnabled = false; return { ...result, route: 'clarify' }; };
    assert.equal(await controller.decideWithJev('Opt-out during request', 7), false);
    // Actual panel-close lifecycle must restore wake after every dictation.
    state.settings.voiceEnabled = true;
    state.settings.voiceWakeEnabled = true;
    state.mode = 'compact';
    state.paused = false;
    Voice.state.muted = false;
    const lifecycle = [];
    controller.setVoiceDeps({
      voiceListenStop: async () => { lifecycle.push('stop'); },
      voiceWakeSet: async () => { lifecycle.push('wake'); },
      voiceListenStart: async () => { lifecycle.push('listen'); return 9; },
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      await controller.startVoice();
      await controller.closeVoicePanel();
      assert.equal(Voice.state.runtime, 'standby');
    }
    assert.deepEqual(lifecycle, ['listen','stop','wake','listen','stop','wake','listen','stop','wake']);
    Voice.state.runtime = 'working';
    await controller.closeVoicePanel();
    assert.equal(lifecycle.length, 9, 'Closing must not interrupt a running task');
    Voice.state.runtime = 'listening';
    Voice.state.muted = true;
    await controller.closeVoicePanel();
    assert.equal(lifecycle.at(-1), 'stop', 'Mute must prevent wake rearm');
    Voice.state.muted = false;
    state.paused = true;
    await controller.closeVoicePanel();
    assert.equal(lifecycle.at(-1), 'stop', 'Pause must prevent wake rearm');
    state.paused = false;
    let finishStart;
    controller.setVoiceDeps({
      voiceListenStop: async () => { lifecycle.push('stop'); },
      voiceWakeSet: async () => { lifecycle.push('wake'); },
      voiceListenStart: () => new Promise(resolve => { finishStart = resolve; }),
    });
    const lateStart = controller.startVoice();
    await controller.closeVoicePanel();
    finishStart(10);
    await lateStart;
    assert.deepEqual(lifecycle.slice(-4), ['stop','wake','stop','wake']);
    console.log('PASS: actual Jev controller, nonblocking Shadow, threshold, grounded options, cancellation and opt-out.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
