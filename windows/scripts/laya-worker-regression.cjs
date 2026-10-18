// Choom Laya worker regression: runs the real private stdin/stdout worker
// against the staged offline runtime, then drives it with valid, malformed,
// oversized and unknown input, and checks the bounded route-label contract,
// the selected-distribution output, the no-text-leak rule, the manifest
// refusals and the clean EOF exit. No downloads, no network, no cloud.
// Run from windows/: node scripts/laya-worker-regression.cjs
//
// The staged runtime is ignored staging material (Codex-verified). When it is
// absent the suite reports a truthful skip instead of pretending a pass.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "voice-runtime", "choom-laya.py");
const RUNTIME = process.env.LAYA_RUNTIME_DIR
  || path.join(ROOT, "..", ".scratch", "laya-runtime");
const PYTHON = process.env.LAYA_PYTHON
  || path.join(RUNTIME, "venv", "Scripts", "python.exe");
const MODEL = path.join(RUNTIME, "model");
const MANIFEST = path.join(RUNTIME, "model-manifest.json");
const LABELS = ["answer", "options", "clarify", "supported_local", "unknown"];

const wait = (ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  timer.unref();
});
const ownedWorkers = [];

/** Spawns the worker and returns its protocol handle. Startup failures come
 *  back through `startup` (an event object or a rejection on exit). */
function spawnWorker(model, manifest) {
  const child = spawn(PYTHON, [WORKER, "--model", model, "--manifest", manifest], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      OMP_WAIT_POLICY: "PASSIVE",
      KMP_BLOCKTIME: "0",
    },
  });
  child.stderr.setEncoding("utf8");
  ownedWorkers.push(child);
  let stderrTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });

  const pending = new Map();
  const idless = [];
  const idlessWaiters = [];
  const events = [];
  const protocolErrors = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 32768) {
      protocolErrors.push("worker output exceeded protocol bound");
      child.kill();
      buffer = "";
      return;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) { index = buffer.indexOf("\n"); continue; }
      let obj = null;
      try { obj = JSON.parse(line); } catch { obj = { ok: false, error: "unparseable" }; }
      if (obj.error === "unparseable") protocolErrors.push("worker stdout contains invalid JSON");
      if (obj && obj.event) events.push(obj);
      if (obj && typeof obj.id === "number" && pending.has(obj.id)) {
        const resolve = pending.get(obj.id);
        pending.delete(obj.id);
        resolve(obj);
      } else if (obj && obj.ok === false) {
        if (idlessWaiters.length > 0) idlessWaiters.shift()(obj);
        else idless.push(obj);
      }
      index = buffer.indexOf("\n");
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    events,
    protocolErrors,
    stderrTail: () => stderrTail,
    exited,
    decide(text, generation) {
      const id = nextId++;
      const answer = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ cmd: "decide", id, generation, text })}\n`);
      return answer;
    },
    send(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    ask(obj) {
      const answer = new Promise((resolve) => pending.set(obj.id, resolve));
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return answer;
    },
    raw(line) {
      child.stdin.write(line + "\n");
    },
    nextIdless() {
      if (idless.length > 0) return Promise.resolve(idless.shift());
      return new Promise((resolve) => idlessWaiters.push(resolve));
    },
    async ready(ms = 120000) {
      const began = Date.now();
      while (Date.now() - began < ms) {
        const readyEvent = events.find((e) => e.ok && e.event === "ready");
        if (readyEvent) return { readyEvent, ms: Date.now() - began };
        const errorEvent = events.find((e) => e.ok === false && e.event === "error");
        if (errorEvent) throw new Error(`worker refused to start: ${errorEvent.message}`);
        if (child.exitCode != null) {
          throw new Error(`worker exited early (${child.exitCode}): ${stderrTail.slice(-400)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("worker never became ready");
    },
  };
}

