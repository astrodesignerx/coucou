// Flow controller regression: structured plans from typed requests, exact-once
// step ids, dependency ordering, receipts and generation ownership. Compiles
// the real controller module with the project's TypeScript, no microphone and
// no Tauri. Run from windows/: node scripts/flow-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["src/choom/flow.ts", "src/choom/flowRegistry.ts"];

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

/** Builds a runner that records dispatch order and returns scripted outcomes. */
function scriptedRunner(behaviour) {
  const calls = [];
  return {
    calls,
    dispatch: async (step, generation) => {
      calls.push({ id: step.id, kind: step.kind, generation });
      const rule = behaviour[step.id];
      if (typeof rule === "function") return rule(step, generation);
      if (rule && rule.error) throw new Error(rule.error);
      // An object rule may carry a side-effecting `rule` (for example, flip
      // cancellation mid-dispatch). Run it, then report its scripted evidence.
      if (rule && typeof rule.rule === "function") {
        const result = rule.rule(step, generation);
        if (typeof result === "string") return result;
      }
      return (rule && rule.evidence) || null;
    },
    cancelled: behaviour.cancelled || (() => false),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-flow-test-"));
  try {
    compile(tmp);
    const F = require(path.join(tmp, "src/choom/flow.js"));

    // Exact-once ids: the same request always plans the same ids, stable and
    // collision free, so a re-sent turn never renumbers its steps.
    const request = {
      generation: 4,
      steps: [
        { kind: "app.launch", target: "C:\\Tools\\notes.exe" },
        { kind: "note.create", target: "meeting notes", value: "buy milk" },
        { kind: "browser.search", target: "weather" },
      ],
    };
    const first = F.planFromRequest(request, 1000);
    const second = F.planFromRequest(request, 2000);
    assert.equal(first.error, null);
    assert.deepEqual(first.plan.steps.map((s) => s.id), ["f1", "f2", "f3"]);
    assert.deepEqual(second.plan.steps.map((s) => s.id), first.plan.steps.map((s) => s.id));
    assert.equal(first.plan.generation, 4);
    assert.equal(first.plan.createdAtMs, 1000);

    // Declared ids are honoured, and a duplicate id fails the whole plan.
    const declared = F.planFromRequest({
      generation: 1,
      steps: [
        { id: "alpha", kind: "note.create", target: "one" },
        { id: "beta", kind: "note.rename", target: "one", value: "two" },
      ],
    });
    assert.equal(declared.error, null);
    assert.deepEqual(declared.plan.steps.map((s) => s.id), ["alpha", "beta"]);
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [
        { id: "alpha", kind: "note.create", target: "one" },
        { id: "alpha", kind: "note.create", target: "two" },
      ],
    }).error, 'Step id "alpha" is used twice.');

    // Unsupported kinds and empty targets never plan.
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [{ kind: "shell.exec", target: "rm -rf /" }],
    }).error, "Step 1 uses an unsupported action.");
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [{ kind: "note.create", target: "   " }],
    }).error, "Step 1 has no target.");
    assert.equal(F.planFromRequest({ generation: 1, steps: [] }).error, "That request has no steps to run.");
    assert.equal(F.planFromRequest({ generation: 1, steps: Array.from({ length: 13 }, () => ({ kind: "note.create", target: "x" })) }).error, "A request can hold at most 12 steps.");
    assert.ok(F.isFlowStepKind("note.create") && !F.isFlowStepKind("note.delete"));

    // Dependency ordering: real edges reorder, independent steps keep spoken
    // order, and the tie-break stays deterministic.
    const ordered = F.planFromRequest({
      generation: 2,
      steps: [
        { kind: "browser.search", target: "rain", after: ["f2"] },
        { kind: "note.create", target: "list" },
        { kind: "app.launch", target: "C:\\Tools\\editor.exe" },
      ],
    });
    assert.equal(ordered.error, null);
    assert.deepEqual(ordered.plan.steps.map((s) => s.id), ["f2", "f1", "f3"]);
    assert.deepEqual(F.orderSteps(ordered.plan.steps).map((s) => s.id), ["f2", "f1", "f3"]);

    // Dangling and cyclic dependencies fail the whole plan, never a partial
    // run that guesses what the missing step meant.
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [{ kind: "note.create", target: "x", after: ["ghost"] }],
    }).error, "Step 1 waits on a step that is not in the request.");
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [
        { id: "a", kind: "note.create", target: "x", after: ["b"] },
        { id: "b", kind: "note.create", target: "y", after: ["a"] },
      ],
    }).error, "Those steps wait on each other in a loop.");
    assert.equal(F.planFromRequest({
      generation: 1,
      steps: [{ id: "solo", kind: "note.create", target: "x", after: ["solo"] }],
    }).error, "Step 1 cannot wait on itself.");

    // Generation ownership: a late plan or receipt never acts on a newer turn.
    assert.equal(F.isFlowStale(5, 4), true);
    assert.equal(F.isFlowStale(5, 5), false);

    // Happy path: steps run in order, evidence is preserved, none cancelled.
    const plan = F.planFromRequest({
      generation: 9,
      steps: [
        { kind: "app.launch", target: "C:\\Tools\\notes.exe" },
        { kind: "note.create", target: "meeting notes", value: "buy milk" },
      ],
    }).plan;
    const runner = scriptedRunner({
      f1: { evidence: "C:\\Tools\\notes.exe" },
      f2: { evidence: "C:\\Notes\\meeting-notes.md" },
    });
    const receipt = await F.runFlowPlan(plan, runner, () => 5000);
    assert.deepEqual(runner.calls.map((c) => c.id), ["f1", "f2"]);
    assert.equal(receipt.stopped, false);
    assert.equal(F.planSummary(receipt).completed, 2);
    assert.equal(receipt.steps[1].evidence, "C:\\Notes\\meeting-notes.md");
    assert.equal(F.formatPlanReceipt(receipt), "Ran 2 of 2 step(s).");

    // A failed step cancels its dependents without dispatching them, while an
    // independent branch still runs: the DAG, not a linear routine.
    const dag = F.planFromRequest({
      generation: 10,
      steps: [
        { id: "launch", kind: "app.launch", target: "editor.exe" },
        { id: "note", kind: "note.create", target: "draft", after: ["launch"] },
        { id: "search", kind: "browser.search", target: "term" },
        { id: "open", kind: "browser.open", target: "result", after: ["note"] },
      ],
    }).plan;
    const failing = scriptedRunner({
      launch: { error: "Could not launch editor.exe" },
      search: { evidence: "https://example.com" },
    });
    const failReceipt = await F.runFlowPlan(dag, failing, () => 0);
    const byId = Object.fromEntries(failReceipt.steps.map((s) => [s.id, s.state]));
    assert.equal(byId.launch, "failed");
    assert.equal(byId.note, "cancelled");
    assert.equal(byId.open, "cancelled");
    assert.equal(byId.search, "completed");
    assert.deepEqual(failing.calls.map((c) => c.id), ["launch", "search"]);
    const counts = F.planSummary(failReceipt);
    assert.deepEqual([counts.completed, counts.failed, counts.cancelled], [1, 1, 2]);
    assert.ok(F.formatPlanReceipt(failReceipt).includes("Stopped at launch"));

    // Stop: cancellation prevents every later dispatch at the next boundary,
    // and any already dispatched action is reported as what actually happened.
    let cancelled = false;
    const stopping = scriptedRunner({
      f1: {
        evidence: "C:\\Tools\\notes.exe",
        // The turn is cancelled while this dispatch is already in flight.
        rule: () => { cancelled = true; return "C:\\Tools\\notes.exe"; },
      },
      cancelled: () => cancelled,
    });
    const stopReceipt = await F.runFlowPlan(plan, stopping, () => 0);
    assert.deepEqual(stopping.calls.map((c) => c.id), ["f1"], "f2 must not dispatch after Stop");
    assert.equal(stopReceipt.stopped, true);
    const stopById = Object.fromEntries(stopReceipt.steps.map((s) => [s.id, s.state]));
    // f1 already ran, so it reports completed with its real evidence.
    assert.equal(stopById.f1, "completed");
    assert.equal(stopReceipt.steps[0].evidence, "C:\\Tools\\notes.exe");
    assert.equal(stopById.f2, "cancelled");
    assert.ok(F.formatPlanReceipt(stopReceipt).includes("stopped by you"));

    // A plan that is already stale before it starts dispatches nothing.
    const staleRunner = scriptedRunner({ cancelled: () => true });
    const staleReceipt = await F.runFlowPlan(plan, staleRunner, () => 0);
    assert.deepEqual(staleRunner.calls, []);
    assert.equal(staleReceipt.stopped, true);
    assert.ok(F.planSummary(staleReceipt).cancelled === 2);

    // Dispatch is generation-fenced end to end.
    const fenced = scriptedRunner({ f1: {}, f2: {} });
    await F.runFlowPlan(plan, fenced, () => 0);
    assert.ok(fenced.calls.every((c) => c.generation === 9));

    // Unverified dispatch: a resolved promise with no evidence is never a
    // verified success. It reads dispatched with verified false.
    const noProof = scriptedRunner({ f1: {}, f2: {} });
    const unverified = await F.runFlowPlan(plan, noProof, () => 0);
    assert.equal(unverified.steps[0].state, "dispatched");
    assert.equal(unverified.steps[0].verified, false);
    assert.equal(unverified.steps[0].evidence, null);
    assert.ok(F.formatPlanReceipt(unverified).includes("sent without proof"));
    // A step that returned real evidence is completed and verified.
    assert.equal(receipt.steps[0].state, "completed");
    assert.equal(receipt.steps[0].verified, true);

    // A dispatched dependency still unblocks its dependent: the action was
    // sent, even without destination proof. Only failure and cancellation
    // block the next step.
    assert.equal(F.dependencySatisfied("completed"), true);
    assert.equal(F.dependencySatisfied("dispatched"), true);
    assert.equal(F.dependencySatisfied("failed"), false);
    assert.equal(F.dependencySatisfied("cancelled"), false);
    assert.equal(F.dependencySatisfied("pending"), false);
    const chain = F.planFromRequest({
      generation: 20,
      steps: [
        { id: "launch", kind: "app.launch", target: "editor.exe" },
        { id: "note", kind: "note.create", target: "draft", after: ["launch"] },
      ],
    }).plan;
    const chainRunner = scriptedRunner({ launch: {}, note: { evidence: "C:\\n.md" } });
    const chainReceipt = await F.runFlowPlan(chain, chainRunner, () => 0);
    assert.deepEqual(chainRunner.calls.map((c) => c.id), ["launch", "note"]);
    assert.equal(chainReceipt.steps[0].state, "dispatched");
    assert.equal(chainReceipt.steps[1].state, "completed");

    // Correction 1: session-owned execution tracking. Replaying the same plan
    // on one session must not dispatch anything a second time.
    const shared = new F.FlowSession();
    const replayRunner = scriptedRunner({ f1: { evidence: "a" }, f2: { evidence: "b" } });
    const one = await F.runFlowPlan(plan, replayRunner, () => 0, shared);
    const two = await F.runFlowPlan(plan, replayRunner, () => 0, shared);
    assert.deepEqual(replayRunner.calls.map((c) => c.id), ["f1", "f2"], "replay must not redispatch");
    assert.equal(F.planSummary(two).completed, 2, "replay reuses the settled receipts");
    assert.equal(two.steps[0].evidence, one.steps[0].evidence);

    // Concurrent replay: two overlapping runs share the in-flight dispatch,
    // so each action still fires exactly once.
    const sharedConcurrent = new F.FlowSession();
    let releaseF1;
    const gate = new Promise((r) => { releaseF1 = r; });
    const concurrentCalls = [];
    const concurrentRunner = {
      calls: concurrentCalls,
      dispatch: async (step, generation) => {
        concurrentCalls.push({ id: step.id, generation });
        if (step.id === "f1") await gate;
        return `ev-${step.id}`;
      },
      cancelled: () => false,
    };
    const p1 = F.runFlowPlan(plan, concurrentRunner, () => 0, sharedConcurrent);
    const p2 = F.runFlowPlan(plan, concurrentRunner, () => 0, sharedConcurrent);
    // Let both runs progress, then release the held f1 dispatch.
    await new Promise((r) => setTimeout(r, 5));
    releaseF1();
    const [cr1, cr2] = await Promise.all([p1, p2]);
    assert.deepEqual(concurrentCalls.map((c) => c.id), ["f1", "f2"], "concurrent runs share dispatches");
    assert.equal(F.planSummary(cr1).completed, 2);
    assert.equal(F.planSummary(cr2).completed, 2);

    // Cumulative speech plan: extending a run with steps that reuse already
    // completed ones dispatches only the new step.
    const sharedCumulative = new F.FlowSession();
    const cumulativeRunner = scriptedRunner({
      f1: { evidence: "C:\\Tools\\notes.exe" },
      f2: { evidence: "C:\\n.md" },
      f3: { evidence: "https://example.com" },
    });
    const firstTurn = F.planFromRequest({
      generation: 30,
      steps: [
        { kind: "app.launch", target: "C:\\Tools\\notes.exe" },
        { kind: "note.create", target: "meeting notes" },
      ],
    }).plan;
    await F.runFlowPlan(firstTurn, cumulativeRunner, () => 0, sharedCumulative);
    // The next spoken clause adds a search on top of the same session ids.
    const extendedTurn = F.planFromRequest({
      generation: 30,
      steps: [
        { kind: "app.launch", target: "C:\\Tools\\notes.exe" },
        { kind: "note.create", target: "meeting notes" },
        { kind: "browser.search", target: "weather" },
      ],
    }).plan;
    const extendedReceipt = await F.runFlowPlan(extendedTurn, cumulativeRunner, () => 0, sharedCumulative);
    assert.deepEqual(cumulativeRunner.calls.map((c) => c.id), ["f1", "f2", "f3"], "only the new step dispatches");
    assert.deepEqual(extendedReceipt.steps.map((s) => s.state), ["completed", "completed", "completed"]);

    // Keyed per generation, not globally by f1: a new turn reuses f1 cleanly.
    const otherTurn = F.planFromRequest({
      generation: 31,
      steps: [{ kind: "app.launch", target: "C:\\Tools\\notes.exe" }],
    }).plan;
    const freshRunner = scriptedRunner({ f1: { evidence: "again" } });
    const otherReceipt = await F.runFlowPlan(otherTurn, freshRunner, () => 0, sharedCumulative);
    assert.deepEqual(freshRunner.calls.map((c) => c.id), ["f1"], "a new generation dispatches its own f1");
    assert.equal(otherReceipt.steps[0].state, "completed");

    // A fresh session starts empty: even though `shared` already ran this
    // exact plan, a new session dispatches it fully again. Ownership is per
    // session, so nothing leaks across them.
    const brandNew = new F.FlowSession();
    const resetRunner = scriptedRunner({ f1: { evidence: "a" }, f2: { evidence: "b" } });
    const resetReceipt = await F.runFlowPlan(plan, resetRunner, () => 0, brandNew);
    assert.deepEqual(resetRunner.calls.map((c) => c.id), ["f1", "f2"], "a fresh session reruns");
    assert.equal(F.planSummary(resetReceipt).completed, 2);
    // And a second call on that same session then reuses, not reruns.
    await F.runFlowPlan(plan, resetRunner, () => 0, brandNew);
    assert.deepEqual(resetRunner.calls.map((c) => c.id), ["f1", "f2"], "the same session then reuses");

    // A failed step is memoized as failed, so replay reports it without a
    // second dispatch attempt.
    const sharedFail = new F.FlowSession();
    const failOnce = scriptedRunner({
      launch: { error: "Could not launch editor.exe" },
      search: { evidence: "https://example.com" },
    });
    const failA = await F.runFlowPlan(dag, failOnce, () => 0, sharedFail);
    const failB = await F.runFlowPlan(dag, failOnce, () => 0, sharedFail);
    assert.deepEqual(failOnce.calls.map((c) => c.id), ["launch", "search"], "failed steps are not retried on replay");
    assert.equal(F.planSummary(failA).failed, 1);
    assert.equal(F.planSummary(failB).failed, 1);

    // Capability driven queue: the registry carries readiness, approval and
    // the verification policy. Registering a new capability works without
    // touching the queue, and its declared policy decides the receipt.
    const FR = require(path.join(tmp, "src/choom/flowRegistry.js"));
    const registry = FR.createBaseFlowRegistry();
    const dispatched = [];
    registry.register({
      id: "test.echo",
      category: "system",
      label: "Test echo",
      offline: true,
      verification: "readback",
      validate: (step) => (step.target ? { ok: true } : { ok: false, reason: "it has no target." }),
      readiness: () => ({ ready: true }),
      approval: "none",
      execute: async (step, _ctx, generation) => {
        dispatched.push({ id: step.id, generation });
        return `echo:${step.target}`;
      },
    });
    const regPlan = F.planFromRequest({
      generation: 40,
      steps: [{ kind: "test.echo", target: "hi" }],
    }, Date.now(), registry);
    assert.equal(regPlan.error, null, "a registered capability plans without core edits");
    const regRunner = {
      registry,
      context: () => FR.defaultFlowContext(),
      cancelled: () => false,
    };
    const regReceipt = await F.runFlowPlan(regPlan.plan, regRunner, () => 0);
    assert.deepEqual(dispatched.map((d) => d.id), ["f1"], "the registered executor runs");
    assert.equal(regReceipt.steps[0].state, "completed", "readback proof completes a step");
    // A dispatch-policy capability never reports verified, even with a string
    // back: app and browser dispatch alone is not destination proof.
    const dispatchRegistry = FR.createBaseFlowRegistry();
    dispatchRegistry.bind("app.launch", async () => "C:\\Tools\\notes.exe");
    const launchPlan = F.planFromRequest({
      generation: 41,
      steps: [{ kind: "app.launch", target: "C:\\Tools\\notes.exe" }],
    }, Date.now(), dispatchRegistry);
    const launchRunner = {
      registry: dispatchRegistry,
      context: () => ({
        settings: { flowNotesFolder: "", flowSearchEngine: "", flowBrowser: "", flowEditor: "" },
        shortcuts: [{ id: "a", name: "Notes", kind: "app", target: "C:\\Tools\\notes.exe" }],
        routines: [],
        online: true,
      }),
      cancelled: () => false,
    };
    const launchReceipt = await F.runFlowPlan(launchPlan.plan, launchRunner, () => 0);
    assert.equal(launchReceipt.steps[0].state, "dispatched", "app dispatch alone stays unverified");
    assert.equal(launchReceipt.steps[0].verified, false);
    // An unregistered action fails before dispatch, never partway.
    const unknown = F.planFromRequest({
      generation: 42,
      steps: [{ kind: "shell.exec", target: "rm -rf /" }],
    }, Date.now(), registry);
    assert.equal(unknown.error, "Step 1 uses an unsupported action.");
    // An explicit-approval step without its click waits, and the wait is not
    // memoized: the click later resumes without repeating settled steps.
    const approvalRegistry = FR.createBaseFlowRegistry();
    let routineRuns = 0;
    approvalRegistry.bind("routine.run", async () => { routineRuns += 1; return null; });
    approvalRegistry.bind("app.launch", async () => null);
    const routinePlan = F.planFromRequest({
      generation: 43,
      steps: [{ kind: "routine.run", target: "r1" }, { kind: "app.launch", target: "C:\\a.exe" }],
    }, Date.now(), approvalRegistry);
    const routineCtx = () => ({
      settings: { flowNotesFolder: "", flowSearchEngine: "", flowBrowser: "", flowEditor: "" },
      shortcuts: [{ id: "a", name: "A", kind: "app", target: "C:\\a.exe" }],
      routines: [{ id: "r1", name: "Morning", steps: [] }],
      online: true,
    });
    const approvalSession = new F.FlowSession();
    const approvalRunner = { registry: approvalRegistry, context: routineCtx, cancelled: () => false };
    const refused = await F.runFlowPlan(routinePlan.plan, approvalRunner, () => 0, approvalSession);
    assert.equal(refused.steps[0].state, "awaiting", "no click means waiting, not running");
    assert.equal(routineRuns, 0, "confirmation refusal dispatches nothing");
    assert.ok(F.formatPlanReceipt(refused).includes("waiting for your click"));
    // The same session, now with the click granted, resumes: the launch step
    // already settled and is reused, the routine runs once.
    const approving = { registry: approvalRegistry, context: routineCtx, cancelled: () => false,
      approved: (step) => step.kind === "routine.run" };
    const approvedReceipt = await F.runFlowPlan(routinePlan.plan, approving, () => 0, approvalSession);
    assert.equal(routineRuns, 1, "the approved routine runs exactly once");
    assert.deepEqual(approvedReceipt.steps.map((s) => s.state), ["dispatched", "dispatched"]);

    // Offline is per capability: a network capability stays unavailable with
    // a reason, while a local one still runs.
    const offlineRegistry = FR.createBaseFlowRegistry();
    const offlineCtx = () => ({
      settings: { flowNotesFolder: "C:\\Notes", flowSearchEngine: "https://x.test/?q={q}", flowBrowser: "", flowEditor: "" },
      shortcuts: [],
      routines: [],
      online: false,
    });
    const searchPlan = F.planFromRequest({
      generation: 44,
      steps: [{ kind: "browser.search", target: "weather" }],
    }, Date.now(), offlineRegistry);
    const offlineSearch = await F.runFlowPlan(searchPlan.plan,
      { registry: offlineRegistry, context: offlineCtx, cancelled: () => false }, () => 0);
    assert.equal(offlineSearch.steps[0].state, "failed");
    assert.ok(offlineSearch.steps[0].message.includes("internet"), "offline names the reason");
    const notePlan = F.planFromRequest({
      generation: 45,
      steps: [{ kind: "note.create", target: "offline note" }],
    }, Date.now(), offlineRegistry);
    offlineRegistry.bind("note.create", async () => "C:\\Notes\\offline-note.md");
    const offlineNote = await F.runFlowPlan(notePlan.plan,
      { registry: offlineRegistry, context: offlineCtx, cancelled: () => false }, () => 0);
    assert.equal(offlineNote.steps[0].state, "completed", "a local capability works offline");

    // A generic error raised after the side effect was already sent, while
    // Stop lands, stays a failed receipt: only the executor's own explicit
    // pre-dispatch cancellation signal may claim the step never ran. The
    // failure is memoized and never auto-replayed.
    let sentOnce = 0;
    let midFlight = false;
    const postDispatchRunner = scriptedRunner({
      f1: async () => {
        sentOnce += 1;
        midFlight = true;
        throw new Error("Verification failed after Stop");
      },
      cancelled: () => midFlight,
    });
    const postSession = new F.FlowSession();
    const postA = await F.runFlowPlan(plan, postDispatchRunner, () => 0, postSession);
    assert.equal(postA.steps[0].state, "failed",
      "a post-dispatch error is a failure, never a claimed stop");
    assert.ok(postA.steps[0].message.includes("Verification failed after Stop"));
    assert.equal(postA.stopped, true, "the turn still reports it was stopping");
    const postB = await F.runFlowPlan(plan, postDispatchRunner, () => 0, postSession);
    assert.equal(postB.steps[0].state, "failed", "no auto replay of the failure");
    assert.equal(sentOnce, 1, "the failed dispatch is never retried");
    // Only the explicit pre-dispatch signal reads as stopped.
    assert.equal(F.isFlowPreDispatchCancelled(new F.FlowPreDispatchCancelled()), true);
    assert.equal(F.isFlowPreDispatchCancelled(new Error("boom")), false);
    assert.equal(F.isFlowPreDispatchCancelled(null), false);

    const progressPlan = F.planFromRequest({ generation: 90, steps: [{ kind: "note.create", target: "Progress" }] }).plan;
    const progressSession = new F.FlowSession();
    const progressRunner = scriptedRunner({});
    const progress = [];
    progressRunner.onStep = (step, receipt) => {
      if (!receipt) assert.equal(progressSession.statesFor(90)[step.id], "running",
        "executing identity is published before the progress callback or native dispatch");
      progress.push([step.id, receipt?.state ?? "running"]);
    };
    await F.runFlowPlan(progressPlan, progressRunner, () => 0, progressSession);
    await F.runFlowPlan(progressPlan, progressRunner, () => 0, progressSession);
    assert.equal(progress.length, 2, "current action and final receipt each appear once, including replay");
    assert.equal(progress[0][1], "running");
    assert.notEqual(progress[1][1], "running");
    assert.equal(progressRunner.calls.length, 1);

    // No banned sentence connectors in the new Flow copy.
    for (const rel of ["src/choom/flow.ts", "src/choom/flowRegistry.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("flow regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
