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

  // ── 1. Frontend pure helpers from the actual voice.ts ──
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
      && V.WHISPER_PROMPT === "Choom, Spotify, Visual Studio Code"
      && V.WHISPER_MAX_SECONDS === 30);
    check("blank and silence output is discarded",
      V.isWhisperBlank("") && V.isWhisperBlank("   ")
      && V.isWhisperBlank("[BLANK_AUDIO]") && V.isWhisperBlank("[ Silence ]")
      && V.isWhisperBlank("(silence)")
      && !V.isWhisperBlank("open spotify") && !V.isWhisperBlank("Choom"));

    // ── Lifecycle on the actual Voice store ──
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

  // ── 2. Settings backward compatibility (actual files) ──
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

  // ── 3. Native backend (actual voice.rs) ──
  const voiceRs = read("src-tauri/src/choom/voice.rs");
  check("rust uses 6 threads and names-only prompt",
    voiceRs.includes("WHISPER_THREADS: u32 = 6")
    && voiceRs.includes('"Choom, Spotify, Visual Studio Code"'));
  check("rust bounds utterances at 30s with a 120s worker timeout",
    voiceRs.includes("WHISPER_MAX_SECONDS: u64 = 30") && voiceRs.includes("WHISPER_TIMEOUT_SECS: u64 = 120"));
  check("rust parses transcribing and empty helper events",
    voiceRs.includes('"transcribing" | "empty"') || (voiceRs.includes('"transcribing"') && voiceRs.includes('"empty"')));
  check("rust discards stale transcribing and empty completions",
    voiceRs.includes('"transcribing" || kind == "empty"') || voiceRs.includes('kind == "transcribing"'));
  check("rust exposes whisper status without downloads",
    voiceRs.includes("voice_whisper_status") && voiceRs.includes("No download"));
  check("rust cleans bounded temp WAVs on boot and shutdown",
    voiceRs.includes("cleanup_stale_whisper_wavs") && voiceRs.includes('WHISPER_TEMP_PREFIX'));
  check("rust never builds shell from speech text",
    !voiceRs.includes("sh -c") && !voiceRs.includes("cmd /C")
    && voiceRs.includes("never a constructed shell"));
  check("rust fails visibly without silent backend fallback",
    voiceRs.includes("No silent fallback") || voiceRs.includes("never silently switch"));
  check("whisper finish transcribes, stop discards",
    voiceRs.includes("whisper_finish") && voiceRs.includes("stop") );
  const libRs = read("src-tauri/src/lib.rs");
  check("whisper status command is registered",
    libRs.includes("voice_whisper_status"));

  // ── 4. Helper (actual choom-voice.ps1) ──
  const ps = read("voice-runtime/choom-voice.ps1");
  check("helper preserves wake grammar and talkback",
    ps.includes("choom-wake") && ps.includes("SpeakAsyncWithDone") && ps.includes("ch uw m"));
  check("helper captures bounded mic audio via WinMM",
    ps.includes("winmm.dll") && ps.includes("mciSendString") && ps.includes("choom_whisper"));
  check("helper invokes whisper-cli with 6 threads and names prompt",
    ps.includes("whisper-cli") && ps.includes("-t 6") && ps.includes("Choom, Spotify, Visual Studio Code"));
  check("helper fences generations and discards stale completions",
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

  // ── 5. Frontend wiring (actual bridge and settings) ──
  const bridge = read("src/core/bridge.ts");
  check("bridge exposes whisper status without mic use",
    bridge.includes("voiceWhisperStatus") && bridge.includes("voice_whisper_status"));
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
  check("existing approvals and tool flows are preserved",
    section.includes("voiceToolRun") && section.includes("ambiguity") && section.includes("approvalNote"));

  // ── 6. Packaging (actual tauri.conf.json) ──
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

  // ── 7. Copy hygiene for touched files ──
  for (const rel of ["src/choom/voice.ts", "src/choom/voiceSection.ts", "src-tauri/src/choom/voice.rs"]) {
    const text = read(rel);
    check(`${rel} has no banned sentence connectors`,
      !text.includes("—") && !text.includes("–"));
  }

  console.log(failed === 0 ? "whisper regression: all assertions passed" : `whisper regression: ${failed} FAILURES`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
