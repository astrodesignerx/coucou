// Real helper endpoint probe. CODEX-RUN ONLY: spawns the production helper
// (needs powershell) and drives test_endpoint plus worker lifecycle on
// synthetic fixtures. Not executed by the free builder (helper spawn is
// blocked there); the builder validated fixture properties instead, see
// whisper-endpoint-fixtures.cjs. No user audio, no microphone.
//
// Run from windows/: node scripts/whisper-endpoint-probe.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fixtures = require("./whisper-endpoint-fixtures.cjs");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "voice-runtime", "choom-voice.ps1");

function send(stdin, obj) {
  stdin.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const failures = [];
  const check = (label, value) => {
    console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
    if (!value) failures.push(label);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "choom-endpoint-probe-"));
  let child = null;
  try {
    const built = fixtures.generate(dir);
    fixtures.validate(built);

    child = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", HELPER,
    ], {
      env: { ...process.env, CHOOM_VOICE_TEST: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = [];
    let buffer = "";
    const waiters = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { parsed = null; }
          if (parsed) {
            lines.push(parsed);
            for (const w of [...waiters]) {
              if (w(parsed)) waiters.splice(waiters.indexOf(w), 1);
            }
          }
        }
        idx = buffer.indexOf("\n");
      }
    });
    const waitFor = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
      const found = lines.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(entry);
        if (at >= 0) waiters.splice(at, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const entry = (event) => {
        if (predicate(event)) {
          clearTimeout(timer);
          resolve(event);
          return true;
        }
        return false;
      };
      waiters.push(entry);
    });

    await waitFor((e) => e.type === "ready", 15000, "helper ready");

    // Silence: no onset, detector reports none without any worker.
    send(child.stdin, { cmd: "test_endpoint", wav: built["silence-2s"].file, endpointMs: 500, generation: 11, instance: 1 });
    const silence = await waitFor((e) => e.type === "endpoint_test" && e.generation === 11, 15000, "silence endpoint");
    check("silence fixture reports no speech", silence.hadSpeech === false);
    check("silence fixture reason is none", silence.reason === "none");

    // Low noise under the threshold: same as silence.
    send(child.stdin, { cmd: "test_endpoint", wav: built["noise-2s"].file, endpointMs: 500, generation: 12, instance: 1 });
    const hiss = await waitFor((e) => e.type === "endpoint_test" && e.generation === 12, 15000, "noise endpoint");
    check("noise fixture reports no speech", hiss.hadSpeech === false);
    check("noise fixture reason is none", hiss.reason === "none");

    // Continuous speech: onset on frame zero, stream ends before any pause.
    send(child.stdin, { cmd: "test_endpoint", wav: built["speech-2s"].file, endpointMs: 500, generation: 13, instance: 1 });
    const talk = await waitFor((e) => e.type === "endpoint_test" && e.generation === 13, 15000, "speech endpoint");
    check("speech fixture reports onset at zero", talk.hadSpeech === true && talk.onsetMs === 0);
    check("speech fixture ends at stream end", talk.reason === "eof" && talk.endMs === 2000);

    // Speech, pause, speech: endpoint fires once inside the pause.
    send(child.stdin, { cmd: "test_endpoint", wav: built["mixed-pause"].file, endpointMs: 500, generation: 14, instance: 1 });
    const mixed = await waitFor((e) => e.type === "endpoint_test" && e.generation === 14, 15000, "mixed endpoint");
    check("mixed fixture endpoints once in the pause", mixed.hadSpeech === true && mixed.reason === "endpoint");
    check("mixed fixture ends at 1300ms", mixed.endMs === 1300);
    check("mixed fixture stops feeding at finish", mixed.frames === 13);

    // Full pipeline without a microphone: synthesized silence runs the
    // detector, writer and finalizer, then emits empty with no worker.
    // In particular no transcribing event may precede it.
    send(child.stdin, { cmd: "test_capture", source: "synth-silence", seconds: 1, endpointMs: 500, model: "base", generation: 15, instance: 1 });
    const silenceCap = await waitFor(
      (e) => (e.type === "empty" || e.type === "final" || e.type === "error") && e.generation === 15,
      60000,
      "synth silence terminal",
    );
    check("synthesized silence ends silent with no worker", silenceCap.type === "empty");
    const earlyTranscribing = lines.some((e) => e.type === "transcribing" && e.generation === 15);
    check("synthesized silence never starts transcription", !earlyTranscribing);

    // Synthesized speech reaches the worker: a terminal with the turn's
    // generation proves the pipeline. Content is not asserted: a pure tone
    // is not speech, only the lifecycle is under test here.
    send(child.stdin, { cmd: "test_capture", source: "synth-speech", seconds: 2, endpointMs: 500, model: "base", generation: 16, instance: 1 });
    const speechTerm = await waitFor(
      (e) => (e.type === "empty" || e.type === "final" || e.type === "error") && e.generation === 16,
      180000,
      "synth speech terminal",
    );
    check("synthesized tone reaches transcription after WAV finalization", lines.some((e) => e.type === "transcribing" && e.generation === 16));
    check("synthesized tone terminates without a runtime error", ["empty", "final"].includes(speechTerm.type));

    // Discard cycle: stopping a running capture kills it with no terminal.
    send(child.stdin, { cmd: "test_capture", source: "synth-speech", seconds: 5, endpointMs: 500, model: "base", generation: 17, instance: 1 });
    await waitFor((e) => e.type === "listening" && e.generation === 17, 15000, "capture start");
    send(child.stdin, { cmd: "stop", instance: 1 });
    await waitFor((e) => e.type === "stopped", 15000, "capture stop");
    let stray = null;
    try {
      stray = await waitFor(
        (e) => (e.type === "empty" || e.type === "final" || e.type === "error" || e.type === "transcribing") && e.generation === 17,
        4000,
        "absent terminal",
      );
    } catch {
      stray = null;
    }
    check("discarded capture emits no terminal", stray === null);

    // Soak: repeated short captures stay fenced by generation.
    for (const g of [18, 19, 20]) {
      send(child.stdin, { cmd: "test_capture", source: "synth-silence", seconds: 1, endpointMs: 500, model: "base", generation: g, instance: 1 });
      const term = await waitFor(
        (e) => (e.type === "empty" || e.type === "final" || e.type === "error") && e.generation === g,
        60000,
        `soak terminal ${g}`,
      );
      check(`soak capture ${g} terminates fenced`, term.generation === g && term.type === "empty");
    }

    // Live listen path on either hardware: without a microphone the helper
    // fails fast and stays responsive; with one it records until finished.
    send(child.stdin, { cmd: "listen", backend: "whisper", model: "base", endpointMs: 500, generation: 21, instance: 1 });
    const liveStart = await waitFor(
      (e) => (e.generation === 21 && (e.type === "listening" || e.type === "error")),
      15000,
      "live listen start",
    );
    if (liveStart.type === "listening") {
      send(child.stdin, { cmd: "whisper_finish", generation: 21, instance: 1 });
      const liveTerm = await waitFor(
        (e) => (e.type === "empty" || e.type === "final" || e.type === "error") && e.generation === 21,
        180000,
        "live finish terminal",
      );
      check("live capture finishes its turn", ["empty", "final", "error"].includes(liveTerm.type));
    } else {
      check("mic-less listen fails fast and visible", /microphone|device|audio/i.test(liveStart.message || liveStart.text || ""));
    }
    // Either way the helper answers the next command: no wedged device.
    send(child.stdin, { cmd: "test_endpoint", wav: built["noise-2s"].file, endpointMs: 500, generation: 22, instance: 1 });
    const responsive = await waitFor((e) => e.type === "endpoint_test" && e.generation === 22, 15000, "post-cycle response");
    check("helper stays responsive after start, finish and discard cycles", responsive.reason === "none");

    send(child.stdin, { cmd: "shutdown" });
  } catch (err) {
    failures.push(String(err && err.message ? err.message : err));
    console.error(err);
  } finally {
    if (child) {
      try { child.kill(); } catch { /* helper already exited */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? "endpoint probe: all assertions passed" : `endpoint probe: ${failures.length} FAILURES`);
  process.exitCode = failures.length ? 1 : 0;
}

main();

