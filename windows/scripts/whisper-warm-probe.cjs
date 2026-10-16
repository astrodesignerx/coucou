// Local helper acceptance: real synthesized speech, one-shot compatibility,
// continuous server reuse and measured decoding time. No microphone.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { HELPER, extractCsharp } = require("./whisper-helper-source.cjs");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-warm-probe-"));
  const cliOnly = process.argv.includes("--cli");
  let helper = HELPER;
  if (cliOnly) {
    helper = path.join(tmp, "choom-voice.ps1");
    fs.copyFileSync(HELPER, helper);
    fs.mkdirSync(path.join(tmp, "whisper"));
    const runtime = path.join(path.dirname(HELPER), "whisper");
    for (const file of fs.readdirSync(runtime)) {
      if (file === "whisper-server.exe") continue;
      fs.copyFileSync(path.join(runtime, file), path.join(tmp, "whisper", file));
    }
  }
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
    env: { ...process.env, CHOOM_VOICE_TEST: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buffer = "", errors = "";
  const waiters = new Set();
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      event.receivedMs = performance.now();
      events.push(event);
      for (const wake of [...waiters]) wake();
    }
  });
  const send = cmd => child.stdin.write(`${JSON.stringify(cmd)}\n`);
  const waitFor = (predicate, label, from = 0) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(wake); reject(new Error(`Timeout: ${label}. ${errors}`)); }, 45000);
    function wake() {
      const found = events.slice(from).find(predicate);
      const error = events.slice(from).find(e => e.type === "error");
      if (!found && !error) return;
      clearTimeout(timer);
      waiters.delete(wake);
      if (error) reject(new Error(`${JSON.stringify(error)} ${errors}`));
      else resolve(found);
    }
    waiters.add(wake);
    wake();
  });
  try {
    await waitFor(e => e.type === "ready", "helper ready");
    const wav = path.join(tmp, "speech.wav");
    send({ cmd: "test_speak", text: "Open the music application.", wav, generation: 800, instance: 1 });
    await waitFor(e => e.type === "speech_ended" && e.generation === 800, "speech fixture");
    const closeAt = events.length;
    send({ cmd: "stop_audio", generation: 800, instance: 1 });
    await waitFor(e => e.type === "speech_ended", "close speech fixture", closeAt);
    send({ cmd: "test_transcribe", wav, model: "base", generation: 801, instance: 1 });
    const text = await waitFor(e => e.type === "final" && e.generation === 801, "one-shot transcription");
    const timing = await waitFor(e => e.type === "transcription_test" && e.generation === 801, "one-shot timing");
    assert.match(text.text, /music/i);
    console.log(`PASS: test_transcribe: ${timing.milliseconds}ms, ${text.text}`);

    const generation = 802, from = events.length;
    send({ cmd: "test_continuous", decoder: "whisper", source: "synth-speech", endpointMs: 700,
      generation, instance: 1, script: [
        { speechMs: 2000, text: "Open code." }, { silenceMs: 900 },
        { speechMs: 2000, text: "Open mail." }, { silenceMs: 900 },
        { speechMs: 2000, text: "Open notes." }, { silenceMs: 900 },
      ] });
    for (let utterance = 1; utterance <= 3; utterance++) {
      const final = await waitFor(e => e.type === "final" && e.generation === generation && e.utterance === utterance,
        `continuous final ${utterance}`, from);
      const metric = await waitFor(e => e.type === "continuous_test" && e.generation === generation
        && e.utterance === utterance && e.final, `continuous timing ${utterance}`, from);
      assert.equal(metric.backend, cliOnly ? "cli" : "server", "each utterance uses the expected decoder");
      assert.ok(metric.audioContext >= 384);
      assert.match(final.text, new RegExp(`^open ${["code", "mail", "notes"][utterance - 1]}[.!]?$`, "i"));
      const seal = events.slice(from).find(e => e.type === "utterance_sealed" && e.utterance === utterance && e.generation === generation);
      assert.ok(seal, "each final has a seal timestamp");
      const latency = Math.round(final.receivedMs - seal.receivedMs);
      if (!cliOnly) assert.ok(latency < 1000, `seal-to-final ${utterance}: ${latency}ms exceeds 1000ms`);
      assert.ok(metric.sealToFinalMs >= 0);
      console.log(`PASS: seal-to-final ${utterance}: ${latency}ms (helper ${metric.sealToFinalMs}ms)`);
      console.log(`PASS: utterance ${utterance}: ${metric.milliseconds}ms, backend=${metric.backend}, audio_ctx=${metric.audioContext}, ${final.text}`);
    }
    assert.equal(events.slice(from).filter(e => e.type === "listening").length, 1);
    const cs = extractCsharp();
    const cli = cs.slice(cs.indexOf("static bool RunWhisperChild("), cs.indexOf("public static bool StartRecording("));
    assert.match(cli, /-ac .*AudioContext/);
    assert.ok(events.slice(from).filter(e => e.type === "continuous_test").every(e => e.backend === (cliOnly ? "cli" : "server")),
      "live captions use the same decoder");
    console.log(`PASS: one capture session; every caption and final uses ${cliOnly ? "CLI fallback" : "the warm server"}; CLI fallback keeps -ac`);
    // A longer utterance schedules a provisional decode before sealing. Its
    // final must still meet the latency budget when that caption is preempted.
    if (!cliOnly) {
      const captionFrom = events.length;
      send({ cmd: "test_continuous", decoder: "whisper", source: "synth-speech", endpointMs: 700,
        generation: 803, instance: 1, script: [
          { speechMs: 5000, text: "Open code and then open mail and then open notes." }, { silenceMs: 900 },
        ] });
      const final = await waitFor(e => e.type === "final" && e.generation === 803 && e.utterance === 1,
        "warm captioned final", captionFrom);
      const seal = events.slice(captionFrom).find(e => e.type === "utterance_sealed" && e.generation === 803 && e.utterance === 1);
      const metrics = events.slice(captionFrom).filter(e => e.type === "continuous_test" && e.generation === 803);
      assert.ok(final.sequence >= 2, "a real provisional decode was scheduled before the final");
      assert.ok(metrics.every(e => e.backend === "server"), "captions reuse the warm server");
      assert.match(final.text, /^open code.*open mail.*open notes[.!]?$/i);
      const latency = Math.round(final.receivedMs - seal.receivedMs);
      assert.ok(latency < 1000, `captioned seal-to-final: ${latency}ms exceeds 1000ms`);
      console.log(`PASS: final after provisional scheduling uses warm server; seal-to-final ${latency}ms`);
    }

  } finally {
    fs.writeFileSync(path.join(path.dirname(tmp), "whisper-warm-events.json"), JSON.stringify({ events, errors }, null, 2));
    send({ cmd: "shutdown" });
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
