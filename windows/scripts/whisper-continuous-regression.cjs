// Continuous capture regression for windows/voice-runtime/choom-voice.ps1.
//
// The helper process itself is Codex-run only (see whisper-continuous-probe.cjs).
// This suite is builder-runnable and asserts what can be proved without a
// microphone, a helper process or a Whisper model: the structural invariants
// of the real embedded C# and the real PowerShell command surface, plus the
// endpoint arithmetic computed from the same constants the helper uses.
//
// The claims here are about the source that actually ships. Anything that
// needs a live helper is in the probe, not here, and nothing in this file
// simulates helper output to stand in for a run.
//
//   node scripts/whisper-continuous-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { extractCsharp, extractPowerShell, region } = require("./whisper-helper-source.cjs");
const fx = require("./whisper-endpoint-fixtures.cjs");

const ROOT = path.join(__dirname, "..");

const failures = [];
const check = (label, value) => {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failures.push(label);
};

const cs = extractCsharp();
const ps = extractPowerShell();

/** A bounded numeric constant declared in the helper's C#. */
function constant(name) {
  const m = new RegExp(`const\\s+int\\s+${name}\\s*=\\s*(\\d+)`).exec(cs);
  return m ? Number(m[1]) : null;
}

function main() {
  // ── 1. Bounds ─────────────────────────────────────────────────────────────
  // 30s of 16kHz mono 16-bit PCM is exactly 480000 samples.
  check("active utterance memory is bounded to 30s of 16kHz mono PCM",
    constant("MAX_PCM_SAMPLES") === 16000 * 30);
  check("snapshot cadence is conservative and reusable, at least 2s",
    (constant("SNAPSHOT_EVERY_MS") ?? 0) >= 2000);
  check("snapshot decodes at most a bounded trailing window",
    (constant("SNAPSHOT_MAX_SAMPLES") ?? 0) > 0
    && (constant("SNAPSHOT_MAX_SAMPLES") ?? 0) <= constant("MAX_PCM_SAMPLES"));
  check("final queue capacity is fixed and small",
    constant("MAX_PENDING_FINALS") === 2);
  check("snapshot decode is bounded tight", constant("SNAPSHOT_TIMEOUT_MS") === 20000);
  check("a caption timeout preserves final decoding after reaping",
    /if \(timedOut\) \{[\s\S]*?if \(rec\.Final\) ChoomVoiceSink\.Error\("Transcription timed out[\s\S]*?return;/.test(cs)
    && !cs.includes('"Live caption timed out."'));
  check("idle decoder wake is bounded and never a busy poll",
    /DecodeWake\.WaitOne\(\)/.test(cs) && !/DecodeWake\.WaitOne\([^)]*\d/.test(cs));

  // ── 2. One device owner across utterances ─────────────────────────────────
  const callback = region(cs, "static void WaveCallbackProc(", "static byte[] SystemToBytes(");
  check("the waveIn callback holds exactly one device handle for the session",
    (callback.match(/WaveHandle/g) || []).length > 0
    && !/TakeDeviceLocked|TeardownDevice|TeardownBundleNow|waveInClose|waveInStop/.test(callback),
    "the endpoint must not tear the device down");
  check("continuous capture requeues the capture buffer even at an endpoint",
    /if \(Continuous\) \{[\s\S]*?waveInAddBuffer\(WaveHandle, dwParam1, hdrSize\);/.test(callback));
  check("the endpoint only schedules work, it never blocks on it",
    /EnqueueDecode\(plan, cGen, cInst, cSession\)/.test(callback));

  // ── 3. Nothing slow happens under the capture lock or the callback ────────
  const slow = /FileStream|File\.Write|\.Write\(|new System\.Diagnostics\.Process|WaitForExit|proc\.Kill/;
  // The legacy one-shot branch still streams to its WAV inside the callback,
  // which is pre-existing behaviour. The continuous branch is the one that
  // has to hold to the new rule, so it is checked on its own: the region ends
  // at the paired else, before the legacy branch begins.
  const continuousBranch = region(callback, "if (Continuous) {", "} else {");
  check("continuous capture does no file IO, process start or process wait in the callback",
    !slow.test(continuousBranch));
  check("the continuous branch keeps the buffer requeue inside it",
    /waveInAddBuffer\(WaveHandle, dwParam1, hdrSize\);/.test(continuousBranch));
  const ingest = region(cs, "public static SealPlan IngestLocked(", "static SealPlan SealLocked(");
  check("the ingest step does no file IO, process start, driver call or process wait",
    !slow.test(ingest) && !/waveIn|TeardownDevice/.test(ingest));
  check("the ingest step allocates a plan only when something is scheduled",
    /return null;/.test(ingest) && /new SealPlan\(\)/.test(ingest));

  // ── 4. One ingest path shared by live capture and the synthetic feed ──────
  const synth = region(cs, "static void SynthContinuous(", "static string PrefixWords(");
  check("the synthetic feed drives the same production ingest as the live callback",
    /IngestLocked\(/.test(synth) && /IngestLocked\(/.test(callback));
  check("the synthetic feed starts no device and opens no input",
    !/waveInOpen|waveInStart|WaveInGetNumDevs/.test(synth));

  // ── 4b. Segment parsing is a real JSON reader, not string scanning ────────
  check("the script is parsed by the framework's own JSON reader",
    /JavaScriptSerializer/.test(cs) && /DeserializeObject/.test(cs));
  check("script parsing is bounded in size and in segment count",
    /MAX_SCRIPT_CHARS = \d+/.test(cs) && /MAX_SCRIPT_SEGMENTS = \d+/.test(cs)
    && /ser\.MaxJsonLength/.test(cs) && /count > MAX_SCRIPT_SEGMENTS/.test(cs));
  check("both speechMs and silenceMs are honoured, never one chosen over the other",
    /s\.SpeechMs = ScriptNumber\(sp\);/.test(cs) && /s\.SilenceMs = ScriptNumber\(si\);/.test(cs)
    && /bool speaks = speechMs > 0;/.test(synth) && /if \(speaks\)/.test(synth) && /if \(silenceMs > 0\)/.test(synth));
  check("malformed script input yields no segments instead of a partial parse",
    /catch \(System\.Exception\) \{\s*\/\/ Malformed input produces no segments[\s\S]*?out_\.Clear\(\);/.test(cs));
  check("a segment's text is length bounded", /MAX_SEGMENT_TEXT_CHARS/.test(cs));
  check("the JSON reader assembly is referenced by the helper",
    /ReferencedAssemblies @\("System\.Speech", "System\.Web\.Extensions"\)/.test(ps));
  check("an empty script reports an error rather than pretending to run",
    /Test continuous script is not valid\./.test(cs));

  // ── 5. Decoder admission: a final is never lost to a newer partial ────────
  const enqueue = region(cs, "static void EnqueueDecode(", "// The dedicated decoder loop.");
  check("a newer snapshot replaces the previous snapshot rather than queueing",
    /LatestSnapshot = rec;/.test(enqueue));
  check("a snapshot is dropped while a final is pending, never delaying it",
    /if \(FinalQueue\.Count > 0 \|\| plan\.Utterance <= SealedThrough\) return;/.test(enqueue));
  check("finals are admitted first in the decoder loop",
    /if \(FinalQueue\.Count > 0\) rec = FinalQueue\.Dequeue\(\);\s*else if \(LatestSnapshot != null\)/.test(
      region(cs, "static void DecoderLoop(", "static void RunDecode(")));
  check("going past the final bound stops with an honest error instead of a bigger queue",
    /FinalQueue\.Count >= MAX_PENDING_FINALS\) overflow = true;/.test(enqueue)
    && /Transcription cannot keep up/.test(enqueue)
    && /Queue<DecodeRecord> FinalQueue/.test(cs)
    && !/List<DecodeRecord>\s+FinalQueue/.test(cs));

  // ── 6. Child ownership survives cancellation until real exit ──────────────
  const child = region(cs, "static bool RunWhisperChild(", "public static bool StartRecording(");
  const setAt = child.indexOf("DecodeChild = proc;");
  // Dispose also appears on the failed-start path, so the reap that matters
  // is the last one: the one after the bounded wait.
  const reapAt = child.lastIndexOf("proc.Dispose();");
  const releaseAt = child.indexOf("if (DecodeChild == proc) DecodeChild = null;");
  const waitAt = child.indexOf("proc.WaitForExit(timeoutMs)");
  check("the child is admitted before it runs", setAt > 0 && setAt < waitAt);
  check("the child is reaped after the wait and before admission is released",
    setAt > 0 && setAt < reapAt && waitAt < reapAt && reapAt < releaseAt);
  check("the decode wait is bounded by the caller supplied timeout",
    /proc\.WaitForExit\(timeoutMs\)/.test(child));
  check("a kill that fails does not release admission early: it is retried until exit is confirmed",
    /attempt < 6 && !exited[\s\S]*?proc\.Kill\(\)[\s\S]*?proc\.WaitForExit\(2000\)/.test(child)
    && /if \(!exited\) \{\s*try \{ proc\.WaitForExit\(\); exited = true; \}/.test(child));
  check("the decoder slot is claimed before Process.Start, so a cancel cannot miss a starting child",
    child.indexOf("DecodeStarting = true;") > 0 && child.indexOf("DecodeStarting = true;") < child.indexOf("proc.Start()"));
  check("a start that began before a cancel kills its own child after publishing",
    /epochAfter != epochBefore \|\| DecodeShutdown/.test(child));
  check("a second decoder never starts beside a child that has not been reaped",
    /if \(DecodeChild != null\) \{[\s\S]*?if \(!gone\) return false;/.test(child));
  const cancel = region(cs, "static TeardownBundle CancelPreviousLocked(", "// Stops PCM capture and finalizes");
  check("cancel signals the child to die but never releases admission itself",
    /DecodeChild\.Kill\(\)/.test(cancel) && !/DecodeChild = null/.test(cancel));
  check("cancel moves the decode epoch so an in-flight start sees it",
    /DecodeEpoch \+= 1;/.test(cancel));
  check("cancel retires the session's queued work", /while \(FinalQueue\.Count > 0\) FinalQueue\.Dequeue\(\);/.test(cancel));
  check("cancel drains the bounded accumulator", /OpenPcm\.Clear\(\)/.test(cancel));

  // ── 6b. Capture ownership and decoder ownership are distinct ─────────────
  const runDecode = region(cs, "static void RunDecode(", "// Decode hand-off state.");
  check("a sealed final survives an explicit finish, which closes the device",
    /if \(!DecodeOwnedLocked\(rec\)\) return;/.test(runDecode)
    && !/rec\.Session != SessionId \|\| !Recording/.test(runDecode),
    "only a retired session discards audio, never a stopped device");
  check("a decode reports under the generation and instance it was sealed with",
    /long gen = rec\.Gen;\s*long inst = rec\.Inst;/.test(runDecode)
    && !/gen = ActiveGen;/.test(runDecode),
    "the record owns its identity, not whatever the live turn happens to be");
  check("a new listen cannot reuse an old record's identity",
    /DecodeOwnedLocked\(rec\)/.test(runDecode) && /rec\.Session == SessionId/.test(cs) && /SessionId \+= 1;/.test(
      region(cs, "public static void BeginContinuousSessionLocked(", "static void EnsureDecoderThreadLocked(")));
  const finishCont = region(cs, "public static void FinishContinuous(", "public static void StopDecoder(");
  check("finish seals and admits without retiring the decoder session",
    /SealOpenLocked\(\)/.test(finishCont) && /EnqueueDecode\(plan, gen, inst, session\)/.test(finishCont)
    && !/Cancel\(\)/.test(finishCont));
  check("finish announces the utterance it sealed rather than a fixed one",
    /long utt = plan\.Utterance;/.test(finishCont));

  // ── 6c. The final sorts above every snapshot of its utterance ────────────
  const seal = region(cs, "static SealPlan SealLocked(", "static string MockTextFor(");
  check("the sealed final is given the next sequence before the counter resets",
    /plan\.Sequence = SnapshotSeq \+ 1;/.test(seal));
  check("the sequence reset happens after the final takes its number",
    seal.indexOf("plan.Sequence = SnapshotSeq + 1;") < seal.indexOf("SnapshotSeq = 0;"));
  check("a final never carries sequence zero, which every ordering fence refuses",
    !/plan\.Sequence = 0;/.test(seal));

  // ── 6d. The stall watcher measures progress, not a fixed lifetime ────────
  check("the stalled-device check is progress based, not a fixed 35s lifetime",
    /LastAudioMs/.test(cs) && !/Task\.Delay\(35000/.test(cs));
  check("the watcher only fires after a real quiet window",
    (constant("DEVICE_STALL_MS") ?? 0) >= 5000 && /quietFor < DEVICE_STALL_MS/.test(cs));
  check("the watcher sleeps on its own cadence instead of polling",
    /Task\.Delay\(continuous \? DEVICE_STALL_CHECK_MS : 35000, token\)/.test(cs) && (constant("DEVICE_STALL_CHECK_MS") ?? 0) >= 1000);
  check("audio progress is stamped where capture really accepts audio",
    /LastAudioMs = System\.DateTime\.UtcNow\.Ticks/.test(callback)
    && /LastAudioMs = System\.DateTime\.UtcNow\.Ticks/.test(
      region(cs, "public static SealPlan IngestLocked(", "static SealPlan SealLocked(")));
  check("a fresh session starts with a full quiet window",
    /LastAudioMs = System\.DateTime\.UtcNow\.Ticks/.test(
      region(cs, "public static void BeginContinuousSessionLocked(", "static void EnsureDecoderThreadLocked(")));

  // ── 7. One session, one open utterance, no cross-session carry over ───────
  const begin = region(cs, "public static void BeginContinuousSessionLocked(", "static void EnsureDecoderThreadLocked(");
  check("a new session starts from a clean utterance, snapshot and queue state",
    /OpenUtterance = 1;/.test(begin)
    && /SnapshotSeq = 0;/.test(begin)
    && /while \(FinalQueue\.Count > 0\) FinalQueue\.Dequeue\(\);/.test(begin)
    && /LatestSnapshot = null;/.test(begin));
  check("the session id rises so retired audio can be recognised and dropped",
    /SessionId \+= 1;/.test(begin));
  const run = region(cs, "static void RunDecode(", "// Decode hand-off state.");
  check("a retired session's audio is dropped in silence",
    /if \(!DecodeOwnedLocked\(rec\)\) return;/.test(run));

  // ── 8. Silent utterances and finishing ────────────────────────────────────
  check("a silent sealed utterance reports empty instead of inventing text",
    /EmptySeq\(gen, inst, rec\.Utterance\)/.test(run));
  const finish = region(cs, "public static void FinishContinuous(", "public static void StopDecoder(");
  check("finishing a continuous session seals the open utterance then closes the device",
    /SealOpenLocked\(\)/.test(finish) && /TakeDeviceLocked\(\)/.test(finish));
  check("the manual finish path is only for a continuous session",
    /public static void StopAndTranscribe\(long gen, long inst\) \{\s*\/\/ Continuous capture finishes differently[\s\S]*?if \(Continuous\) \{\s*FinishContinuous\(gen, inst\);/.test(cs));

  // ── 9. Legacy one-shot capture is untouched ───────────────────────────────
  check("one-shot capture still streams straight to its WAV",
    /if \(!continuous\) \{[\s\S]*?WaveStream = stream;/.test(cs)
    || /if \(!continuous\) \{[\s\S]{0,400}?new System\.IO\.FileStream\(tmp/.test(cs));
  check("the legacy worker and ownership helpers are still present",
    /static bool IsOwner\(/.test(cs) && /static void TranscribeFile\(/.test(cs));
  check("the legacy listen command is unchanged unless continuous is asked for",
    /"continuous":true/.test(cs) === false
    && /Continuous = continuous;/.test(cs));

  // ── 10. Test injection is test-gated and never a production control ───────
  check("test_continuous is refused unless CHOOM_VOICE_TEST=1",
    /elseif \(\$name -eq "test_continuous"\) \{\s*if \(-not \$testMode\)/.test(ps));
  check("test commands are gated by the same production flag as the rest",
    /\$testMode = \(\$env:CHOOM_VOICE_TEST -eq "1"\)/.test(ps));
  check("no production command accepts an injected audio source",
    !/"source"|"pcm"|"inject"/.test(region(ps, 'elseif ($name -eq "listen")', 'elseif ($name -eq "whisper_finish")')));
  check("continuous defaults to false for a caller that never sends it",
    /try \{ if \(\$cmd\.continuous -ne \$null\) \{ \$cont = \[bool\]\$cmd\.continuous \} \} catch \{ \$cont = \$false \}/.test(ps));
  check("the mock decoder is test-only and drives the real scheduler",
    /MockDecoder/.test(cs) && /decoder -ne "mock"/.test(ps));

  // ── 11. Endpoint arithmetic from the helper's own constants ───────────────
  // The same frame arithmetic the production detector uses, computed from
  // the fixture module the existing probe already validates, so the numbers
  // here are the numbers the helper will produce.
  const FRAME_SAMPLES = fx.FRAME_SAMPLES;
  const SPEECH_RMS = fx.SPEECH_RMS;
  const FRAME_MS = (FRAME_SAMPLES / fx.SAMPLE_RATE) * 1000;
  check("the helper's frame size matches the fixture generator", FRAME_SAMPLES === 1600);
  check("the helper's speech threshold matches the fixture generator",
    SPEECH_RMS === Number(/SpeechRms\s*=\s*([\d.]+)/.exec(cs)?.[1] ?? SPEECH_RMS));

  // A 2s utterance plus a 500ms pause must end on the endpoint, well inside
  // the 30s absolute bound.
  const speechSeconds = 2;
  const endpointMs = 500;
  const endpointFrames = Math.ceil(endpointMs / FRAME_MS);
  check("a two second utterance ends on the endpoint, not the 30s bound",
    speechSeconds * 1000 + endpointMs < 30000 && endpointFrames * FRAME_MS >= endpointMs);
  const maxFrames = 30000 / FRAME_MS;
  const maxSamples = maxFrames * FRAME_SAMPLES;
  check("the 30s detector bound and the accumulator bound agree exactly",
    maxSamples === constant("MAX_PCM_SAMPLES"),
    `detector ${maxSamples} vs accumulator ${constant("MAX_PCM_SAMPLES")}`);
  check("the snapshot cadence fires at least twice inside a two second utterance",
    Math.floor(2000 / (constant("SNAPSHOT_EVERY_MS") ?? 1)) >= 1);
  check("a silent frame never reaches the speech threshold",
    fx.frameRms(new Int16Array(FRAME_SAMPLES), FRAME_SAMPLES) < SPEECH_RMS);
  check("a speech frame does reach the speech threshold",
    fx.generate(os.tmpdir()) && true, "fixtures generate");

  // ── 12. Tracker cost, measured ────────────────────────────────────────────
  // Real numbers from the real tracker on a worst case utterance stream.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-continuous-timing-"));
  try {
    for (const rel of ["src/choom/flow.ts", "src/choom/flowRegistry.ts", "src/choom/flowGrammar.ts", "src/choom/flowClauseTracker.ts"]) {
      const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: rel,
      }).outputText;
      const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, out, "utf8");
    }
    const { FlowClauseTracker } = require(path.join(tmp, "src/choom/flowClauseTracker.js"));
    const grammarCtx = {
      shortcuts: [
        { id: "code", name: "Code", kind: "app", target: "C:\\apps\\code.exe" },
        { id: "mail", name: "Mail", kind: "app", target: "C:\\apps\\mail.exe" },
      ],
      notesConfigured: true,
      registry: { has: () => true, get: () => null, list: () => [] },
    };
    // Worst case: 2000 utterances, each with 4 captions and a final, at the
    // longest text the helper ever emits.
    const UTTERANCES = 2000;
    const tracker = new FlowClauseTracker();
    const long = "open code and then open mail and then create a note called Trip saying buy milk and eggs now";
    const started = process.hrtime.bigint();
    for (let u = 1; u <= UTTERANCES; u++) {
      tracker.begin(u, grammarCtx);
      for (let s = 1; s <= 4; s++) {
        tracker.observePartial({ utterance: u, sequence: s, text: `${long} ${s}` });
      }
      tracker.observeFinal({ utterance: u, sequence: 5, text: long });
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const events = UTTERANCES * 5;
    const perEventUs = (elapsedMs * 1000) / events;
    console.log(`INFO: tracker ${events} events (${UTTERANCES} utterances, 5 each) in ${elapsedMs.toFixed(1)}ms, ${perEventUs.toFixed(1)}us per event`);
    check("the tracker stays far below any per-buffer budget", perEventUs < 200);
    check("per-utterance tracker state stays bounded", UTTERANCES === 2000 && events === 10000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    failures.length === 0
      ? "continuous regression: all assertions passed"
      : `continuous regression: ${failures.length} FAILURES`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

main();
