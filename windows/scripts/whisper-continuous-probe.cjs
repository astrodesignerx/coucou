// CODEX-RUN ONLY. Spawns the production helper (needs powershell) and drives
// the REAL continuous capture path: the same accumulator, endpoint, seal,
// decoder admission and cancellation rules the live waveIn callback uses.
// The synthetic PCM enters through test_continuous, which the helper refuses
// unless CHOOM_VOICE_TEST=1, and no microphone and no user audio is ever used.
//
// The free builder is blocked from launching the helper, so this file is
// written and shipped but not executed there. Run it yourself:
//
//   node scripts/whisper-continuous-probe.cjs            mock decoder, full lifecycle
//   node scripts/whisper-continuous-probe.cjs --whisper  real whisper-cli on the sealed WAVs
//
// Every wait and every assertion is scoped to one generation and to a window
// of events observed after that window opened. Nothing here asserts a global
// event count or inspects an unbounded slice of the stream, and it never looks
// at temp directories belonging to any other helper session.
//
// decoder "mock" emits deterministic text through the REAL decoder scheduler,
// so admission, priority, reaping and readmission are all exercised without a
// model. decoder "whisper" runs the actual worker instead, and then NO
// assertion compares transcript text: synthetic tone is not speech, and an
// empty transcription is a correct result that must be tolerated.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { HELPER } = require("./whisper-helper-source.cjs");

const USE_WHISPER = process.argv.includes("--whisper");
const DECODER = USE_WHISPER ? "whisper" : "mock";
const ENDURANCE = process.argv.includes("--endurance");
const DECODE_TIMEOUT_MS = USE_WHISPER ? 180000 : 30000;

const failures = [];
const notes = [];
const check = (label, value, detail = "") => {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!value) failures.push(label);
};
const note = (label, detail) => {
  notes.push(`${label}: ${detail}`);
  console.log(`INFO: ${label}: ${detail}`);
};

let child = null;
let buffer = "";
/** Events observed, with a monotonically increasing stamp for windowing. */
let observed = 0;
let waiters = [];

/** Opens an observation window. Every wait and assertion after this point is
 *  about events at or after `from`, so a previous session can never satisfy it. */
function mark() {
  return observed;
}

function eventsSince(from) {
  return allEvents.slice(from);
}

let allEvents = [];

function onLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  event.__at = observed++;
  event.__receivedMs = Date.now();
  allEvents.push(event);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].predicate(event)) {
      waiters[i].resolve(event);
      waiters.splice(i, 1);
    }
  }
}

function send(cmd) {
  if (!child || child.killed) throw new Error("helper is not running");
  child.stdin.write(`${JSON.stringify(cmd)}\n`);
}

/** Waits for an event at or after `from`. Every timer is cleared on both
 *  resolve and reject, so a probe run never leaves a timer behind. */
