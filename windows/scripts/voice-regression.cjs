// Voice frontend regression: duplicate finals, stale guards, deck pins,
// muted wake, echo rejection, malformed JSON limits and memory/context rules.
// Run from windows/: node scripts/voice-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["src/choom/voice.ts"];

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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-voice-test-"));
  try {
    compile(tmp);
    const V = require(path.join(tmp, "src/choom/voice.js"));

    // Duplicate final submission: same generation and text submits once.
    V.resetSubmissionGuard();
    V.noteSubmitted(3, "open notes");
    assert.equal(V.wasSubmitted(3, "open notes"), true);
    assert.equal(V.wasSubmitted(3, "open notes!"), false);
    assert.equal(V.wasSubmitted(4, "open notes"), false);

    // Stale partial/final/reply after cancellation never acts.
    assert.equal(V.isStale(5, 4), true);
    assert.equal(V.isStale(5, 5), false);

    // Mode selection and pinning: manual pin wins, Auto picks by content.
    assert.equal(V.resolveDeckMode("b", 0, false, false), "b");
    assert.equal(V.resolveDeckMode("auto", 0, false, false), "a");
    assert.equal(V.resolveDeckMode("auto", 2, false, false), "b");
    assert.equal(V.resolveDeckMode("auto", 0, true, false), "c");
    assert.equal(V.resolveDeckMode("auto", 0, false, true), "c");
    assert.equal(V.validDeckMode("auto"), true);
    assert.equal(V.validDeckMode("c"), true);
    assert.equal(V.validDeckMode("d"), false);

    // Store guards: muted wake, echo rejection, helper shutdown shape.
    const { Voice } = V;
    Voice.state.generation = 7;
    Voice.state.runtime = "standby";
    Voice.state.muted = true;
    assert.equal(Voice.applyPartial("hello", 7), false);
    Voice.state.muted = false;
    Voice.state.runtime = "speaking";
    assert.equal(Voice.applyPartial("hello", 7), false);
    assert.equal(Voice.applyFinal("hello", 7), null);
    Voice.state.runtime = "listening";
    assert.equal(Voice.applyPartial("hello", 7), true);
    assert.equal(Voice.applyPartial("hello", 8), false);
    V.resetSubmissionGuard();
    assert.equal(Voice.applyFinal("open notes", 7), "open notes");
    assert.equal(Voice.applyFinal("open notes", 7), null);
    Voice.cancelTurn(8);
    assert.equal(Voice.state.generation, 8);
    assert.equal(Voice.state.partial, "");
    // Stable lines survive cancellation for context; transcript is kept.
    assert.equal(Voice.state.stable.length, 1);

    // Endpoint clamp and short talkback.
    assert.equal(V.clampEndpointMs(50), 300);
    assert.equal(V.clampEndpointMs(900), 900);
    assert.equal(V.clampEndpointMs(9000), 3000);
    const spoken = V.speakPreview("one\ntwo\nthree\nfour\nfive\nsix");
    assert.ok(!spoken.includes("five"));

    // Memory opt-in bounds and context removal.
    assert.equal(V.cleanMemoryInput("  remember tea  "), "remember tea");
    assert.equal(V.cleanMemoryInput(" "), null);
    Voice.clearContext();
    assert.equal(Voice.state.context, null);

    // Multi-segment endpoint: finals aggregate into one utterance, once.
    V.resetSubmissionGuard();
    Voice.state.generation = 11;
    Voice.state.runtime = "listening";
    Voice.state.stable = [];
    Voice.state.pendingSegments = [];
    assert.equal(Voice.applyFinal("open my notes", 11), "open my notes");
    assert.equal(Voice.applyFinal("and file it", 11), "and file it");
    assert.deepEqual(Voice.state.pendingSegments, ["open my notes", "and file it"]);
    const taken = Voice.takeSegments();
    assert.equal(taken.aggregate, "open my notes and file it");
    assert.deepEqual(Voice.state.pendingSegments, []);
    // Production notes the aggregate plus its segments: re-delivered finals
    // can never rebuild the same submit.
    V.noteSubmittedSegments(11, taken.aggregate, taken.segments);
    assert.equal(Voice.applyFinal("open my notes", 11), null);
    assert.equal(Voice.applyFinal("and file it", 11), null);

    // Cancel then a new request: the old generation stays late forever.
    Voice.cancelTurn(12);
    assert.equal(Voice.applyFinal("late words", 11), null);
    assert.deepEqual(Voice.state.pendingSegments, []);
    // The full transcript survives cancel and errors.
    assert.ok(Voice.state.stable.length >= 2);
    Voice.state.runtime = "listening";
    Voice.state.generation = 12;
    assert.equal(Voice.applyFinal("fresh words", 12), "fresh words");

    // Bounded transcript: 100 lines newest last, deck B pages of 6.
    Voice.state.stable = [];
    Voice.state.generation = 13;
    Voice.state.runtime = "listening";
    V.resetSubmissionGuard();
    for (let i = 0; i < 105; i++) {
      Voice.state.runtime = "listening";
      Voice.applyFinal(`line ${i}`, 13);
    }
    assert.equal(Voice.state.stable.length, V.MAX_TRANSCRIPT_LINES);
    assert.equal(Voice.state.stable[0].text, "line 5");
    assert.equal(Voice.state.stable[99].text, "line 104");

    // Selected memories only: nothing injects while opt-in is off.
    Voice.state.memoryEnabled = false;
    Voice.state.memories = [{ id: "a", text: "tea", createdMs: 1, source: "user" }];
    Voice.state.selectedMemoryIds = ["a"];
    assert.deepEqual(Voice.selectedMemories(), []);
    Voice.state.memoryEnabled = true;
    assert.deepEqual(Voice.selectedMemories().map((m) => m.id), ["a"]);
    Voice.state.selectedMemoryIds = [];
    assert.deepEqual(Voice.selectedMemories(), []);

    // No banned sentence connectors in new voice copy.
    for (const rel of ["src/choom/voice.ts", "src/choom/voiceSection.ts", "src-tauri/src/choom/voice.rs"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("voice regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
