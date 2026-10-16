// Flow typed grammar regression: the captioned reference sequence, corrections,
// ambiguity and the dictation fall-through. Compiles the real grammar and
// controller modules with the project's TypeScript. No microphone, no Tauri.
// Run from windows/: node scripts/flow-grammar-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["src/choom/flowGrammar.ts", "src/choom/flow.ts", "src/choom/flowRegistry.ts"];

function compile(tmp) {
  for (const rel of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES22 },
      fileName: rel,
    }).outputText;
    const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
  }
}

const SHORTCUTS = [
  { id: "notes", name: "Notes", kind: "app", target: "C:\\Apps\\notes.exe" },
  { id: "editor", name: "Editor", kind: "app", target: "C:\\Apps\\editor.exe" },
  { id: "downloads", name: "Downloads", kind: "folder", target: "C:\\Users\\me\\Downloads" },
  { id: "notes-old", name: "Notes Archive", kind: "folder", target: "C:\\Archive" },
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-flow-grammar-"));
  try {
    compile(tmp);
    const G = require(path.join(tmp, "src/choom/flowGrammar.js"));
    const F = require(path.join(tmp, "src/choom/flow.js"));
    const FR = require(path.join(tmp, "src/choom/flowRegistry.js"));
    const registry = FR.createBaseFlowRegistry();
    const ctx = { shortcuts: SHORTCUTS, notesConfigured: true, registry };
    const spokenCalculator = G.parseFlowCommand("Open your calculator.", 1, {
      ...ctx, shortcuts: [{id:"calculator",name:"Calculator",kind:"app",target:"C:\\Windows\\System32\\calc.exe"}],
    });
    assert.equal(spokenCalculator.kind, "plan");
    assert.equal(spokenCalculator.request.steps[0].target, "C:\\Windows\\System32\\calc.exe");
    const literalYour = G.parseFlowCommand("open Your Notes", 1, {
      ...ctx, shortcuts: [...SHORTCUTS,{id:"your-notes",name:"Your Notes",kind:"app",target:"C:\\Apps\\your-notes.exe"}],
    });
    assert.equal(literalYour.kind, "plan");
    assert.equal(literalYour.request.steps[0].target, "C:\\Apps\\your-notes.exe");

    // Captioned reference sequence: launch the configured notes app, then
    // create and title a local note. The dictated body runs to the end of the
    // utterance: "then search for weather" is note text, never a command the
    // parser splits out from under the user's own words.
    const seq = G.parseFlowCommand(
      "open Notes then create a note titled Meeting notes that says buy milk then search for weather",
      7,
      ctx,
    );
    assert.equal(seq.kind, "plan");
    assert.deepEqual(
      seq.request.steps.map((s) => s.kind),
      ["app.launch", "note.create"],
    );
    assert.equal(seq.request.steps[0].target, "C:\\Apps\\notes.exe");
    assert.equal(seq.request.steps[1].target, "Meeting notes");
    assert.equal(seq.request.steps[1].value, "buy milk then search for weather");
    // Spoken order is preserved through dependency edges. The grammar emits a
    // FlowPlanRequest; planFromRequest assigns the f1,f2 ids its `after`
    // edges already reference, and ordering keeps the spoken sequence.
    const planned = F.planFromRequest(seq.request, Date.now(), registry);
    assert.equal(planned.error, null);
    assert.deepEqual(
      planned.plan.steps.map((s) => s.kind),
      ["app.launch", "note.create"],
    );
    assert.deepEqual(
      planned.plan.steps.map((s) => s.after),
      [[], ["f1"]],
    );

    // Documented create then rename: the rename targets this session's note
    // by explicit reference and plans through the real planner.
    const rename = G.parseFlowCommand("rename note to Trip plan", 1, ctx);
    assert.equal(rename.kind, "plan");
    assert.equal(rename.request.steps[0].kind, "note.rename");
    assert.equal(rename.request.steps[0].target, "session:current");
    assert.equal(rename.request.steps[0].value, "Trip plan");
    const renamePlanned = F.planFromRequest(rename.request, Date.now(), registry);
    assert.equal(renamePlanned.error, null);
    // "rename the note to X" works the same way.
    const renameThe = G.parseFlowCommand("rename the note to Final draft", 1, ctx);
    assert.equal(renameThe.request.steps[0].value, "Final draft");
    // An arbitrary rename target is never guessed: renaming by an old title
    // asks for the session reference instead of failing silently.
    const renameCalled = G.parseFlowCommand("rename the note called Draft to Trip plan", 1, ctx);
    assert.equal(renameCalled.kind, "unclear");
    assert.ok(renameCalled.message.includes("Rename the note from this turn"));

    // Create followed by rename runs through the real planner as one plan.
    // The body is quoted so the following command stays a command.
    const createThenRename = G.parseFlowCommand(
      'create a note titled Draft that says "hello" then rename note to Trip plan', 1, ctx);
    assert.equal(createThenRename.kind, "plan");
    assert.deepEqual(
      createThenRename.request.steps.map((s) => s.kind),
      ["note.create", "note.rename"],
    );
    const createThenRenamePlanned = F.planFromRequest(
      createThenRename.request, Date.now(), registry);
    assert.equal(createThenRenamePlanned.error, null);

    // "open the note" targets this session's note in the configured editor.
    const openNote = G.parseFlowCommand("open the note", 1, ctx);
    assert.equal(openNote.request.steps[0].kind, "note.open");
    assert.equal(openNote.request.steps[0].target, "session:current");

    // Mixed requests are clarified as a whole: the recognized action never
    // runs while the unrecognized clause is silently dropped.
    const mixed = G.parseFlowCommand("tell me a joke then open Notes", 1, ctx);
    assert.equal(mixed.kind, "unclear");
    assert.ok(mixed.message.includes("ran nothing"));
    // A negated command never executes, alone or beside another command.
    const negated = G.parseFlowCommand("do not open Notes", 1, ctx);
    assert.equal(negated.kind, "unclear");
    assert.ok(negated.message.includes("Nothing ran"));
    const negatedMixed = G.parseFlowCommand("open Notes then do not search for weather", 1, ctx);
    assert.equal(negatedMixed.kind, "unclear");

    // A quoted body never splits: connectors inside the quotes are note text.
    const quoted = G.parseFlowCommand(
      'create a note titled Instructions that says "wait then open Notes"', 1, ctx);
    assert.equal(quoted.kind, "plan");
    assert.equal(quoted.request.steps.length, 1);
    assert.equal(quoted.request.steps[0].value, "wait then open Notes");
    // An unquoted body keeps the dictated text whole as well.
    const unquoted = G.parseFlowCommand(
      "create a note titled Instructions that says wait then open Notes", 1, ctx);
    assert.equal(unquoted.kind, "plan");
    assert.equal(unquoted.request.steps.length, 1);
    assert.equal(unquoted.request.steps[0].value, "wait then open Notes");
    // An unclosed quote is clarified, never guessed at.
    const unclosed = G.parseFlowCommand(
      'create a note titled Instructions that says "wait then open Notes', 1, ctx);
    assert.equal(unclosed.kind, "unclear");

    // A folder launch resolves against the saved folder, not the app.
    const folder = G.parseFlowCommand("open Downloads", 1, ctx);
    assert.equal(folder.kind, "plan");
    assert.equal(folder.request.steps[0].kind, "folder.open");
    assert.equal(folder.request.steps[0].target, "C:\\Users\\me\\Downloads");

    // An explicit link is browser.open with no saved target needed.
    const link = G.parseFlowCommand("open https://example.com/a?b=1", 1, ctx);
    assert.equal(link.request.steps[0].kind, "browser.open");
    assert.equal(link.request.steps[0].target, "https://example.com/a?b=1");
    // A www link is upgraded to https so the native guard accepts it.
    const www = G.parseFlowCommand("open www.example.com", 1, ctx);
    assert.equal(www.request.steps[0].target, "https://www.example.com");

    // Ambiguous app name: several saved matches never resolve by guessing.
    // An exact name still wins over a longer substring match.
    const ambCtx = {
      shortcuts: [
        { id: "a", name: "Notes", kind: "app", target: "C:\\a.exe" },
        { id: "b", name: "Notes Pro", kind: "app", target: "C:\\b.exe" },
      ],
      notesConfigured: true,
    };
    const amb = G.parseFlowCommand("open Notes", 1, ambCtx);
    // Exact name "Notes" wins over the substring "Notes Pro".
    assert.equal(amb.kind, "plan");
    assert.equal(amb.request.steps[0].target, "C:\\a.exe");

    // A partial name that matches several saved targets is genuinely ambiguous
    // and returns the options, never a guess.
    const multiCtx = {
      shortcuts: [
        { id: "a", name: "Notes Pro", kind: "app", target: "C:\\a.exe" },
        { id: "b", name: "Notes Plus", kind: "app", target: "C:\\b.exe" },
      ],
      notesConfigured: true,
    };
    const partial = G.parseFlowCommand("open Notes", 1, multiCtx);
    assert.equal(partial.kind, "ambiguous");
    assert.equal(partial.options.length, 2);

    // No saved target: unclear, actionable, never invented.
    const unknown = G.parseFlowCommand("open Photoshop", 1, ctx);
    assert.equal(unknown.kind, "unclear");
    assert.ok(unknown.message.includes("no saved"));

    // Correction retargets a pending note step in place.
    const before = G.parseFlowCommand("create a note titled Draft", 1, ctx).request;
    const corrected = G.applyFlowCorrection(before, "actually call it Final plan");
    assert.ok(corrected);
    assert.equal(corrected.request.steps[0].target, "Final plan");
    assert.ok(corrected.note.includes("Final plan"));
    // A pending rename is corrected through its value, which is what the
    // adapter reads, never through its session target reference.
    const pendingRename = G.parseFlowCommand("rename note to Draft", 1, ctx).request;
    const correctedRename = G.applyFlowCorrection(pendingRename, "call it Final plan");
    assert.equal(correctedRename.request.steps[0].value, "Final plan");
    assert.equal(correctedRename.request.steps[0].target, "session:current");
    // A completed note is never rewritten: the correction becomes a distinct
    // rename step that waits on the completed one and verifies by readback.
    const completedStates = { f1: "completed" };
    const afterRun = G.applyFlowCorrection(before, "call it Final plan", completedStates);
    assert.equal(afterRun.request.steps.length, 2, "a completed note gets its own rename");
    assert.equal(afterRun.request.steps[0].target, "Draft", "the completed step is untouched");
    assert.equal(afterRun.request.steps[1].kind, "note.rename");
    assert.equal(afterRun.request.steps[1].value, "Final plan");
    assert.deepEqual(afterRun.request.steps[1].after, ["f1"]);
    const afterRunPlanned = F.planFromRequest(afterRun.request, Date.now(), registry);
    assert.equal(afterRunPlanned.error, null);
    // An in-flight step is never rewritten under its dispatch.
    const runningStates = { f1: "running" };
    assert.equal(G.applyFlowCorrection(before, "call it X", runningStates), null);
    // A correction with no target phrase does not apply.
    assert.equal(G.applyFlowCorrection(before, "never mind"), null);
    // A correction on a plan with no note step does not apply.
    const noNote = G.parseFlowCommand("open Notes", 1, ctx).request;
    assert.equal(G.applyFlowCorrection(noNote, "call it X"), null);

    // Dictation and non-command speech fall through untouched (null), so the
    // old dictation and agent path keeps owning it.
    assert.equal(G.parseFlowCommand("buy milk and eggs", 1, ctx), null);
    assert.equal(G.parseFlowCommand("what's the weather today", 1, ctx), null);
    assert.equal(G.parseFlowCommand("", 1, ctx), null);

    // Notes are refused when no folder is configured, with an actionable hint.
    const noFolder = G.parseFlowCommand("create a note titled X", 1, {
      shortcuts: SHORTCUTS, notesConfigured: false,
    });
    assert.equal(noFolder.kind, "unclear");
    assert.ok(noFolder.message.includes("notes folder"));

    // "buy milk and eggs" inside a note body is one body, not two clauses.
    const body = G.parseFlowCommand("create a note titled Groceries that says buy milk and eggs", 1, ctx);
    assert.equal(body.kind, "plan");
    assert.equal(body.request.steps.length, 1);
    assert.equal(body.request.steps[0].value, "buy milk and eggs");

    // With no registry given, the guard falls back to the six stable ids.
    assert.equal(G.isSupportedFlowKind("note.create"), true);
    assert.equal(G.isSupportedFlowKind("shell.exec"), false);
    assert.equal(G.isSupportedFlowKind("media.play", registry), true);
    assert.equal(G.isSupportedFlowKind("shell.exec", registry), false);

    // No banned sentence connectors in the new grammar copy.
    for (const rel of ["src/choom/flowGrammar.ts", "src/choom/flowController.ts", "src/choom/flowRegistry.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("flow grammar regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
