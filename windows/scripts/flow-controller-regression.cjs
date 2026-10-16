// Flow controller regression: the real production controller (registry,
// adapters, session context, generation fences) compiled against a fake
// delayed bridge and a fake state store. This exercises the actual
// planner/controller path with native-side-effect timing, not a pure model.
// Run from windows/: node scripts/flow-controller-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = [
  "src/choom/flow.ts",
  "src/choom/flowRegistry.ts",
  "src/choom/flowGrammar.ts",
  "src/choom/flowController.ts",
];

function compileOne(rel, tmp) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake bridge: records every call, supports per-command delays and a
 *  controllable media snapshot, and never swallows errors silently. */
function writeFakeBridge(tmp) {
  const code = `
const calls = [];
const delays = {};
const media = { snapshot: null, controlError: null, freeze: false };
const routine = { results: [] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function timed(cmd, payload) {
  calls.push({ cmd, payload });
  if (delays[cmd]) await wait(delays[cmd]);
  return null;
}
const Bridge = {
  flowNoteCreate: async (title, body, generation) => {
    await timed("note.create", { title, body, generation });
    return { title, path: "C:\\\\Notes\\\\" + title + ".md", bytes: body.length, createdMs: 1 };
  },
  flowNoteRename: async (fromPath, newTitle, generation) => {
    await timed("note.rename", { fromPath, newTitle, generation });
    return { title: newTitle, path: "C:\\\\Notes\\\\" + newTitle + ".md", bytes: 5, createdMs: 2 };
  },
  flowNoteOpen: async (openPath, generation) => timed("note.open", { path: openPath, generation }),
  flowBrowserSearch: async (query, generation) => {
    await timed("browser.search", { query, generation });
    return { url: "https://x.test/?q=" + query, dispatched: true, verified: false };
  },
  flowBrowserOpen: async (url, generation) => {
    await timed("browser.open", { url, generation });
    return { url, dispatched: true, verified: false };
  },
  voiceToolRun: async (kind, target, generation) => {
    await timed("tool.run", { kind, target, generation });
    return target;
  },
  mediaControl: async (action, positionMs, generation) => {
    await timed("media.control", { action, positionMs, generation });
    // A real control failure must surface, never read as success.
    if (media.controlError) throw new Error(media.controlError);
    // The snapshot reflects the control unless the player ignored it, which
    // is exactly the unchanged-snapshot case that must stay unverified.
    const now = media.snapshot;
    if (now && now.active && !media.freeze) {
      if (action === "pause") now.playing = false;
      else if (action === "play") now.playing = true;
      else if (action === "toggle") now.playing = !now.playing;
      else if (action === "next" || action === "previous") {
        now.title = now.title + " II";
        now.positionMs = 0;
      } else if (action === "seek") now.positionMs = positionMs ?? now.positionMs;
    }
    return null;
  },
  mediaSnapshot: async () => media.snapshot ? { ...media.snapshot } : null,
  toolsRoutineStart: async (routineId, steps, generation) => {
    await timed("routine.start", { routineId, steps, generation });
    return routine.results;
  },
};
module.exports = { Bridge, calls, delays, media, routine };
`;
  fs.mkdirSync(path.join(tmp, "src/core"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/core/bridge.js"), code);
}

function writeFakeState(tmp) {
  const code = `
const State = {
  settings: {
    flowEnabled: true,
    flowNotesFolder: "C:\\\\Notes",
    flowSearchEngine: "https://x.test/?q={q}",
    flowBrowser: "",
    flowEditor: "C:\\\\Tools\\\\editor.exe",
    tools: {
      colours: [],
      shortcuts: [
        { id: "notes", name: "Notes", kind: "app", target: "C:\\\\Apps\\\\notes.exe" },
        { id: "downloads", name: "Downloads", kind: "folder", target: "C:\\\\Users\\\\me\\\\Downloads" },
      ],
      routines: [
        { id: "r1", name: "Morning", steps: ["notes", "downloads"] },
      ],
    },
  },
};
module.exports = { State };
`;
  fs.mkdirSync(path.join(tmp, "src/core"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/core/state.js"), code);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-flow-controller-"));
  try {
    for (const rel of SOURCES) compileOne(rel, tmp);
    writeFakeBridge(tmp);
    writeFakeState(tmp);

    const ctl = require(path.join(tmp, "src/choom/flowController.js"));
    const G = require(path.join(tmp, "src/choom/flowGrammar.js"));
    const F = require(path.join(tmp, "src/choom/flow.js"));
    const fake = require(path.join(tmp, "src/core/bridge.js"));
    const StateMod = require(path.join(tmp, "src/core/state.js"));
    const registry = ctl.flowRegistry();
    // The grammar resolves launches against the saved shortcuts the same way
    // production does: through the controller's own settings view.
    const grammarCtx = { shortcuts: ctl.savedShortcuts(), notesConfigured: true, registry };
    const callsFor = (cmd) => fake.calls.filter((c) => c.cmd === cmd);

    function fresh(generation) {
      ctl.resetSession();
      ctl.clearNotePath();
      ctl.setVoiceGeneration(generation);
      ctl.setStaleCheck(null);
      fake.calls.length = 0;
    }
    const planOf = (request) => {
      const planned = F.planFromRequest(request, Date.now(), registry);
      assert.equal(planned.error, null);
      return planned.plan;
    };

    // Documented create then rename, through the actual grammar, planner and
    // controller. The rename targets this session's note by reference.
    fresh(5);
    {
      const parsed = G.parseFlowCommand(
        'create a note titled Draft that says "hello"', 5, grammarCtx);
      assert.equal(parsed.kind, "plan");
      ctl.rememberFlowRequest(parsed.request);
      const first = await ctl.runPlan(planOf(parsed.request));
      assert.deepEqual(first.steps.map((s) => s.state), ["completed"]);
      assert.equal(first.steps[0].evidence, "C:\\Notes\\Draft.md");
      assert.equal(callsFor("note.create")[0].payload.generation, 5,
        "the native note command carries the turn generation for its fence");
      assert.equal(ctl.notePath(), "C:\\Notes\\Draft.md");
      // The correction appends a distinct rename for the completed note.
      const corrected = ctl.correctFlowTurn("call it Final plan");
      assert.ok(corrected, "the correction applies to the last request");
      ctl.rememberFlowRequest(corrected.request);
      const second = await ctl.runPlan(planOf(corrected.request));
      assert.deepEqual(second.steps.map((s) => s.state), ["completed", "completed"]);
      const renames = callsFor("note.rename");
      assert.equal(renames.length, 1);
      assert.equal(renames[0].payload.fromPath, "C:\\Notes\\Draft.md");
      assert.equal(renames[0].payload.newTitle, "Final plan");
      assert.equal(second.steps[1].evidence, "C:\\Notes\\Final plan.md");
      assert.equal(ctl.notePath(), "C:\\Notes\\Final plan.md", "ownership follows the rename");
    }

    // Replay with preserved context: re-running the same plan never repeats a
    // dispatch, and note ownership is not cleared before the cumulative run.
    {
      const createsBefore = callsFor("note.create").length;
      const parsed = G.parseFlowCommand(
        'create a note titled Replay that says "body"', 5, grammarCtx);
      ctl.rememberFlowRequest(parsed.request);
      await ctl.runPlan(planOf(parsed.request));
      const again = await ctl.runPlan(planOf(parsed.request));
      assert.equal(callsFor("note.create").length, createsBefore + 1,
        "replay reuses the settled step");
      assert.deepEqual(again.steps.map((s) => s.state), ["completed"]);
      assert.equal(ctl.notePath(), "C:\\Notes\\Replay.md", "replay owns its own note");
      // A later spoken rename still resolves the session note, not nothing.
      const renameParsed = G.parseFlowCommand("rename note to Replayed", 5, grammarCtx);
      ctl.rememberFlowRequest(renameParsed.request);
      const renamed = await ctl.runPlan(planOf(renameParsed.request));
      assert.deepEqual(renamed.steps.map((s) => s.state), ["completed"]);
      assert.equal(callsFor("note.rename")[1].payload.fromPath, "C:\\Notes\\Replay.md");
      assert.equal(ctl.notePath(), "C:\\Notes\\Replayed.md");
    }

    // Stop before a queued native side effect: the create is in flight when
    // the turn is cancelled, and the queued search never reaches the bridge.
    fresh(6);
    {
      fake.delays["note.create"] = 20;
      const parsed = G.parseFlowCommand(
        'create a note titled Slow that says "x" then search for weather', 6, grammarCtx);
      const running = ctl.runPlan(planOf(parsed.request));
      await wait(5);
      ctl.cancelFlow();
      const receipt = await running;
      fake.delays["note.create"] = 0;
      assert.deepEqual(callsFor("note.create").map((c) => c.payload.title), ["Slow"]);
      assert.equal(callsFor("browser.search").length, 0, "the queued search never dispatches");
      assert.equal(receipt.stopped, true);
      const byKind = Object.fromEntries(receipt.steps.map((s) => [s.kind, s.state]));
      assert.equal(byKind["note.create"], "completed", "work already sent is accounted honestly");
      assert.equal(byKind["browser.search"], "cancelled");
    }

    // In-flight completion is dropped from session context: the receipt stays
    // honest, but a cancelled turn never owns the note it wrote.
    fresh(7);
    {
      fake.delays["note.create"] = 20;
      const parsed = G.parseFlowCommand(
        'create a note titled Gone that says "x"', 7, grammarCtx);
      const running = ctl.runPlan(planOf(parsed.request));
      await wait(5);
      ctl.cancelFlow();
      const receipt = await running;
      fake.delays["note.create"] = 0;
      assert.equal(receipt.steps[0].state, "completed", "the write happened and says so");
      assert.equal(ctl.notePath(), null, "the stale completion never owns a note");
      // Move the turn forward: a fresh turn may run, but it owns no note.
      ctl.setVoiceGeneration(8);
      const renameParsed = G.parseFlowCommand("rename note to Later", 8, grammarCtx);
      const renamed = await ctl.runPlan(planOf(renameParsed.request));
      assert.equal(renamed.steps[0].state, "failed");
      assert.ok(renamed.steps[0].message.includes("no note from this turn"));
      assert.equal(callsFor("note.rename").length, 0);
    }

    // The in-closure fence: cancellation lands after the queue's own check
    // but before the native call, and the blocking closure rechecks.
    fresh(8);
    {
      const parsed = G.parseFlowCommand(
        'create a note titled Fence that says "x"', 8, grammarCtx);
      const running = ctl.runPlan(planOf(parsed.request));
      // runPlan yields inside the executor before its bridge call; cancelling
      // here must still be seen by the recheck immediately before dispatch.
      ctl.cancelFlow();
      const receipt = await running;
      assert.equal(callsFor("note.create").length, 0, "no native call after the recheck");
      assert.equal(receipt.steps[0].state, "cancelled");
      assert.ok(receipt.steps[0].message.includes("Stopped before it ran"));
    }

    // The injected stale callback never bypasses Stop: both fences combine.
    fresh(9);
    {
      ctl.setStaleCheck(() => false);
      ctl.cancelFlow();
      const parsed = G.parseFlowCommand(
        'create a note titled Bypass that says "x"', 9, grammarCtx);
      const receipt = await ctl.runPlan(planOf(parsed.request));
      assert.equal(callsFor("note.create").length, 0);
      assert.equal(receipt.steps[0].state, "cancelled");
      ctl.setStaleCheck(null);
    }

    // Missing settings surface as unavailable, not as a blind dispatch.
    fresh(10);
    {
      StateMod.State.settings.flowNotesFolder = "";
      const parsed = G.parseFlowCommand(
        'create a note titled Blocked that says "x"', 10, grammarCtx);
      const receipt = await ctl.runPlan(planOf(parsed.request));
      assert.equal(receipt.steps[0].state, "failed");
      assert.ok(receipt.steps[0].message.includes("notes folder"));
      assert.equal(callsFor("note.create").length, 0);
      StateMod.State.settings.flowNotesFolder = "C:\\Notes";
      // A search engine without a {q} placeholder is unavailable with a reason.
      StateMod.State.settings.flowSearchEngine = "https://x.test/?s=";
      const search = G.parseFlowCommand("search for weather", 10, grammarCtx);
      const searchReceipt = await ctl.runPlan(planOf(search.request));
      assert.equal(searchReceipt.steps[0].state, "failed");
      assert.ok(searchReceipt.steps[0].message.includes("{q}"));
      StateMod.State.settings.flowSearchEngine = "https://x.test/?q={q}";
    }

    // Media runs through the queue and is verified only by a real pre/post
    // snapshot difference, never by dispatch acknowledgement.
    fresh(11);
    {
      const turn = (n) => { ctl.setVoiceGeneration(n); return n; };
      // pause: playing falls, the actual transition is the proof.
      fake.media.snapshot = { active: true, playing: true, positionMs: 0, title: "Song" };
      const paused = await ctl.runMediaFlow("pause", turn(11));
      assert.deepEqual(paused.receipt.steps.map((s) => s.state), ["completed"]);
      assert.ok(paused.receipt.steps[0].evidence.includes("Paused"));
      assert.equal(callsFor("media.control")[0].payload.generation, 11,
        "the media control carries the turn generation to the watcher fence");
      // pause while already paused: the snapshot is unchanged, so no state
      // change can be claimed and the receipt stays sent without proof.
      const pausedAgain = await ctl.runMediaFlow("pause", turn(111));
      assert.equal(pausedAgain.receipt.steps[0].state, "dispatched",
        "an unchanged active snapshot is never proof");
      // next: the track identity changed, which is the proof.
      fake.media.snapshot = { active: true, playing: true, positionMs: 0, title: "Song" };
      const next = await ctl.runMediaFlow("next", turn(112));
      assert.equal(next.receipt.steps[0].state, "completed");
      assert.ok(next.receipt.steps[0].evidence.includes("Track changed"));
      // next where the player ignores the command: unchanged identity and
      // position, so the dispatch stays unverified.
      fake.media.freeze = true;
      fake.media.snapshot = { active: true, playing: true, positionMs: 30000, title: "Song" };
      const ignored = await ctl.runMediaFlow("next", turn(113));
      assert.equal(ignored.receipt.steps[0].state, "dispatched",
        "an ignored next is never verified");
      const toggled = await ctl.runMediaFlow("toggle", turn(114));
      assert.equal(toggled.receipt.steps[0].state, "dispatched",
        "an unchanged playing state is never proof for toggle");
      fake.media.freeze = false;
      fake.media.snapshot = { active: true, playing: true, positionMs: 0, title: "Song" };
      const realToggle = await ctl.runMediaFlow("toggle", turn(115));
      assert.equal(realToggle.receipt.steps[0].state, "completed",
        "a flipped playing state is the toggle proof");
      // No media session: nothing to verify, nothing claimed.
      fake.media.snapshot = null;
      const noSession = await ctl.runMediaFlow("next", turn(116));
      assert.equal(noSession.receipt.steps[0].state, "dispatched",
        "no session means no proof");
      // A control failure is a failed receipt, never a swallowed null.
      fake.media.snapshot = { active: true, playing: true, positionMs: 0, title: "Song" };
      fake.media.controlError = "Media watcher refused the action.";
      const broke = await ctl.runMediaFlow("pause", turn(117));
      assert.equal(broke.receipt.steps[0].state, "failed");
      assert.ok(broke.receipt.steps[0].message.includes("refused"));
      fake.media.controlError = null;
      const bogus = await ctl.runMediaFlow("launch-missiles", turn(118));
      assert.equal(bogus.receipt, null);
      assert.ok(bogus.error.includes("not supported"));
    }

    // Routines run through the queue with the Run click's approval, their
    // resolved saved steps and their native cancellation untouched.
    fresh(12);
    {
      fake.routine.results = [{ id: "notes", status: "ok", message: "" },
        { id: "downloads", status: "ok", message: "" }];
      const ran = await ctl.runRoutineFlow("r1", 12);
      assert.deepEqual(ran.receipt.steps.map((s) => s.state), ["dispatched"]);
      const start = callsFor("routine.start");
      assert.equal(start.length, 1);
      assert.equal(start[0].payload.routineId, "r1");
      assert.equal(start[0].payload.generation, 12,
        "the routine run carries the turn generation to the native step fence");
      assert.deepEqual(start[0].payload.steps.map((s) => s.kind), ["app", "folder"]);
      // A missing routine fails before dispatch, with a reason.
      const gone = await ctl.runRoutineFlow("ghost", 12);
      assert.equal(gone.receipt.steps[0].state, "failed");
      assert.equal(callsFor("routine.start").length, 1, "the missing routine never dispatches");
      // A failed step inside the routine surfaces as a failed receipt. This
      // is a new turn, so nothing is memoized from the successful run above.
      ctl.setVoiceGeneration(123);
      fake.routine.results = [{ id: "notes", status: "failed", message: "Editor busy" }];
      const failed = await ctl.runRoutineFlow("r1", 123);
      assert.equal(failed.receipt.steps[0].state, "failed");
      assert.ok(failed.receipt.steps[0].message.includes("Editor busy"));
      fake.routine.results = [];
      ctl.setVoiceGeneration(12);
    }

    // note.open: unavailable without a configured editor, and dispatch-only
    // (never verified) with one, for the owned note only.
    fresh(13);
    {
      const parsed = G.parseFlowCommand('create a note titled Mine that says "x"', 13, grammarCtx);
      await ctl.runPlan(planOf(parsed.request));
      StateMod.State.settings.flowEditor = "";
      const openNoEditor = G.parseFlowCommand("open the note", 13, grammarCtx);
      const noEditor = await ctl.runPlan(planOf(openNoEditor.request));
      assert.equal(noEditor.steps[0].state, "failed");
      assert.ok(noEditor.steps[0].message.includes("editor"));
      assert.equal(callsFor("note.open").length, 0);
      StateMod.State.settings.flowEditor = "C:\\Tools\\editor.exe";
      const openParsed = G.parseFlowCommand("open the note", 13, grammarCtx);
      const opened = await ctl.runPlan(planOf(openParsed.request));
      assert.equal(opened.steps[0].state, "dispatched", "editor dispatch alone is unverified");
      assert.equal(opened.steps[0].verified, false);
      assert.equal(callsFor("note.open")[0].payload.path, "C:\\Notes\\Mine.md",
        "the open targets the owned note path");
      // A fresh turn with no note from this session is refused before
      // dispatch (the settled turn above is never re-run to prove this).
      ctl.clearNotePath();
      ctl.setVoiceGeneration(131);
      const openFresh = G.parseFlowCommand("open the note", 131, grammarCtx);
      const openAgain = await ctl.runPlan(planOf(openFresh.request));
      assert.equal(openAgain.steps[0].state, "failed");
      assert.ok(openAgain.steps[0].message.includes("no note from this turn"));
      assert.equal(callsFor("note.open").length, 1);
      ctl.setVoiceGeneration(13);
    }

    // Browser and app steps stay unverified end to end through the registry.
    fresh(14);
    {
      const parsed = G.parseFlowCommand("open Downloads then search for rain", 14, grammarCtx);
      const receipt = await ctl.runPlan(planOf(parsed.request));
      assert.deepEqual(receipt.steps.map((s) => s.state), ["dispatched", "dispatched"]);
      assert.ok(receipt.steps.every((s) => s.verified === false));
    }

    // The compact capability view separates ready from unavailable with
    // precise reasons.
    fresh(15);
    {
      const view = ctl.flowCapabilityView();
      const ids = view.supported.map((l) => l.id);
      for (const id of ["note.create", "note.rename", "note.open", "app.launch",
        "folder.open", "browser.search", "browser.open", "media.play", "routine.run"]) {
        assert.ok(ids.includes(id), `${id} is ready with the fixture settings`);
      }
      const unavailableIds = view.unavailable.map((l) => l.id);
      assert.ok(unavailableIds.includes("agent.chat"), "the inventory lists agent replies");
      assert.ok(unavailableIds.includes("dictation.capture"));
      StateMod.State.settings.flowNotesFolder = "";
      const degraded = ctl.flowCapabilityView();
      const noteLine = degraded.unavailable.find((l) => l.id === "note.create");
      assert.ok(noteLine && noteLine.reason.includes("notes folder"));
      StateMod.State.settings.flowNotesFolder = "C:\\Notes";
    }

    // A new listening session resets context once; nothing leaks across.
    fresh(16);
    {
      ctl.resetSession();
      assert.equal(ctl.notePath(), null, "a new session owns no note");
      const parsed = G.parseFlowCommand('create a note titled Fresh that says "x"', 16, grammarCtx);
      await ctl.runPlan(planOf(parsed.request));
      assert.equal(callsFor("note.create").length, 1);
      ctl.resetSession();
      assert.equal(ctl.notePath(), null, "session context resets only on a new session");
    }

    // Fix 1: opt-out stops a queued tail even without a separate cancel call.
    fresh(91);
    fake.delays["tool.run"] = 40;
    const offPlan = planOf({ generation: 91, steps: [
      { id: "off1", kind: "app.launch", target: "C:\\Apps\\notes.exe" },
      { id: "off2", kind: "folder.open", target: "C:\\Users\\me\\Downloads", after: ["off1"] },
    ] });
    const offRun = ctl.runPlan(offPlan);
    await wait(5);
    StateMod.State.settings.flowEnabled = false;
    const offReceipt = await offRun;
    assert.equal(callsFor("tool.run").length, 1, "disabled Flow never dispatches the tail");
    assert.equal(offReceipt.steps[1].state, "cancelled");
    StateMod.State.settings.flowEnabled = true;
    fake.delays["tool.run"] = 0;

    // Fix 4: an executing note cannot be retargeted by a correction.
    fresh(92);
    fake.delays["note.create"] = 40;
    const executing = G.parseFlowCommand('create a note titled First that says "hello"', 92, grammarCtx);
    ctl.rememberFlowRequest(executing.request);
    const executingRun = ctl.runPlan(planOf(executing.request));
    await wait(5);
    assert.equal(ctl.correctFlowTurn("call it Second"), null);
    await executingRun;
    assert.deepEqual(callsFor("note.create").map(c => c.payload.title), ["First"]);
    fake.delays["note.create"] = 0;

    // No banned sentence connectors in the controller copy.
    for (const rel of ["src/choom/flowController.ts", "src/choom/flowGrammar.ts",
      "src/choom/flowRegistry.ts", "src/choom/flow.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("flow controller regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
