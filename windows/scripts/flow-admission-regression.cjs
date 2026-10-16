// Global Flow admission regression.
//
// FlowSession is the single executor for continuous speech, routines, typed
// commands, media and direct tool routes. This suite proves that they all
// share ONE bounded, ordered admission rather than running concurrently, and
// that the existing guarantees survive it: a concurrent replay of the same
// plan joins instead of duplicating, Stop cancels what is still waiting, a
// failed predecessor still stops its dependents, and going past the bound is
// an honest refusal rather than an unbounded promise chain.
//
//   node scripts/flow-admission-regression.cjs

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
    fs.writeFileSync(dest, out, "utf8");
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-admission-test-"));
  try {
    compile(tmp);
    const { FlowSession, MAX_QUEUED_PLANS, planFromRequest } = require(path.join(tmp, "src/choom/flow.js"));
    assert.ok(MAX_QUEUED_PLANS >= 1, "the admission bound is a real number");

    const planFor = (generation, id, kind = "app.launch", extra = {}) => {
      const plan = planFromRequest(
        { generation, steps: [{ id, kind, target: `fixture-${id}`, ...extra }] },
        Date.now(),
      ).plan;
      assert.ok(plan, "the fixture plan plans");
      return plan;
    };

    // ── 1. Two independent plans on one session never overlap ───────────────
    // This is the shared executor: whatever admitted these two, the side
    // effects must not interleave.
    {
      const session = new FlowSession();
      let active = 0;
      let max = 0;
      let release;
      let started;
      const first = new Promise((r) => { started = r; });
      const gate = new Promise((r) => { release = r; });
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async (step) => {
          active += 1;
          max = Math.max(max, active);
          if (step.id === "a") { started(); await gate; }
          active -= 1;
          return "verified fixture";
        },
      };
      const a = session.run(planFor(1, "a"), runner);
      await first;
      const b = session.run(planFor(1, "b"), runner);
      await wait(30);
      assert.equal(max, 1, "the queue orders distinct plans, including speech and routine callers");
      release();
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.steps[0].state, "completed");
      assert.equal(rb.steps[0].state, "completed", "the queued plan runs after the first finishes");
      assert.equal(session.queued, 0, "the queue drains back to empty");
    }

    // ── 2. Ordering is spoken order, not call order ─────────────────────────
    {
      const session = new FlowSession();
      const order = [];
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async (step) => {
          await wait(step.id === "first" ? 25 : 0);
          order.push(step.id);
          return "ok";
        },
      };
      const first = session.run(planFor(2, "first"), runner);
      await wait(2);
      const second = session.run(planFor(2, "second"), runner);
      const third = session.run(planFor(2, "third"), runner);
      await Promise.all([first, second, third]);
      assert.deepEqual(order, ["first", "second", "third"],
        "a slower plan cannot overtake the ones admitted before it");
    }

    // ── 3. A concurrent replay of the SAME plan joins instead of duplicating ─
    {
      const session = new FlowSession();
      let dispatches = 0;
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async () => {
          dispatches += 1;
          await wait(10);
          return "once";
        },
      };
      const plan = planFor(3, "only");
      const [x, y] = await Promise.all([session.run(plan, runner), session.run(plan, runner)]);
      assert.equal(dispatches, 1, "replaying one plan never dispatches its step twice");
      assert.equal(x.steps[0].state, "completed");
      assert.equal(y.steps[0].state, "completed", "the replay reuses the memoized receipt");
    }

    // ── 4. Stop while waiting cancels the queued plan, it does not run ──────
    {
      const session = new FlowSession();
      let cancelled = false;
      let dispatches = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      let started;
      const first = new Promise((r) => { started = r; });
      const runner = {
        cancelled: () => cancelled,
        approved: () => true,
        dispatch: async (step) => {
          dispatches += 1;
          if (step.id === "hold") { started(); await gate; }
          return "ok";
        },
      };
      const running = session.run(planFor(4, "hold"), runner);
      await first;
      const waiting = session.run(planFor(4, "later"), runner);
      cancelled = true;
      release();
      const receipt = await waiting;
      assert.equal(dispatches, 1, "the queued plan is never dispatched after a Stop");
      assert.equal(receipt.steps[0].state, "cancelled");
      assert.equal(receipt.stopped, true, "the receipt says the run was stopped, not successful");
      await running;
    }

    // ── 5. A failed predecessor still stops its dependent ───────────────────
    {
      const session = new FlowSession();
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async (step) => {
          if (step.id === "f1") throw new Error("fixture failure");
          return "ok";
        },
      };
      const plan = planFromRequest({
        generation: 5,
        steps: [
          { id: "f1", kind: "app.launch", target: "a" },
          { id: "f2", kind: "app.launch", target: "b", after: ["f1"] },
        ],
      }, Date.now()).plan;
      const receipt = await session.run(plan, runner);
      assert.equal(receipt.steps[0].state, "failed");
      assert.equal(receipt.steps[1].state, "cancelled",
        "a dependency that failed still stops what depended on it");
    }

    // ── 6. The bound refuses honestly instead of growing ───────────────────
    {
      const session = new FlowSession();
      let release;
      const gate = new Promise((r) => { release = r; });
      let started;
      const first = new Promise((r) => { started = r; });
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async (step) => {
          if (step.id === "head") { started(); await gate; }
          return "ok";
        },
      };
      const head = session.run(planFor(6, "head"), runner);
      await started;
      const pending = [];
      for (let i = 0; i < MAX_QUEUED_PLANS; i++) pending.push(session.run(planFor(6, `q${i}`), runner));
      assert.equal(session.queued, MAX_QUEUED_PLANS, "the queue holds exactly the bound");
      const overflow = await session.run(planFor(6, "overflow"), runner);
      assert.equal(overflow.steps[0].state, "failed", "going past the bound is refused, never queued");
      assert.match(overflow.steps[0].message, /Too many actions/, "the refusal says why");
      assert.equal(session.queued, MAX_QUEUED_PLANS, "a refused plan does not occupy a slot");
      release();
      await Promise.all([head, ...pending]);
      assert.equal(session.queued, 0);
    }

    // ── 7. An idle session is not slowed by the gate ────────────────────────
    {
      const session = new FlowSession();
      let entered = false;
      const runner = {
        cancelled: () => false,
        approved: () => true,
        dispatch: async () => { entered = true; return "ok"; },
      };
      const running = session.run(planFor(7, "only"), runner);
      // The body starts on the same tick, exactly as it did before admission
      // existed, so an idle session gains no scheduling hop.
      assert.equal(entered, true, "an idle session starts the plan immediately");
      await running;
    }

    console.log("flow admission regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });