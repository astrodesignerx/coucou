// Jev frontend regression: local bypass, Shadow invariance, Assisted bounds,
// fallback preservation and cancel fencing. Run from windows/:
// node scripts/jev-regression.cjs

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-jev-test-"));
  try {
    const jevPath = compile("src/choom/jev.ts", tmp);
    const J = require(jevPath);

    // Exact model and endpoint, never substituted.
    assert.equal(J.JEV_MODEL, "jev-1.13-free");
    assert.equal(J.JEV_ENDPOINT, "https://opencode.ai/zen/v1/systemone");

    // Local tools bypass Jev: only agent fallback asks.
    for (const kind of ["media", "app", "folder", "routine", "ambiguous", "refused"]) {
      assert.equal(J.shouldAskJev(kind), false, `${kind} must bypass Jev`);
    }
    assert.equal(J.shouldAskJev("agent"), true);

    // Eligibility: explicit opt-in, non-off mode and configured credential.
    const base = { jevEnabled: true, jevMode: "shadow" };
    assert.equal(J.isJevEligible({ ...base }, true), true);
    assert.equal(J.isJevEligible({ ...base, jevEnabled: false }, true), false);
    assert.equal(J.isJevEligible({ ...base, jevMode: "off" }, true), false);
    assert.equal(J.isJevEligible({ ...base }, false), false);
    assert.equal(J.isJevEligible({ ...base, jevMode: "assisted" }, true), true);

    // Shadow leaves behavior unchanged.
    assert.equal(J.shadowPreservesExecution("shadow"), true);
    assert.equal(J.shadowPreservesExecution("assisted"), false);

    // Assisted can only choose answer vs options/clarify. Never executes.
    const eligibleIds = ["notes", "code"];
    assert.deepEqual(
      J.assistedNextStep({ route: "answer", confidence: 0.9, candidateId: null }, eligibleIds).action,
      "answer",
    );
    assert.deepEqual(
      J.assistedNextStep({ route: "options", confidence: 0.9, candidateId: null }, eligibleIds).action,
      "show_options",
    );
    assert.deepEqual(
      J.assistedNextStep({ route: "clarify", confidence: 0.9, candidateId: null }, eligibleIds).action,
      "show_clarify",
    );
    // A validated local id still becomes an explicit choice, never auto-run.
    const local = J.assistedNextStep(
      { route: "supported_local", confidence: 0.9, candidateId: "notes" },
      eligibleIds,
    );
    assert.equal(local.action, "show_options");
    assert.equal(local.candidateId, null);
    // Unknown candidate never invents a target.
    const ghost = J.assistedNextStep(
      { route: "supported_local", confidence: 0.9, candidateId: "ghost" },
      eligibleIds,
    );
    assert.equal(ghost.action, "show_options");
    assert.equal(ghost.candidateId, null);
    assert.equal(
      J.assistedNextStep({ route: "unknown", confidence: 0.9, candidateId: null }, eligibleIds).action,
      "fallback",
    );
    assert.equal(
      J.assistedNextStep({ route: "execute", confidence: 0.99, candidateId: null }, eligibleIds).action,
      "fallback",
    );

    // Exact candidate validation.
    assert.equal(J.jevCandidateAllowed("notes", [{ id: "notes", label: "Notes" }]), true);
    assert.equal(J.jevCandidateAllowed("ghost", [{ id: "notes", label: "Notes" }]), false);
    assert.equal(J.jevCandidateAllowed(null, [{ id: "notes", label: "Notes" }]), false);

    // Fallback preserves request and model: receipts carry no raw content.
    const receipt = J.outcomeToReceipt(
      { route: "answer", confidence: 0.9, latencyMs: 42, fallbackReason: null, mode: "shadow" },
      123,
    );
    assert.equal(receipt.route, "answer");
    assert.equal(receipt.mode, "shadow");
    const line = J.formatJevReceipt(receipt);
    assert.ok(line.includes("answer") && line.includes("shadow"));
    assert.ok(!line.includes("open my notes"), "receipt must not leak request text");
    const bad = J.outcomeToReceipt(
      { route: "execute", confidence: NaN, latencyMs: NaN, fallbackReason: "timeout", mode: "weird" },
      1,
    );
    assert.equal(bad.route, "unknown");
    assert.equal(bad.confidence, 0);
    assert.equal(bad.mode, "shadow");

    // Bounds. Approved minimum is 0.75 everywhere.
    assert.equal(J.clampJevThreshold(NaN), 0.75);
    assert.equal(J.clampJevThreshold(0.1), 0.75);
    assert.equal(J.clampJevThreshold(0.6), 0.75);
    assert.equal(J.clampJevThreshold(0.75), 0.75);
    assert.equal(J.clampJevThreshold(0.8), 0.8);
    assert.equal(J.clampJevThreshold(0.99), 0.95);
    assert.equal(J.clampJevDeadlineMs(NaN), 2500);
    assert.equal(J.clampJevDeadlineMs(10), 500);
    assert.equal(J.clampJevDeadlineMs(99999), 8000);
    assert.equal(J.normalizeJevMode("turbo"), "shadow");

    // Simulated controller mirrors production decideWithJev branching:
    // disabled, Shadow, cancellation fence and Assisted fallthrough rules.
    // Grounding uses only real saved app/folder shortcuts, never invented.
    async function simulateTurn({ localKind, jevMode, jevEnabled, outcome, generation, current, clean, shortcuts }) {
      const calls = { jev: 0, chat: null, toolRun: 0, ambiguity: 0, refill: null };
      if (localKind !== "agent") return { ...calls, path: "local-bypass" };
      if (generation !== current) return { ...calls, path: "stale-drop" };
      const settings = { jevEnabled, jevMode };
      if (!J.isJevEligible(settings, true)) {
        calls.chat = "agent-fallback";
        return { ...calls, path: "fallback" };
      }
      calls.jev += 1;
      const shadow = J.shadowPreservesExecution(jevMode);
      const rec = J.outcomeToReceipt(outcome, Date.now());
      void rec;
      if (shadow) {
        calls.chat = "agent-fallback";
        return { ...calls, path: "shadow-unchanged" };
      }
      if (outcome.fallbackReason) {
        calls.chat = "agent-fallback";
        return { ...calls, path: "fallback" };
      }
      const threshold = J.clampJevThreshold(0.75);
      if (!Number.isFinite(outcome.confidence) || outcome.confidence < threshold) {
        calls.chat = "agent-fallback";
        return { ...calls, path: "fallback" };
      }
      const step = J.assistedNextStep(outcome, eligibleIds);
      if (step.action === "answer" || step.action === "fallback") {
        calls.chat = "agent-fallback";
        return { ...calls, path: "assisted-answer" };
      }
      if (step.action === "show_clarify") {
        // Editable clarification: the submitted request is kept, not lost.
        calls.refill = clean;
        return { ...calls, path: "assisted-clarify" };
      }
      // show_options and supported_local: a validated candidate becomes one
      // explicit choice; unvalidated supported_local falls through.
      if (outcome.candidateId && eligibleIds.includes(outcome.candidateId)) {
        calls.ambiguity += 1;
        return { ...calls, path: "assisted-single" };
      }
      if (outcome.route === "supported_local") {
        calls.chat = "agent-fallback";
        return { ...calls, path: "assisted-fallthrough" };
      }
      const grounded = (shortcuts ?? []).filter((s) => s.kind === "app" || s.kind === "folder");
      if (grounded.length === 0) {
        calls.chat = "agent-fallback";
        return { ...calls, path: "assisted-fallthrough" };
      }
      calls.ambiguity = grounded.length;
      return { ...calls, path: "assisted-options" };
    }

    const savedShortcuts = [
      { id: "notes", name: "Notes", kind: "folder", target: "D:\\notes" },
      { id: "code", name: "Code", kind: "app", target: "C:\\t\\code.exe" },
    ];

    // Disabled mode never calls Jev and falls back to the agent path.
    let sim = await simulateTurn({ localKind: "agent", jevMode: "shadow", jevEnabled: false,
      outcome: { route: "answer", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open notes", shortcuts: savedShortcuts });
    assert.equal(sim.jev, 0);
    assert.equal(sim.chat, "agent-fallback");

    // Local tools bypass Jev entirely.
    sim = await simulateTurn({ localKind: "app", jevMode: "shadow", jevEnabled: true,
      outcome: { route: "answer", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open code", shortcuts: savedShortcuts });
    assert.equal(sim.jev, 0);
    assert.equal(sim.path, "local-bypass");

    // Shadow records but the agent path still runs with the original request.
    sim = await simulateTurn({ localKind: "agent", jevMode: "shadow", jevEnabled: true,
      outcome: { route: "options", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open notes", shortcuts: savedShortcuts });
    assert.equal(sim.path, "shadow-unchanged");
    assert.equal(sim.chat, "agent-fallback");
    assert.equal(sim.toolRun, 0);

    // Assisted clarify keeps the submitted request editable, runs nothing.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "clarify", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open notes", shortcuts: savedShortcuts });
    assert.equal(sim.path, "assisted-clarify");
    assert.equal(sim.refill, "open notes");
    assert.equal(sim.chat, null);
    assert.equal(sim.toolRun, 0);

    // Assisted options shows only real saved targets, executes nothing.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "options", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open notes", shortcuts: savedShortcuts });
    assert.equal(sim.path, "assisted-options");
    assert.equal(sim.ambiguity, 2);
    assert.equal(sim.chat, null);
    assert.equal(sim.toolRun, 0);

    // Assisted options with nothing saved falls through to the agent answer.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "options", confidence: 0.9, candidateId: null }, generation: 1, current: 1,
      clean: "open notes", shortcuts: [] });
    assert.equal(sim.path, "assisted-fallthrough");
    assert.equal(sim.chat, "agent-fallback");

    // Assisted supported_local without a validated candidate falls through,
    // never inventing a target.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "supported_local", confidence: 0.9, candidateId: "ghost" }, generation: 1, current: 1,
      clean: "open notes", shortcuts: savedShortcuts });
    assert.equal(sim.path, "assisted-fallthrough");
    assert.equal(sim.chat, "agent-fallback");
    assert.equal(sim.toolRun, 0);

    // Fallback preserves the request path.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "unknown", confidence: 0, fallbackReason: "timeout", candidateId: null },
      generation: 1, current: 1 });
    assert.equal(sim.chat, "agent-fallback");

    // Cancel prevents stale execution: no chat, no tool run.
    sim = await simulateTurn({ localKind: "agent", jevMode: "assisted", jevEnabled: true,
      outcome: { route: "answer", confidence: 0.9, candidateId: null }, generation: 1, current: 2 });
    assert.equal(sim.path, "stale-drop");
    assert.equal(sim.chat, null);
    assert.equal(sim.toolRun, 0);

    // Rendered controls exist: settings section and deck receipt wiring.
    const section = fs.readFileSync(path.join(ROOT, "src/choom/voiceSection.ts"), "utf8");
    assert.ok(section.includes("Request routing (Jev)"));
    assert.ok(section.includes("jev-1.13-free"));
    assert.ok(section.includes("https://opencode.ai/zen/v1/systemone"));
    assert.ok(section.includes('value: "shadow"') || section.includes('"shadow"'));
    assert.ok(section.includes("voice-jev-receipt"));
    assert.ok(section.includes("Shadow (record only)"));
    assert.ok(section.includes("Assisted (answer or clarify)"));
    assert.ok(section.includes('min: "75"'), "threshold control starts at the 0.75 minimum");
    assert.ok(section.includes("setJevEditFiller"), "clarify refills the edit field");
    // Legacy typed entry is explicitly Shadow only, not Assisted parity.
    const chat = fs.readFileSync(path.join(ROOT, "src/views/chat.ts"), "utf8");
    assert.ok(chat.includes('jevMode === "shadow"'), "legacy chat entry stays Shadow only");

    // No banned sentence connectors in new Jev copy.
    for (const rel of ["src/choom/jev.ts", "src-tauri/src/choom/jev.rs",
      "scripts/jev-regression.cjs"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("jev regression: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