async function main() {
  if (!fs.existsSync(PYTHON) || !fs.existsSync(MODEL) || !fs.existsSync(MANIFEST)) {
    console.log("laya worker regression: SKIPPED (staged runtime not present at "
      + `${RUNTIME}; set LAYA_RUNTIME_DIR to run it)`);
    return;
  }
  assert.ok(fs.existsSync(WORKER), "the worker source is committed with the app");

  // Startup refusals happen before any load: a tampered hash and a missing
  // model are both refused with a manifest reason and a non-zero exit.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-laya-tamper-"));
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.files["encoder/config.json"].sha256 = "0".repeat(64);
    const tamperedPath = path.join(tmp, "tampered.json");
    fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
    const tamperWorker = spawnWorker(MODEL, tamperedPath);
    const tamperStartup = await Promise.race([tamperWorker.ready(60000),
      tamperWorker.exited.then(() => ({ failed: true }))]).catch((err) => ({ failed: true, err }));
    assert.ok(tamperStartup.failed
      || tamperWorker.events.some((e) => e.ok === false && /hash mismatch/.test(e.message || "")),
    "a tampered hash is refused");
    const tamperCode = await Promise.race([tamperWorker.exited, wait(30000)]);
    assert.notEqual(tamperCode, 0, "a tampered model exits non-zero");
    assert.ok(tamperWorker.events.some((e) => /hash mismatch/.test(e.message || "")),
      `the refusal names the mismatch: ${JSON.stringify(tamperWorker.events)}`);
    // TamperWorker.exited already resolved; fine.

    const emptyModel = path.join(tmp, "empty-model");
    fs.mkdirSync(emptyModel, { recursive: true });
    const missingPath = path.join(tmp, "missing.json");
    fs.writeFileSync(missingPath, JSON.stringify(manifest));
    const missingWorker = spawnWorker(emptyModel, missingPath);
    await Promise.race([missingWorker.ready(60000).catch(() => {}), missingWorker.exited]);
    const missingCode = await Promise.race([missingWorker.exited, wait(30000)]);
    assert.notEqual(missingCode, 0, "a missing model exits non-zero");
    assert.ok(missingWorker.events.some((e) => /model file missing|manifest/i.test(e.message || "")),
      "the refusal names the missing file");

    // The real worker against the real staged model.
    const worker = spawnWorker(MODEL, MANIFEST);
    const startup = await worker.ready();
    assert.deepEqual(startup.readyEvent.labels, LABELS,
      "the worker announces the fixed five labels");
    assert.equal(startup.readyEvent.max_text, 500);
    console.log(`ready: validate+load+warmup ${startup.ms}ms `
      + `(model load reported ${startup.readyEvent.load_seconds}s)`);

    // Valid requests: the bounded route-label contract, five labels only,
    // the raw distribution and the selected label's own score. The entropy
    // confidence is never reported, and the request text never leaves.
    const cases = [
      { text: "create a note titled Trip plan", expect: ["supported_local", "clarify"] },
      { text: "open Notes", expect: ["supported_local", "options", "clarify"] },
      // Negation is owned by the deterministic grammar, which rejects it
      // before any model call. The uncalibrated checkpoint may mislabel it,
      // so the contract check here is structural, never an accuracy claim.
      { text: "do not open Notes", expect: null },
    ];
    const timings = [];
    for (const testCase of cases) {
      const began = Date.now();
      const response = await Promise.race([worker.decide(testCase.text, 7), wait(30000)]);
      timings.push({ label: response.label, seconds: (Date.now() - began) / 1000 });
      assert.equal(response.ok, true, `valid request accepted: ${JSON.stringify(response)}`);
      assert.equal(response.generation, 7, "generation is echoed exactly");
      assert.ok(LABELS.includes(response.label), `label ${response.label} is one of five`);
      if (testCase.expect) {
        assert.ok(testCase.expect.includes(response.label),
          `"${testCase.text}" routes to ${response.label}`);
      }
      for (const label of LABELS) {
        const value = response.probabilities[label];
        assert.equal(typeof value, "number", `probability for ${label} is present`);
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
      }
      assert.equal(response.selected_probability, response.probabilities[response.label],
        "selected probability IS the selected label's distribution score");
      assert.equal(response.confidence, undefined, "entropy confidence is never reported");
      assert.equal(response.answer_confidence, undefined,
        "raw model fields never enter the adapter contract");
      const flat = JSON.stringify(response);
      assert.ok(!flat.includes("note titled"), "the request text never leaves the worker");
      assert.ok(!flat.includes(testCase.text), "the raw request never appears in output");
    }
    console.log("timings:", JSON.stringify(timings));

    // Serial, in-order answers on one worker, one inference at a time.
    const [r1, r2] = await Promise.all([
      Promise.race([worker.decide("pause the music", 8), wait(30000)]),
      Promise.race([worker.decide("search the web for weather", 9), wait(30000)]),
    ]);
    assert.equal(r1.generation, 8);
    assert.equal(r2.generation, 9);
    assert.ok(LABELS.includes(r1.label) && LABELS.includes(r2.label));

    // Malformed JSON: an honest id-less refusal, and the worker keeps serving.
    worker.raw("this is not json");
    const malformed = await Promise.race([worker.nextIdless(), wait(30000)]);
    assert.equal(malformed.ok, false);
    assert.ok(/not valid JSON/.test(malformed.error));

    // Oversized input line: refused and drained in bounded chunks; the
    // worker stays responsive immediately afterwards.
    const oversizedLineBegan = Date.now();
    // A line past the worker's read cap: refused and drained, never loaded.
    worker.raw(`${JSON.stringify({ cmd: "decide", id: 99, generation: 10, text: "x" })} `
      + "y".repeat(9000));
    const lineRefusal = await Promise.race([worker.nextIdless(), wait(30000)]);
    assert.equal(lineRefusal.ok, false);
    assert.ok(/too long/.test(lineRefusal.error));
    const responsive = await Promise.race([worker.decide("open Notes", 14), wait(30000)]);
    assert.equal(responsive.ok, true,
      `worker still healthy ${Date.now() - oversizedLineBegan}ms after the oversized line`);

    // Oversized text inside a valid line: refused before any model call.
    const oversized = await Promise.race([worker.decide("x".repeat(501), 10), wait(30000)]);
    assert.equal(oversized.ok, false);
    assert.ok(oversized.error.includes("500"), "the bound names its limit");
    assert.equal(oversized.generation, 10, "even a refusal echoes its generation");

    // Unknown command: bounded refusal with its id, never a crash.
    const unknownResponse = await Promise.race([
      worker.ask({ cmd: "launch-missiles", id: 4242, generation: 11, text: "x" }),
      wait(30000),
    ]);
    assert.equal(unknownResponse.ok, false);
    assert.equal(unknownResponse.id, 4242, "the refusal echoes the id it could parse");
    assert.ok(unknownResponse.error.includes("unknown command"));

    // A wrong-shaped id: a bounded refusal, never a crash.
    worker.raw(JSON.stringify({ cmd: "decide", id: "not-a-number", generation: 12, text: "x" }));
    const badShape = await Promise.race([worker.nextIdless(), wait(30000)]);
    assert.equal(badShape.ok, false);
    assert.ok(/request id/.test(badShape.error));

    // EOF on stdin exits cleanly, promptly and with code 0.
    worker.child.stdin.end();
    const code = await Promise.race([worker.exited, wait(30000)]);
    assert.equal(code, 0, "EOF exits cleanly");

    assert.deepEqual(worker.protocolErrors, [], "stdout obeys the bounded JSON protocol");
    console.log("laya worker regression: all assertions passed");
  } finally {
    for (const child of ownedWorkers) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill();
        await Promise.race([closed, wait(10000)]);
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
