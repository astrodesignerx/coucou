// Stable-clause tracker regression: the deterministic decision layer that
// turns continuous snapshots and sealed finals into Flow batches.
//
// Style A of this directory: transpile the real TypeScript into a temp tree
// with the project's own compiler, then require it. Nothing here mocks the
// tracker or the grammar; both are the production sources.
//
//   node scripts/flow-clause-regression.cjs

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
  "src/choom/flowClauseTracker.ts",
];

function compile(tmp) {
  for (const rel of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: rel,
    }).outputText;
    const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out, "utf8");
  }
}

const SHORT = [
  { id: "code", name: "Code", kind: "app", target: "C:\\apps\\code.exe" },
  { id: "mail", name: "Mail", kind: "app", target: "C:\\apps\\mail.exe" },
  { id: "notes", name: "Notes", kind: "folder", target: "D:\\work\\notes" },
];

function ctx(overrides) {
  return {
    shortcuts: SHORT,
    notesConfigured: true,
    registry: { has: () => true, get: () => null, list: () => [] },
    ...overrides,
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-clause-test-"));
  try {
    compile(tmp);
    const trackerMod = require(path.join(tmp, "src/choom/flowClauseTracker.js"));
    const { FlowClauseTracker, FlowAdmission, SNAPSHOT_STRIKES, MAX_PENDING_FLOW_BATCHES } = trackerMod;
    assert.equal(SNAPSHOT_STRIKES, 2, "the correction window is two newer snapshots");
    assert.equal(MAX_PENDING_FLOW_BATCHES, 4, "admission is bounded");

    const fresh = () => {
      const t = new FlowClauseTracker();
      t.begin(7, ctx());
      return t;
    };
    const stepKind = (steps) => steps.map((s) => s.kind);
    const stepTarget = (steps) => steps.map((s) => s.target);

    // 1. A single live caption is never enough: the speech may still change.
    let t = fresh();
    let v = t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    assert.equal(v.kind, "hold", "one caption cannot dispatch on its own");
    assert.equal(v.reason, "unstable");

    // 2. Two newer captions that agree on the same complete clause dispatch
    //    exactly once. The very first batch of an utterance has no anchor.
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    assert.equal(v.kind, "dispatch", "a stable clause prefix dispatches");
    assert.deepEqual(stepKind(v.steps), ["app.launch"]);
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe"]);
    assert.equal(v.steps[0].id, "c1-1", "the emitted step carries its own id");
    assert.deepEqual(v.steps[0].after, undefined, "the first step of an utterance has no dependency");

    // 3. A repeated identical caption runs the prefix once, never twice.
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code" });
    assert.equal(v.kind, "hold", "a repeated caption does not re-run anything");
    assert.equal(v.reason, "replayed");

    // 4. A final that only repeats what already ran commits nothing.
    v = t.observeFinal({ utterance: 1, sequence: 4, text: "open code" });
    assert.equal(v.kind, "hold", "the final never replays a submitted prefix");
    assert.equal(v.reason, "replayed");

    // 5. An unfinished saved target never runs from a live caption. The grammar
//    resolves "open co" to the saved "Code" by substring, which is correct
//    for a sealed utterance and wrong while speech is still arriving.
    t = fresh();
    for (const text of ["open", "open c", "open co", "open cod"]) {
      v = t.observePartial({ utterance: 1, sequence: 1, text });
      assert.notEqual(v.kind, "dispatch", `an unfinished target never runs from a caption: ${text}`);
    }
    for (const text of ["open", "open c", "open co", "open cod"]) {
      v = t.observePartial({ utterance: 1, sequence: 1, text });
      t.observePartial({ utterance: 1, sequence: 2, text });
      v = t.observePartial({ utterance: 1, sequence: 3, text });
      assert.notEqual(v.kind, "dispatch",
        `an unfinished target never runs from a repeated caption: ${text}`);
    }
    assert.deepEqual(t.emittedSteps(), [], "nothing was ever emitted for a half spoken name");
    // A sealed final is exempt: the utterance really is over, and the legacy
    // one-shot grammar is unchanged for it.
    t = fresh();
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "open co" });
    assert.equal(v.kind, "dispatch", "a sealed final keeps the legacy substring behaviour");
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe"]);

    // 5b. A provisional caption that has finished the name does dispatch.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    assert.equal(v.kind, "dispatch", "a fully spoken name is dispatchable from a caption");

    // 6. A negated command is refused with the grammar's own wording.
    t = fresh();
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "don't open code" });
    assert.equal(v.kind, "refuse");
    assert.match(v.message, /asked me not to/, "the refusal is the grammar's wording");

    // 7. An ambiguous target is refused, never guessed at.
    t = fresh();
    const ambiguous = ctx({
      shortcuts: [
        { id: "a", name: "Code", kind: "app", target: "C:\\a.exe" },
        { id: "b", name: "Code", kind: "folder", target: "D:\\b" },
      ],
    });
    t.begin(7, ambiguous);
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "open code" });
    assert.equal(v.kind, "refuse");
    assert.match(v.message, /Which saved target/, "an ambiguous target asks, it never picks");

    // 8. Quoted dictation runs the command and never the quoted words.
    t = fresh();
    v = t.observeFinal({ utterance: 1, sequence: 1, text: 'create a note called Trip saying "buy milk and eggs"' });
    assert.equal(v.kind, "dispatch");
    assert.deepEqual(stepKind(v.steps), ["note.create"]);
    assert.equal(v.steps[0].target, "Trip");
    assert.equal(v.steps[0].value, "buy milk and eggs", "the body is dictated text, not commands");

    // 9. A mixed unsupported clause runs nothing at all.
    t = fresh();
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "open code and then dance" });
    assert.equal(v.kind, "refuse");
    assert.match(v.message, /only part/, "a mixed request is clarified as a whole");

    // 10. A final extends an utterance without replaying the prefix. The
    //     batch re-states the already dispatched step as an anchor, so the
    //     dependency graph stays resolvable and a failure still stops it.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    let first = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    assert.equal(first.kind, "dispatch");
    v = t.observeFinal({ utterance: 1, sequence: 3, text: "open code and then open mail" });
    assert.equal(v.kind, "dispatch", "the final commits the extension");
    assert.deepEqual(stepKind(v.steps), ["app.launch", "app.launch"]);
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe", "C:\\apps\\mail.exe"]);
    assert.deepEqual(v.steps[1].after, ["c1-1"], "the extension depends on what ran before it");
    assert.equal(v.steps[0].id, "c1-1", "the anchor is the step that already ran");

    // Fix 5: a third clause includes all dependencies and reuses both receipts.
    {
      const F = require(path.join(tmp, "src/choom/flow.js"));
      const session = new F.FlowSession();
      const sent = [];
      const runner = { cancelled: () => false, dispatch: async step => { sent.push(step.id); return null; } };
      const tracker = fresh();
      tracker.observePartial({ utterance: 1, sequence: 1, text: "open code then open mail" });
      const prefix = tracker.observePartial({ utterance: 1, sequence: 2, text: "open code then open mail" });
      assert.equal(prefix.kind, "dispatch");
      const run = async batch => {
        const planned = F.planFromRequest({ generation: 7, steps: batch.steps });
        assert.equal(planned.error, null);
        return session.run(planned.plan, runner);
      };
      await run(prefix);
      const extension = tracker.observeFinal({ utterance: 1, sequence: 3,
        text: "open code then open mail then search for weather" });
      assert.equal(extension.kind, "dispatch");
      assert.equal(extension.steps.length, 3);
      await run(extension);
      assert.deepEqual(sent, ["c1-1", "c1-2", "c1-3"]);
    }

    // 11. The same command in two separate utterances runs once in each.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    const a = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    const b = t.observeFinal({ utterance: 2, sequence: 1, text: "open code" });
    assert.equal(a.kind, "dispatch");
    assert.equal(b.kind, "dispatch", "a new utterance starts clean");
    assert.equal(a.steps[0].id, "c1-1");
    assert.equal(b.steps[0].id, "c2-1", "a distinct utterance gets a distinct step id");

    // 12. Identity: stale, repeated and out-of-order snapshots are refused
    //     before the grammar or the queue ever sees them.
    t = fresh();
    t.observePartial({ utterance: 5, sequence: 4, text: "open code" });
    v = t.observePartial({ utterance: 5, sequence: 4, text: "open code" });
    assert.equal(v.kind, "hold");
    assert.equal(v.reason, "duplicate", "a repeated sequence is dropped");
    v = t.observePartial({ utterance: 5, sequence: 3, text: "open code" });
    assert.equal(v.kind, "hold");
    assert.equal(v.reason, "duplicate", "an out-of-order sequence is dropped");
    v = t.observePartial({ utterance: 4, sequence: 9, text: "open code" });
    assert.equal(v.kind, "hold");
    assert.equal(v.reason, "stale", "an older utterance is dropped");
    v = t.observeFinal({ utterance: 5, sequence: 4, text: "open code" });
    assert.equal(v.kind, "hold", "a final cannot reuse a snapshot's sequence");
    assert.equal(v.reason, "duplicate");

    // 13. Silence dispatches nothing at all.
    t = fresh();
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "   " });
    assert.equal(v.kind, "hold");
    assert.equal(v.reason, "no-speech");
    v = t.observeFinal({ utterance: 1, sequence: 2, text: "hello there" });
    assert.equal(v.kind, "not-flow", "ordinary speech is not a Flow command");

    // 14. Reset retires the session: nothing from before it may dispatch.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    t.reset();
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    assert.equal(v.kind, "hold", "a retired session dispatches nothing");
    assert.equal(v.reason, "no-speech");

    // 15. A caption that changes its clause restarts the correction window,
    //     so a half-spoken target never slips through on the first try.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open mail" });
    assert.equal(v.kind, "hold", "a changed clause restarts the window");
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open mail" });
    assert.equal(v.kind, "dispatch", "the new clause dispatches once it settles");
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\mail.exe"],
      "the clause that was replaced never ran, so there is nothing to anchor on");

    // 16. A caption that grows a second clause holds while the second clause
    //     is still unparseable, then commits it at the final.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code and then open ma" });
    assert.equal(v.kind, "hold", "a trailing half clause is never run from a caption");
    assert.equal(v.reason, "unstable");
    v = t.observeFinal({ utterance: 1, sequence: 4, text: "open code and then open mail" });
    assert.equal(v.kind, "dispatch");
    assert.deepEqual(stepTarget(v.steps).slice(-1), ["C:\\apps\\mail.exe"]);

    // 17. Bounded admission: the queue refuses past its bound rather than
    //     growing, and a new turn drops whatever the old one left behind.
    const admission = new FlowAdmission();
    assert.equal(admission.admit({ generation: 3, steps: [], text: "a" }), true);
    for (let i = 1; i < MAX_PENDING_FLOW_BATCHES; i++) {
      assert.equal(admission.admit({ generation: 3, steps: [], text: `b${i}` }), true);
    }
    assert.equal(admission.depth, MAX_PENDING_FLOW_BATCHES);
    assert.equal(admission.admit({ generation: 3, steps: [], text: "overflow" }), false,
      "the bound refuses new work instead of growing");
    assert.equal(admission.take().text, "a", "batches drain in spoken order");
    admission.setGeneration(4);
    assert.equal(admission.depth, 0, "a new turn drops the old turn's queue");
    admission.admit({ generation: 4, steps: [], text: "x" });
    admission.clear();
    assert.equal(admission.take(), null, "stop clears everything without running it");

    // 18. An unconfigured notes folder refuses a note clause instead of
    //     inventing a destination.
    t = new FlowClauseTracker();
    t.begin(7, ctx({ notesConfigured: false }));
    v = t.observeFinal({ utterance: 1, sequence: 1, text: "create a note called Trip" });
    assert.equal(v.kind, "refuse");
    assert.match(v.message, /notes folder/i);

    // 19. A growing prefix never lets a new tail clause ride in on the agreement
    //     of the clause before it. The first clause settles on its second
    //     sighting; the second needs its own second sighting.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open code and then open mail" });
    assert.equal(v.kind, "dispatch", "the settled leading clause runs");
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe"],
      "only the clause that earned its own window is admitted");
    assert.equal(t.emittedSteps().length, 1, "the new tail clause has not run");
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code and then open mail" });
    assert.equal(v.kind, "dispatch", "the tail clause runs once it settles on its own");
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe", "C:\\apps\\mail.exe"],
      "the batch re-anchors on the step that already ran");
    assert.deepEqual(v.steps[1].after, ["c1-1"], "the tail clause chains on the first");

    // 19b. A third clause in the same caption does not jump the queue either.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "open code and then open mail" });
    assert.equal(v.kind, "dispatch");
    assert.equal(t.emittedSteps().length, 1);
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code and then open mail and then open notes" });
    assert.equal(v.kind, "dispatch");
    assert.equal(t.emittedSteps().length, 2, "only the clause that settled is admitted");

    // 20. A note body introduced late is a new clause and has to settle on its
    //     own, so a half dictated body never becomes a note.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "create a note called Trip" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "create a note called Trip" });
    assert.equal(v.kind, "dispatch", "the title alone settles and runs");
    assert.equal(t.emittedSteps()[0].target, "Trip");
    assert.equal(t.emittedSteps()[0].value, "", "no body yet");
    v = t.observePartial({ utterance: 1, sequence: 3, text: 'create a note called Trip saying "pack socks' });
    assert.notEqual(v.kind, "dispatch", "a half spoken body never becomes a note");
    v = t.observePartial({ utterance: 1, sequence: 4, text: 'create a note called Trip saying "pack socks and charger"' });
    assert.equal(v.kind, "refuse", "a body that changes after the title ran is reported, not re-run");
    assert.match(v.message, /changed after part of it/, "the refusal explains itself in plain words");
    assert.equal(t.emittedSteps().length, 1, "no duplicate note is created for one utterance");
    assert.equal(t.emittedSteps()[0].value, "", "the step that ran keeps the body it actually had");

    // 21. A negation between two matching captions resets agreement, so the
    //     prefix cannot resume on the strength of sightings that were broken.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "don't open code" });
    assert.equal(v.kind, "hold", "a negation is never dispatched");
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code" });
    assert.equal(v.kind, "hold", "the broken chain starts the window over");
    assert.equal(v.reason, "unstable");
    v = t.observePartial({ utterance: 1, sequence: 4, text: "open code" });
    assert.equal(v.kind, "dispatch", "it settles again after a full fresh window");
    assert.equal(t.emittedSteps().length, 1);

    // 21b. Ordinary speech in between has the same effect: it is not Flow, so
    //      it breaks the chain rather than passing through it.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    v = t.observePartial({ utterance: 1, sequence: 2, text: "hello there" });
    assert.equal(v.kind, "not-flow");
    v = t.observePartial({ utterance: 1, sequence: 3, text: "open code" });
    assert.equal(v.kind, "hold", "agreement does not survive unrelated speech");
    v = t.observePartial({ utterance: 1, sequence: 4, text: "open code" });
    assert.equal(v.kind, "dispatch");

    // 22. A final that changed after a provisional dispatch never replays what
    //     already ran, and never silently drops the new clause either.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    const ran = t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    assert.equal(ran.kind, "dispatch");
    // The speaker changed their mind and added a different clause.
    v = t.observeFinal({ utterance: 1, sequence: 3, text: "open code and then open notes" });
    assert.equal(v.kind, "dispatch", "the changed final commits only what is new");
    assert.deepEqual(stepTarget(v.steps), ["C:\\apps\\code.exe", "D:\\work\\notes"]);
    // A final that now refuses the whole utterance still runs nothing new.
    t = fresh();
    t.observePartial({ utterance: 1, sequence: 1, text: "open code" });
    t.observePartial({ utterance: 1, sequence: 2, text: "open code" });
    v = t.observeFinal({ utterance: 1, sequence: 3, text: "open code and then dance" });
    assert.equal(v.kind, "refuse", "a final that refuses runs nothing new");
    assert.equal(t.emittedSteps().length, 1, "the already dispatched step is untouched");

    console.log("flow clause regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });