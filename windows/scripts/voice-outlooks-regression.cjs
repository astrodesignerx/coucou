// Voice outlooks regression: ribbon default, task instance, confirm first,
// draft retention, accessible controls and slot timer disposal.
// Run from windows/: node scripts/voice-outlooks-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");

function compile(rel, tmp) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  }).outputText;
  const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  return dest;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-voice-outlooks-"));
  try {
    compile("src/choom/voice.ts", tmp);
    const V = require(path.join(tmp, "src/choom/voice.js"));
    const { Voice } = V;

    // Mode changes: manual pin wins, Auto defaults to the ribbon.
    assert.equal(V.resolveDeckMode("b", 0, false, false), "b");
    assert.equal(V.resolveDeckMode("c", 5, false, false), "c");
    assert.equal(V.resolveDeckMode("a", 5, true, true), "a");
    assert.equal(V.resolveDeckMode("auto", 0, false, false), "a");
    // B is manual only: many lines never auto expand.
    assert.equal(V.resolveDeckMode("auto", 8, false, false), "a");
    // C only for context or actionable work.
    assert.equal(V.resolveDeckMode("auto", 0, true, false), "c");
    assert.equal(V.resolveDeckMode("auto", 0, false, true), "c");
    assert.equal(V.validDeckMode("auto"), true);
    assert.equal(V.validDeckMode("b"), true);
    assert.equal(V.validDeckMode("x"), false);

    // Deck follows actual state and returns to A once resolved.
    Voice.state.deckPin = "auto";
    Voice.state.context = null;
    Voice.state.routinePreview = null;
    Voice.state.ambiguity = [];
    Voice.state.approvalNote = null;
    Voice.state.receipt = null;
    Voice.state.stable = [];
    assert.equal(Voice.deckMode(), "a");
    // Receipt alone stays on the ribbon.
    Voice.state.receipt = { target: "Agent", status: "ok", message: "Preview done." };
    Voice.state.stable = [{ id: 1, text: "hello", final: true }];
    assert.equal(Voice.deckMode(), "a");
    // Actual steps open the instance.
    Voice.state.routinePreview = { routineId: "design", name: "Design workspace" };
    assert.equal(Voice.deckMode(), "c");
    Voice.state.routinePreview = null;
    assert.equal(Voice.deckMode(), "a");
    // Pending choices open the instance.
    Voice.state.ambiguity = [{ id: "notes", name: "Notes", kind: "folder", target: "D:\\p" }];
    assert.equal(Voice.deckMode(), "c");
    Voice.state.ambiguity = [];
    assert.equal(Voice.deckMode(), "a");
    // Approvals open the instance.
    Voice.state.approvalNote = "That needs an explicit click.";
    assert.equal(Voice.deckMode(), "c");
    Voice.state.approvalNote = null;
    assert.equal(Voice.deckMode(), "a");
    // Context opens the instance, clearing it returns to the ribbon.
    Voice.state.context = { kind: "file", label: "notes.txt", name: "notes.txt", path: "C:\\p\\n.txt" };
    assert.equal(Voice.deckMode(), "c");
    Voice.clearContext();
    assert.equal(Voice.deckMode(), "a");
    // B stays reachable by pin only.
    Voice.state.stable = [
      { id: 2, text: "one", final: true },
      { id: 3, text: "two", final: true },
    ];
    assert.equal(Voice.deckMode(), "a");
    Voice.state.deckPin = "b";
    assert.equal(Voice.deckMode(), "b");
    Voice.state.deckPin = "auto";

    // Confirm first: finals aggregate and wait, Enter submits once.
    V.resetSubmissionGuard();
    Voice.state.generation = 41;
    Voice.state.runtime = "listening";
    Voice.state.stable = [];
    Voice.state.pendingSegments = [];
    assert.equal(Voice.applyFinal("preview confirm line", 41), "preview confirm line");
    assert.deepEqual(Voice.state.pendingSegments, ["preview confirm line"]);
    const taken = Voice.takeSegments();
    assert.equal(taken.aggregate, "preview confirm line");
    V.noteSubmittedSegments(41, taken.aggregate, taken.segments);
    assert.equal(V.wasSubmitted(41, "preview confirm line"), true);
    assert.equal(Voice.applyFinal("preview confirm line", 41), null);
    // Late results for an older turn never act.
    Voice.cancelTurn(42);
    assert.equal(Voice.applyFinal("preview confirm line", 41), null);

    // Source checks: card keeps Mic and Input only.
    const sectionSrc = fs.readFileSync(path.join(ROOT, "src/choom/voiceSection.ts"), "utf8");
    assert.ok(sectionSrc.includes("voice-mic"), "mic control present");
    assert.ok(sectionSrc.includes("voice-input"), "input control present");
    assert.ok(sectionSrc.includes("voice-stop"), "transient stop present");
    assert.ok(!sectionSrc.includes("voice-send"), "send removed from card");
    assert.ok(!sectionSrc.includes("voice-autosend"), "auto send removed from card");
    assert.ok(!sectionSrc.includes("voice-mute"), "card mute removed");
    assert.ok(sectionSrc.includes("voice-slot"), "instance slot present");
    assert.ok(sectionSrc.includes("voice-actions"), "right action group present");
    assert.ok(sectionSrc.includes("voice-editor"), "toggle editor present");
    assert.ok(sectionSrc.includes("aria-expanded"), "input exposes expanded state");
    assert.ok(sectionSrc.includes("aria-label"), "accessible labels present");
    // Editor behavior: Enter submits, Escape keeps the draft.
    assert.ok(sectionSrc.includes("\"Enter\""), "enter submits");
    assert.ok(sectionSrc.includes("\"Escape\""), "escape closes editor");
    assert.ok(sectionSrc.includes("let draft"), "draft retained");
    assert.ok(sectionSrc.includes("setEditor"), "input toggles editor");
    // Slot rotation: shared slot, four second cycle, pause and manual path.
    assert.ok(sectionSrc.includes("4000"), "four second rotation");
    assert.ok(sectionSrc.includes("visibilitychange"), "hidden document pauses");
    assert.ok(sectionSrc.includes(":hover"), "hover pauses");
    assert.ok(sectionSrc.includes(":focus"), "focus pauses");
    assert.ok(sectionSrc.includes("prefers-reduced-motion"), "reduced motion manual cycle");
    assert.ok(sectionSrc.includes("clearTimeout"), "timer disposal present");
    assert.ok(sectionSrc.includes("isConnected"), "disposed card stops timer");
    assert.ok(sectionSrc.includes("export async function toggleMute"), "header can reuse mic mute");
    // Confirm first path stays explicit through the editor.
    assert.ok(sectionSrc.includes("manualVoiceSubmit"), "enter uses manual submit");

    // Header: mute sits between New and Settings with mic state.
    const viewsSrc = fs.readFileSync(path.join(ROOT, "src/views/views.ts"), "utf8");
    const headerActions = viewsSrc.indexOf("header-actions");
    assert.ok(headerActions > 0, "header actions present");
    const muteAt = viewsSrc.indexOf("muteBtn", headerActions - 2000);
    assert.ok(muteAt > 0, "header mute present");
    assert.ok(viewsSrc.includes("void toggleMute"), "header mute reuses mic mute");
    assert.ok(viewsSrc.includes("Mute microphone"), "mic mute label present");
    assert.ok(viewsSrc.includes("Unmute microphone"), "mic unmute label present");
    assert.ok(viewsSrc.includes("aria-pressed"), "mute exposes pressed state");
    // Mute is wired before Settings in the same action row.
    const mutePos = viewsSrc.indexOf("muteBtn, gearBtn");
    assert.ok(mutePos > 0, "mute sits before settings");
    for (const s of ["Mute microphone", "Unmute microphone", "Voice actions"]) {
      assert.ok(!s.includes("\u2014") && !s.includes("\u2013") && !s.includes("\u00b7"), "new mute copy uses plain text");
    }

    // Styles: dot rests, centered group, slot, tokens, motion safety.
    const css = fs.readFileSync(path.join(ROOT, "src/choom/choom.css"), "utf8");
    assert.ok(css.includes("--voice-ease"), "easing token present");
    assert.ok(css.includes("--voice-fast"), "duration token present");
    assert.ok(css.includes("34px"), "34px hit targets present");
    assert.ok(css.includes(".voice-actions"), "action group present");
    assert.ok(css.includes("align-self: center") || css.includes("justify-content: center"), "group centered");
    assert.ok(css.includes(".voice-slot"), "slot style present");
    assert.ok(css.includes("(hover: none)"), "touch shows full controls");
    assert.ok(css.includes("prefers-reduced-motion"), "reduced motion present");
    assert.ok(!css.includes(".voice-send"), "send style removed");
    assert.ok(!css.includes(".voice-autosend"), "auto send style removed");
    assert.ok(css.includes("118px"), "left mascot padding preserved");

    // Fixture: synthetic outlook preview with required states and widths.
    for (const rel of ["dev/voice-outlooks-fixture.html", "dev/voice-outlooks-fixture.ts"]) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} present`);
    }
    const fixTs = fs.readFileSync(path.join(ROOT, "dev/voice-outlooks-fixture.ts"), "utf8");
    assert.ok(fixTs.includes("buildVoiceView"), "fixture uses production view");
    assert.ok(fixTs.includes("setVoiceDeps"), "fixture injects fake deps");
    for (const label of ["idle", "listening", "working", "choice", "approval", "receipt", "error", "draft", "manual", "auto", "400", "560"]) {
      assert.ok(fixTs.toLowerCase().includes(label), `fixture covers ${label}`);
    }
    assert.ok(!fixTs.includes("C:\\Users"), "fixture has no private paths");
    const fixHtml = fs.readFileSync(path.join(ROOT, "dev/voice-outlooks-fixture.html"), "utf8");
    assert.ok(fixHtml.includes("voice-outlooks-fixture.ts"), "html loads fixture module");

    // No banned sentence connectors in new or changed copy. views.ts keeps
    // legacy characters outside this change, so the mute copy is checked
    // directly instead of the whole file.
    for (const rel of [
      "src/choom/voice.ts",
      "src/choom/voiceSection.ts",
      "src/choom/choom.css",
      "dev/voice-outlooks-fixture.ts",
      "dev/voice-outlooks-fixture.html",
      "scripts/voice-outlooks-regression.cjs",
    ]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
      assert.ok(!text.includes("\u00b7"), `${rel} must not contain middle dots`);
    }

    console.log("voice outlooks regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
