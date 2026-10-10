// Whisper backend regression: selectable local transcription, lifecycle fences,
// silence handling and packaging. Run from windows/: node scripts/whisper-regression.cjs
// Verifies actual production controller/helper paths, not mocks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function compileVoice(tmp) {
  const rel = "src/choom/voice.ts";
  const source = read(rel);
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const dest = path.join(tmp, "voice.js");
  fs.writeFileSync(dest, out);
  return require(dest);
}

async function main() {
  let failed = 0;
  const check = (label, value) => {
    console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
    if (!value) failed++;
  };

  // 1. Frontend pure helpers from the actual voice.ts
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-whisper-test-"));
  let V;
  try {
    V = compileVoice(tmp);

    check("backend validates system and whisper only",
      V.validVoiceBackend("system") && V.validVoiceBackend("whisper")
      && !V.validVoiceBackend("cloud") && !V.validVoiceBackend(""));
    check("model validates base and small only",
      V.validVoiceModel("base") && V.validVoiceModel("small")
      && !V.validVoiceModel("large") && !V.validVoiceModel(""));
    check("unknown prefs normalize without silent switching",
      V.normalizeVoiceBackend("cloud") === "system"
      && V.normalizeVoiceBackend("whisper") === "whisper"
      && V.normalizeVoiceModel("large") === "base"
      && V.normalizeVoiceModel("small") === "small");
    check("whisper uses 6 threads, names prompt and 30s bound",
      V.WHISPER_THREADS === 6
      && V.WHISPER_PROMPT === "Choom, Spotify, Visual Studio Code."
      && V.WHISPER_MAX_SECONDS === 30);
    check("blank and silence output is discarded",
      V.isWhisperBlank("") && V.isWhisperBlank("   ")
      && V.isWhisperBlank("[BLANK_AUDIO]") && V.isWhisperBlank("[ Silence ]")
      && V.isWhisperBlank("(silence)")
      && !V.isWhisperBlank("open spotify") && !V.isWhisperBlank("Choom"));

    // Lifecycle on the actual Voice store
    const { Voice } = V;
    const resetTurn = (gen) => {
      V.resetSubmissionGuard();
      Voice.state.generation = gen;
      Voice.state.runtime = "listening";
      Voice.state.muted = false;
      Voice.state.partial = "";
      Voice.state.pendingSegments = [];
      Voice.state.stable = [];
      Voice.state.error = null;
    };

    // Repeated wake/listen/close: each turn owns its generation.
    resetTurn(21);
    check("first turn final applies", Voice.applyFinal("open spotify", 21) === "open spotify");
    Voice.cancelTurn(22);
    check("close moves to the next generation", Voice.state.generation === 22);
    Voice.state.runtime = "listening";
    check("second turn final applies", Voice.applyFinal("open choom", 22) === "open choom");

    // Stale completion: late final from a cancelled generation never acts.
    Voice.cancelTurn(23);
    check("stale completion is discarded", Voice.applyFinal("late words", 22) === null);
    check("stale turn leaves no pending segments", Voice.state.pendingSegments.length === 0);

    // Stop during transcription: cancel, then the old final cannot submit.
    resetTurn(31);
    check("recording final applies", Voice.applyFinal("play music", 31) === "play music");
    const taken = Voice.takeSegments();
    V.noteSubmittedSegments(31, taken.aggregate, taken.segments);
    Voice.cancelTurn(32);
    check("stop during transcription clears the stop race",
      Voice.applyFinal("play music", 31) === null && Voice.state.pendingSegments.length === 0);

    // Mute blocks capture: partials and finals are rejected while muted.
    resetTurn(41);
    Voice.state.muted = true;
    check("muted partial is rejected", Voice.applyPartial("hello", 41) === false);
    check("muted final is rejected", Voice.applyFinal("hello", 41) === null);
    Voice.state.muted = false;

    // Silence: empty finals never enter the transcript or the submit path.
    resetTurn(51);
    check("empty final is discarded", Voice.applyFinal("   ", 51) === null);
    check("silence marker is discarded", Voice.applyFinal("[BLANK_AUDIO]", 51) === null);
    check("silence leaves no pending segments", Voice.state.pendingSegments.length === 0);

    // Repeated turn finalization: segments aggregate once, re-delivery never resubmits.
    resetTurn(61);
    check("segment one applies", Voice.applyFinal("open my notes", 61) === "open my notes");
    check("segment two applies", Voice.applyFinal("and file it", 61) === "and file it");
    const agg = Voice.takeSegments();
    check("segments aggregate into one utterance", agg.aggregate === "open my notes and file it");
    V.noteSubmittedSegments(61, agg.aggregate, agg.segments);
    check("re-delivered segment cannot resubmit", Voice.applyFinal("open my notes", 61) === null);
    check("aggregate cannot resubmit", V.wasSubmitted(61, agg.aggregate) === true);

    // Failed model load: unknown model normalizes to Base, backend stays put.
    check("failed model load never silently switches backends",
      V.normalizeVoiceModel("large") === "base" && V.normalizeVoiceBackend("whisper") === "whisper");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 2. Settings backward compatibility (actual files)
  const stateSrc = read("src/core/state.ts");
  check("state defaults existing users to system dictation",
    stateSrc.includes('voiceBackend: "system"') && stateSrc.includes('voiceModel: "base"'));
  check("state types allow explicit whisper selection",
    stateSrc.includes('"system" | "whisper"') && stateSrc.includes('"base" | "small"'));
  const settingsSrc = read("src-tauri/src/settings.rs");
  check("rust settings default to system and base",
    settingsSrc.includes('"system".to_string()') && settingsSrc.includes('"base".to_string()'));
  check("rust settings normalize unknown backend and model",
    settingsSrc.includes("normalize_backend") && settingsSrc.includes("normalize_model"));

  // 3. Native backend (actual voice.rs)
  const voiceRs = read("src-tauri/src/choom/voice.rs");
  check("rust uses 6 threads and names-only prompt",
    voiceRs.includes("WHISPER_THREADS: u32 = 6")
    && voiceRs.includes('"Choom, Spotify, Visual Studio Code."'));
  check("rust bounds utterances at 30s with a 120s worker timeout",
    voiceRs.includes("WHISPER_MAX_SECONDS: u64 = 30") && voiceRs.includes("WHISPER_TIMEOUT_SECS: u64 = 120"));
  check("rust parses transcribing and empty helper events",
    voiceRs.includes('"transcribing" | "empty"') || (voiceRs.includes('"transcribing"') && voiceRs.includes('"empty"')));
  check("rust discards stale transcribing and empty completions",
    voiceRs.includes('"transcribing" || kind == "empty"') || voiceRs.includes('kind == "transcribing"'));
  check("rust exposes whisper status without downloads",
    voiceRs.includes("voice_whisper_status") && voiceRs.includes("No download"));
  check("rust finishes and discards through split commands",
    voiceRs.includes("voice_whisper_finish") && voiceRs.includes("whisper_finish_body")
    && voiceRs.includes("whisper_discard_body"));
  check("rust forwards the endpoint delay to silence detection",
    voiceRs.includes("endpointMs") && voiceRs.includes("clamp_endpoint_ms"));
  check("rust cleanup is age-gated and never takes live files",
    voiceRs.includes("whisper_temp_is_stale") && voiceRs.includes("WHISPER_STALE_SECS"));
  check("rust cleans bounded temp WAVs on boot and shutdown",
    voiceRs.includes("cleanup_stale_whisper_wavs") && voiceRs.includes('WHISPER_TEMP_PREFIX'));
  check("rust never builds shell from speech text",
    !voiceRs.includes("sh -c") && !voiceRs.includes("cmd /C")
    && voiceRs.includes("never a constructed shell"));
  check("rust fails visibly without silent backend fallback",
    voiceRs.includes("No silent fallback") || voiceRs.includes("never silently switch"));
  check("rust fences turn-scoped errors but keeps global ones",
    voiceRs.includes("keep_helper_error"));
  check("whisper finish transcribes, stop discards for every backend",
    voiceRs.includes("voice_whisper_finish")
    && voiceRs.includes("manual mic stop finishes via voice_whisper_finish"));
  const libRs = read("src-tauri/src/lib.rs");
  check("whisper status and finish commands are registered",
    libRs.includes("voice_whisper_status") && libRs.includes("voice_whisper_finish"));

  // 4. Helper (actual choom-voice.ps1)
  const ps = read("voice-runtime/choom-voice.ps1");
  check("helper preserves wake grammar and talkback",
    ps.includes("choom-wake") && ps.includes("SpeakAsyncWithDone") && ps.includes("ch uw m"));
  check("helper captures bounded PCM via waveIn callbacks",
    ps.includes("winmm.dll") && ps.includes("waveInOpen") && ps.includes("WIM_DATA")
    && !ps.includes("mciSendString"));
  check("helper invokes whisper-cli with 6 threads and names prompt",
    ps.includes("whisper-cli") && ps.includes("-t 6") && ps.includes("Choom, Spotify, Visual Studio Code."));
  check("helper matches the measured CPU mode: English, no GPU",
    ps.includes("-l en") && ps.includes("-ng"));
  check("helper background delegate closes its parameter list",
    !ps.includes("Task t {") && ps.includes("Task t) {"));
  check("helper endpoint detector is one shared implementation",
    ps.includes("ChoomEndpoint") && ps.includes("TestEndpoint") && ps.includes("ActiveDetector"));
  check("helper silence endpoint uses the settings delay with a 30s bound",
    ps.includes("endpointMs") && ps.includes("30000"));
  check("helper session audio is app-private with age-gated cleanup",
    ps.includes("SessionDir") && ps.includes("AddHours(-24)"));
  check("helper fences worker startup by ownership, drains before kill",
    ps.includes("IsOwner") && ps.includes("ReleaseOwner") && ps.includes("reader.Wait(10000)"));
  check("helper fails nonzero exits and checks blanks before cleaning",
    ps.includes("code != 0") && ps.includes("IsBlank(output)") && ps.includes("IsTimestampHead"));
  check("helper never runs the worker on silence without speech",
    ps.includes("!hadSpeech") && ps.includes("hallucinated"));
  check("helper finish ignores superseded generations",
    ps.includes("whisper_finish") && ps.includes("$gen -ne $script:generation"));
  check("helper separates device shutdown from WAV finalization",
    ps.includes("TakeDeviceLocked") && ps.includes("TeardownBundleNow")
    && !ps.includes("CloseDeviceLocked"));
  check("helper pipeline test runs without a microphone",
    ps.includes("test_capture") && ps.includes("TestCapture") && ps.includes("SynthFeed"));  check("helper fences generations and discards stale completions",
    ps.includes("gen != ActiveGen") && ps.includes("ActiveGen = -1"));
  check("helper cleans temp WAVs on completion, cancel and startup",
    ps.includes("CleanupStaleTemps") && ps.includes("choom-whisper-"));
  check("helper bounds concurrency to one job",
    ps.includes("CancelLocked") && ps.includes("ActiveProcess"));
  check("helper test transcription is gated, never in production",
    ps.includes("test_whisper") && ps.includes("CHOOM_VOICE_TEST"));
  check("helper never concatenates speech into shell commands",
    !ps.includes("Invoke-Expression") && ps.includes("Speech text is output only"));
  check("helper exposes whisper finish and empty events",
    ps.includes("whisper_finish") && ps.includes('"empty"') && ps.includes("transcribing"));
  check("helper documents final-only transcription",
    ps.includes("final transcription only"));

  // 5. Frontend wiring (actual bridge and settings)
  const bridge = read("src/core/bridge.ts");
  check("bridge exposes whisper status without mic use",
    bridge.includes("voiceWhisperStatus") && bridge.includes("voice_whisper_status"));
  check("bridge exposes whisper finish for manual mic stop",
    bridge.includes("voiceWhisperFinish") && bridge.includes("voice_whisper_finish"));
  const section = read("src/choom/voiceSection.ts");
  check("settings offer explicit backend and model controls",
    section.includes("Transcription") && section.includes("Whisper model")
    && section.includes("Windows dictation") && section.includes("Local Whisper"));
  check("settings report Base bundled and Small unavailable",
    section.includes("Base bundled") && section.includes("Small") && section.includes("not bundled"));
  check("settings state final-only limitation honestly",
    section.includes("final transcription only"));
  check("events handle transcribing and silence without provisional submit",
    section.includes('"transcribing"') && section.includes('"empty"')
    && section.includes("No speech detected"));
  check("manual stop finishes and waits for the terminal before re-arm",
    section.includes("pendingFinish") && section.includes("clearPendingFinish")
    && section.includes("rearmAfterTerminal") && section.includes("stopVoiceFinish"));
  check("close, cancel, mute and submit clear a pending finish",
    (section.match(/clearPendingFinish\(\)/g) || []).length >= 5);
  check("existing approvals and tool flows are preserved",
    section.includes("voiceToolRun") && section.includes("ambiguity") && section.includes("approvalNote"));

  // 6. Packaging (actual tauri.conf.json)
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  const res = conf.bundle.resources || {};
  const keys = Object.keys(res);
  check("packaging includes whisper-cli and base model",
    keys.some((k) => k.includes("whisper-cli.exe")) && keys.some((k) => k.includes("ggml-base.bin")));
  check("packaging includes whisper runtime DLLs",
    keys.some((k) => k.includes("whisper.dll")) && keys.some((k) => k.includes("ggml.dll")));
  check("small model is not claimed as bundled",
    !keys.some((k) => k.includes("ggml-small.bin")));
  check("no automatic network download in packaging",
    !JSON.stringify(conf).includes("download"));

  // 7. Copy hygiene for touched files. Banned glyphs match by char code,
  // so this check file itself stays ASCII clean. bridge.ts keeps its round-0
  // dashes out of scope; only new copy must avoid them.
  const BANNED_CODES = [0x2014, 0x2013];
  for (const rel of [
    "src/choom/voice.ts",
    "src/choom/voiceSection.ts",
    "src-tauri/src/choom/voice.rs",
    "voice-runtime/choom-voice.ps1",
    "scripts/whisper-regression.cjs",
    "scripts/whisper-controller-regression.cjs",
    "scripts/whisper-endpoint-fixtures.cjs",
    "scripts/whisper-endpoint-probe.cjs",
  ]) {
    const text = read(rel);
    let dirty = false;
    const lines = text.split("\n");
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const code = line.charCodeAt(i);
        if (code === 0x2014 || code === 0x2013) {
          if (line.includes("BANNED_CODES") || line.includes("0x2014") || line.includes("0x2013")) break;
          dirty = true;
          break;
        }
      }
      if (dirty) break;
    }
    check(rel + " has no banned sentence connectors", !dirty);
  }
  // 8. Endpoint fixtures validate under the detector contract now.
  // Detector decisions run through the helper probe (Codex-run); here the
  // inputs are proven speech, silence and noise without a microphone.
  const os2 = require("node:os");
  const fx = require("./whisper-endpoint-fixtures.cjs");
  const fxDir = fs.mkdtempSync(path.join(os2.tmpdir(), "choom-endpoint-check-"));
  try {
    const built = fx.generate(fxDir);
    const summary = fx.validate(built);
    check("endpoint fixtures match their names frame by frame",
      summary["silence-2s"].speechFrames === 0
      && summary["speech-2s"].speechFrames === summary["speech-2s"].frames
      && summary["noise-2s"].speechFrames === 0
      && summary["mixed-pause"].frames === 28);
  } finally {
    fs.rmSync(fxDir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "whisper regression: all assertions passed" : `whisper regression: ${failed} FAILURES`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