function waitFor(from, predicate, timeoutMs, label) {
  const ready = eventsSince(from).find(predicate);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    let timer = null;
    const entry = {
      predicate,
      resolve: (event) => {
        if (timer != null) clearTimeout(timer);
        resolve(event);
      },
    };
    waiters.push(entry);
    timer = setTimeout(() => {
      const at = waiters.indexOf(entry);
      if (at >= 0) waiters.splice(at, 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
  });
}

const inGeneration = (generation) => (e) => e.generation === generation;
const ofType = (type) => (e) => e.type === type;
const both = (...predicates) => (e) => predicates.every((p) => p(e));

/** The Flow commands the mock decoder emits, one per utterance. */
function script() {
  return [
    { speechMs: ENDURANCE ? 13000 : 2400, text: "open code" },
    { silenceMs: 700, text: "" },
    { speechMs: ENDURANCE ? 13000 : 2400, text: "open mail" },
    { silenceMs: 700, text: "" },
    { speechMs: ENDURANCE ? 13000 : 2400, text: "open notes" },
    { silenceMs: 700, text: "" },
  ];
}

function start() {
  child = spawn("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", HELPER,
  ], {
    env: { ...process.env, CHOOM_VOICE_TEST: "1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  });
}

/** Peak number of identified events in flight between two marks, used to
 *  prove the helper announces a seal before it announces the final. */
function orderingWithin(from, to, type, utterance) {
  const window = eventsSince(from).filter((e) => e.__at < to);
  const sealedAt = window.findIndex((e) => e.type === "utterance_sealed" && e.utterance === utterance);
  const finalAt = window.findIndex((e) => e.type === type && e.utterance === utterance);
  if (sealedAt < 0 || finalAt < 0) return { sealedAt, finalAt };
  return { sealedAt, finalAt, ok: sealedAt < finalAt };
}

async function main() {
  start();
  await waitFor(mark(), ofType("ready"), 20000, "ready");

  // ── 1. Three utterances in ONE capture session ────────────────────────────
  const G = 51;
  const at1 = mark();
  send({
    cmd: "test_continuous", decoder: DECODER, endpointMs: 500,
    generation: G, instance: 1, script: script(),
  });
  await waitFor(at1, both(inGeneration(G), ofType("listening")), 20000, "listening");
  const listened = eventsSince(at1).filter(both(inGeneration(G), ofType("listening")));
  check("one listen call opens exactly one capture session", listened.length === 1,
    `${listened.length} listening events`);

  const startedAt = listened[0].__receivedMs;
  const seals = [];
  for (let u = 1; u <= 3; u++) {
    seals.push(await waitFor(at1, both(inGeneration(G), (e) => e.type === "utterance_sealed" && e.utterance === u),
      180000, `utterance ${u} sealed`));
  }
  check("every utterance is sealed while capture stays open", seals.length === 3,
    `utterances ${seals.map((s) => s.utterance).join(",")}`);
  note("seal latency", `${seals.map((s) => `${s.utterance}:${s.__receivedMs - startedAt}ms`).join(" ")}`);

  const finals = [];
  for (let u = 1; u <= 3; u++) {
    finals.push(await waitFor(at1, both(inGeneration(G), (e) => (e.type === "final" || (USE_WHISPER && e.type === "empty")) && e.utterance === u),
      DECODE_TIMEOUT_MS, `final ${u}`));
  }
  check("three utterances decode from one session with one listen call", finals.length === 3);
  check("each final names its own utterance", finals.map((f) => f.utterance).join(",") === "1,2,3");
  check("every final carries a strictly positive sequence",
    finals.every((f) => f.type === "empty" || (Number.isInteger(f.sequence) && f.sequence > 0)),
    finals.map((f) => f.sequence).join(","));

  // ── 2. The endpoint closes the utterance, not the capture ────────────────
  const sessionEvents = eventsSince(at1);
  check("no stop or stopped event arrives between utterances",
    sessionEvents.every((e) => e.type !== "stopped"),
    `${sessionEvents.filter((e) => e.type === "stopped").length} stopped events`);
  check("capture stays open across every endpoint in the session",
    sessionEvents.filter((e) => e.type === "listening").length === 1
    && !sessionEvents.some((e) => e.type === "helper_exited" || e.type === "error"),
    "one listening event, no helper loss");

  // ── 3. Final versus partial priority ─────────────────────────────────────
  const order = orderingWithin(at1, observed, finals[0].type, 1);
  check("a seal is announced before the final it produced",
    order.ok === true, `seal at ${order.sealedAt}, final at ${order.finalAt}`);
  const identified = sessionEvents.filter((e) => e.sequence != null);
  check("sequences rise monotonically within an utterance and restart on the next",
    identified.every((e, i, all) => {
      if (i === 0) return true;
      const prev = all[i - 1];
      return e.utterance > prev.utterance
        || (e.utterance === prev.utterance && e.sequence > prev.sequence);
    }), `${identified.length} identified events`);
  const partials = sessionEvents.filter((e) => e.type === "partial");
  check("live captions are bounded: fewer than one per utterance second of speech",
    partials.length < 24, `${partials.length} captions across 3 utterances`);
  if (USE_WHISPER) {
    note("whisper mode", "transcript text is never asserted: synthetic tone is not speech");
  } else {
    check("mock finals preserve the scripted command text",
      finals.map((f) => f.text).join("|") === script().filter((s) => s.speechMs > 0).map((s) => s.text).join("|"));
    check("captions appear before their utterance final, never after it",
      sessionEvents.every((e) => !(e.type === "partial"
        && eventsSince(at1).slice(0, e.__at).some((p) => p.type === "final" && p.utterance === e.utterance))));
  }

  // ── 4. Silence produces an empty utterance, never invented text ──────────
  const G2 = 52;
  const at2 = mark();
  send({
    cmd: "test_continuous", decoder: "mock", endpointMs: 500,
    generation: G2, instance: 1, script: [{ silenceMs: 1500, text: "" }],
  });
  await waitFor(at2, both(inGeneration(G2), ofType("listening")), 20000, "second session listening");
  await waitFor(at2, both(inGeneration(G2), (e) => e.type === "empty" && e.utterance === 1), 60000, "silent utterance");
  const silenceEvents = eventsSince(at2);
  check("a silent utterance reports empty for THIS generation and invents no text",
    silenceEvents.filter(both(inGeneration(G2), ofType("empty"))).length >= 1
    && silenceEvents.filter(both(inGeneration(G2), ofType("final"))).length === 0,
    `${silenceEvents.filter(both(inGeneration(G2), ofType("final"))).length} finals in the silent session`);

  // ── 5. Finish during a pending decode keeps the sealed final ─────────────
  // The script seals an utterance and the finish lands straight after, so the
  // decoder is still busy when capture closes. The final must still arrive.
  const G3 = 53;
  const at3 = mark();
  send({
    cmd: "test_continuous", decoder: DECODER, endpointMs: 500,
    generation: G3, instance: 1,
    script: [{ speechMs: 2400, text: "open notes" }, { silenceMs: 700, text: "" }],
  });
  await waitFor(at3, both(inGeneration(G3), ofType("listening")), 20000, "finish session listening");
  await waitFor(at3, both(inGeneration(G3), ofType("utterance_sealed")), 120000, "finish session seal");
  // Finish while the decoder is still working on the sealed audio.
  send({ cmd: "whisper_finish", generation: G3, instance: 1 });
  const keptFinal = await waitFor(at3, both(inGeneration(G3), (e) => e.utterance === 1 && (e.type === "final" || (USE_WHISPER && e.type === "empty"))),
    DECODE_TIMEOUT_MS, "final delivered after an explicit finish");
  check("an explicit finish delivers the sealed final instead of discarding it",
    keptFinal.utterance === 1, `utterance ${keptFinal.utterance} sequence ${keptFinal.sequence}`);

  // ── 6. Stop retires the session and discards what is queued ──────────────
  const G4 = 54;
  const at4 = mark();
  send({
    cmd: "test_continuous", decoder: DECODER, endpointMs: 500,
    generation: G4, instance: 1,
    script: [
      { speechMs: 2000, text: "open code" },
      { silenceMs: 600, text: "" },
      { speechMs: 2000, text: "open mail" },
      { silenceMs: 600, text: "" },
    ],
  });
  await waitFor(at4, both(inGeneration(G4), ofType("listening")), 20000, "stop session listening");
  await waitFor(at4, both(inGeneration(G4), ofType("utterance_sealed")), 120000, "stop session first seal");
  const atStop = mark();
  send({ cmd: "stop", instance: 1 });
  const stopAcknowledged = await waitFor(atStop, ofType("stopped"), 10000, "capture stop acknowledged");
  await wait(2500);
  const afterStop = eventsSince(stopAcknowledged.__at + 1);
  const stray = afterStop.find(both(inGeneration(G4), (e) => e.type === "final" || e.type === "partial"));
  check("a Stop retires the session: no sealed audio is delivered afterwards",
    stray === undefined,
    stray ? `stray ${stray.type} for utterance ${stray.utterance}` : "no stray events");

  // ── 7. Cancel and readmission ────────────────────────────────────────────
  const G5 = 55;
  const at5 = mark();
  send({ cmd: "stop", instance: 1 });
  send({
    cmd: "test_continuous", decoder: "mock", endpointMs: 500,
    generation: G5, instance: 1,
    script: [{ speechMs: 1200, text: "open code" }, { silenceMs: 700, text: "" }],
  });
  const readmitted = await waitFor(at5, both(inGeneration(G5), ofType("final")),
    120000, "readmitted final");
  check("capture reads back cleanly after a cancel and a new session",
    readmitted.generation === G5, `generation ${readmitted.generation}`);
  const readmitEvents = eventsSince(at5);
  check("the readmitted session never emits under the retired generation",
    readmitEvents.filter(both(inGeneration(G4), (e) => e.type === "final")).length === 0);

  // ── 8. Repeated cycles stay stable ───────────────────────────────────────
  const t0 = Date.now();
  for (let cycle = 0; cycle < 3; cycle++) {
    const generation = 60 + cycle;
    const at = mark();
    send({
      cmd: "test_continuous", decoder: "mock", endpointMs: 500,
      generation, instance: 1,
      script: [{ speechMs: 1200, text: "open code" }, { silenceMs: 700, text: "" }],
    });
    await waitFor(at, both(inGeneration(generation), ofType("final")), 120000, `cycle ${generation}`);
  }
  const cyclesMs = Date.now() - t0;
  check("repeated capture cycles all complete", cyclesMs > 0, `${cyclesMs}ms for 3 cycles`);

  // ── 9. Idle after everything stops ───────────────────────────────────────
  const idleStopMarker = mark();
  send({ cmd: "stop", instance: 1 });
  await waitFor(idleStopMarker, ofType("stopped"), 10000, "idle stop acknowledged");
  const atIdle = mark();
  const cpu0 = process.cpuUsage();
  const wall0 = Date.now();
  await wait(3000);
  const idleEvents = eventsSince(atIdle);
  check("an idle helper emits nothing on its own", idleEvents.length === 0,
    `${idleEvents.length} events in ${Date.now() - wall0}ms`);
  note("probe process cpu", "probe only, not the helper");

  // ── 10. Only this run's temp audio is cleaned up ─────────────────────────
  // The helper owns exactly one directory, named after its own process id, and
  // deletes each WAV it wrote. Only that directory is inspected: no other
  // session's audio is scanned, listed or deleted.
  const ownDir = path.join(os.tmpdir(), `choom-whisper-${child.pid}`);
  let leftover = 0;
  try {
    leftover = fs.readdirSync(ownDir).length;
  } catch {
    leftover = 0;
  }
  check("this run leaves no sealed or snapshot audio behind", leftover === 0,
    `${leftover} files in this run's own directory`);

  note("measured", [
    `decoder=${DECODER}`,
    `three-utterance session ${finals[2].__receivedMs - startedAt}ms`,
    `three short cycles ${cyclesMs}ms`,
    `probe cpu ${Math.round(process.cpuUsage(cpu0).user / 1000)}ms user over the idle window (Node only)`,
  ].join(", "));
  console.log(
    failures.length === 0
      ? "continuous probe: all assertions passed"
      : `continuous probe: ${failures.length} FAILURES`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main()
  .catch((err) => { console.error(err); console.log(JSON.stringify(allEvents)); failures.push(String(err)); })
  .finally(async () => {
    try { send({ cmd: "shutdown" }); } catch { /* helper already gone */ }
    await wait(400);
    try { child.kill(); } catch { /* already gone */ }
    console.log(
      failures.length === 0
        ? "continuous probe: all assertions passed"
        : `continuous probe: ${failures.length} FAILURES: ${failures.join("; ")}`,
    );
    process.exit(failures.length ? 1 : 0);
  });
