// Codex lifecycle regressions: per-session identity, supported events only,
// session-scoped completion, approval release and permission guards. Uses
// fixture payloads, never user files.
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "codex-regression-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/core/state.ts",
    "src/core/layout.ts",
    "src/choom/focus.ts",
    "src/choom/rail.ts",
    "--outDir", out,
    "--module", "commonjs",
    "--target", "es2020",
    "--lib", "es2020,dom",
    "--skipLibCheck",
    "--noUnusedLocals", "false",
    "--noUnusedParameters", "false",
  ],
  { cwd: windowsDir, stdio: "inherit" },
);

const { State } = require(path.join(out, "core/state.js"));
const focusMod = require(path.join(out, "choom/focus.js"));
const { Focus } = focusMod;

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

// Deterministic timers for Stop (5200 ms) and permission (110 s) paths.
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
let clock = 200000;
const scheduled = new Map();
let timerID = 0;
global.setTimeout = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms }); return id; };
global.clearTimeout = (id) => { scheduled.delete(id); };
global.window = {
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
function advance(ms) {
  const target = clock + ms;
  for (let n = 0; n < 100000; n++) {
    let id = null;
    let next = null;
    for (const [key, t] of scheduled) {
      if (t.at <= target && (!next || t.at < next.at)) { id = key; next = t; }
    }
    if (!next) break;
    clock = next.at;
    scheduled.delete(id);
    next.fn();
  }
  clock = target;
}

// Spies.
const acked = [];
const declined = [];
const played = [];
const moments = [];
const islandCalls = [];
const island = {
  alert(v) { islandCalls.push(["alert", v]); },
  reveal() { islandCalls.push(["reveal"]); },
  setView(v) { islandCalls.push(["setView", v]); State.view = v; },
  dropPin() { islandCalls.push(["dropPin"]); },
};
const bridgeStub = {
  Bridge: {
    approvalAck: async (id) => { acked.push(id); },
    approvalDecline: async (id) => { declined.push(id); },
    approvalDecision: async () => {},
    wakeAllowed: async () => true,
    log: async () => {},
  },
  onEvent: async (name, fn) => { bridgeStub.handler = fn; },
};
const soundStub = { Sound: { play: (n) => { played.push(n); } } };

// Load real State/Focus, stub Bridge/Sound, run the real hooks module.
const ts = require(path.join(windowsDir, "node_modules", "typescript"));
const src = fs.readFileSync(path.join(windowsDir, "src", "island", "hooks.ts"), "utf8");
const compiled = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
const customRequire = (name) => {
  if (name.includes("bridge")) return bridgeStub;
  if (name.includes("sound")) return soundStub;
  if (name.includes("state")) return { State };
  if (name.includes("focus")) return focusMod;
  if (name.includes("minibots")) return { createMiniBot: () => ({}), pruneMiniBots: () => {}, syncMiniBotStates: () => {}, tickMiniBots: () => {} };
  return require(name);
};
vm.runInNewContext(compiled, {
  exports: mod.exports,
  module: mod,
  require: customRequire,
  window: global.window,
  performance,
});
const hooks = mod.exports;
hooks.registerHookHandlers(island);
const emit = (payload) => bridgeStub.handler(payload);

async function main() {
  State.tasks = [
    { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true, pillBadge: null },
  ];
  State.focusId = "integration_claude";
  State.mode = "compact";
  State.view = "overview";
  State.pendingApproval = null;
  State.isPinned = false;
  State.paused = false;
  Focus.wakeGate = async () => true;
  Focus.moment = (m) => { moments.push(m); };

  check("codex task ids are stable per session", hooks.codexTaskId("ses-codex-9") === hooks.codexTaskId("ses-codex-9"));
  check("missing session creates no shared pill", hooks.codexTaskId(undefined) === null && hooks.codexTaskId("") === null);
  check("invalid session creates nothing", hooks.codexTaskId("has space!") === null);
  check("different sessions never share a pill", hooks.codexTaskId("ses-a") !== hooks.codexTaskId("ses-b"));
  check(
    "UUID tails cannot collide",
    hooks.codexTaskId("12345678-1234-1234-1234-123456789abc") !== hooks.codexTaskId("12345678-1234-1234-1234-123456789abd"),
  );

  const s1 = "ses-codex-1";
  const s2 = "ses-codex-2";
  emit({ hook_event_name: "SessionStart", coucou_agent: "codex", session_id: s1, cwd: "C:\\repo\\alpha" });
  emit({ hook_event_name: "SessionStart", coucou_agent: "codex", session_id: s2, cwd: "C:\\repo\\beta" });
  // Events without a session id create no pill.
  emit({ hook_event_name: "SessionStart", coucou_agent: "codex", cwd: "C:\\repo\\ghost" });
  const id1 = hooks.codexTaskId(s1);
  const id2 = hooks.codexTaskId(s2);
  check("concurrent sessions create two pills", State.tasks.some((t) => t.id === id1) && State.tasks.some((t) => t.id === id2));
  check("no ghost pill without a session", !State.tasks.some((t) => t.id === "agent_codex"));
  check("codex pills are labelled Codex", (State.tasks.find((t) => t.id === id1)?.name ?? "").startsWith("Codex"));

  emit({ hook_event_name: "UserPromptSubmit", coucou_agent: "codex", session_id: s1, cwd: "C:\\repo\\alpha", prompt: "fix the rail" });
  const t1 = State.tasks.find((t) => t.id === id1);
  const t2 = State.tasks.find((t) => t.id === id2);
  check("prompt routes to its own session", t1.state === "thinking" && t1.steps.at(-1) === "fix the rail" && t2.steps.length === 0);

  emit({ hook_event_name: "PreToolUse", coucou_agent: "codex", session_id: s1, tool_name: "Bash", tool_input: { command: "npm test" } });
  check("tool use stays on its session", t1.state === "working" && t1.steps.at(-1).includes("npm test") && t2.steps.length === 0);

  emit({ hook_event_name: "PostToolUse", coucou_agent: "codex", session_id: s1, coucou_tool_failed: true });
  check("explicit tool failure marks the step but stays working", t1.state === "working" && t1.steps.at(-1).includes("failed"));
  const failedLen = t1.steps.length;
  emit({ hook_event_name: "PostToolUse", coucou_agent: "codex", session_id: s1 });
  check("plain tool output never fabricates failure", t1.state === "working" && t1.steps.length === failedLen);

  const stepsBefore = t1.steps.length;
  emit({ hook_event_name: "PostToolUseFailure", coucou_agent: "codex", session_id: s1 });
  emit({ hook_event_name: "Notification", coucou_agent: "codex", session_id: s1, message: "hello?" });
  emit({ hook_event_name: "SubagentStart", coucou_agent: "codex", session_id: s1 });
  emit({ hook_event_name: "Bogus", coucou_agent: "codex", session_id: s1 });
  check("unsupported events do not fabricate state", t1.steps.length === stepsBefore);

  // Permission reuses the card and takes focus; a second card defers.
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s1, request_id: "req-1", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  check("permission pins the Codex card", State.pendingApproval?.taskId === id1 && State.isPinned === true);
  check("permission acks within the relay window", acked.includes("req-1"));
  check("codex permission takes focus and alerts", State.focusId === id1 && islandCalls.some((c) => c[0] === "alert" && c[1] === "approval"));
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s2, request_id: "req-2", tool_name: "Bash", tool_input: { command: "other" } });
  check("a second card defers to the terminal", declined.includes("req-2") && State.pendingApproval?.requestId === "req-1");
  // Missing request id creates no card and sends no ack.
  const ackedBefore = acked.length;
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s1, tool_name: "Bash", tool_input: { command: "no id" } });
  check("missing request id never creates a card", State.pendingApproval?.requestId === "req-1" && acked.length === ackedBefore);
  // A foreign approval is never cleared by our session events.
  State.pendingApproval = null;
  State.isPinned = false;

  // Finish versus interruption with turn guards.
  emit({ hook_event_name: "Stop", coucou_agent: "codex", session_id: s1, last_assistant_message: "done here" });
  check("stop finishes with the last text", t1.state === "finished" && t1.steps.at(-1) === "done here");
  check("stop never reports error", t1.state !== "error");
  advance(5200);
  check("finish settles back to idle", t1.state === "idle" && t1.pillBadge == null);

  // Old finish timer cannot reset a newer turn.
  emit({ hook_event_name: "Stop", coucou_agent: "codex", session_id: s2, turn_id: "old" });
  emit({ hook_event_name: "UserPromptSubmit", coucou_agent: "codex", session_id: s2, turn_id: "new", prompt: "next task" });
  advance(5300);
  check("old finish timer leaves new turn working", t2.state === "thinking");

  // Interrupt releases its own approval and declines the relay.
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s2, turn_id: "new", request_id: "req-interrupt", tool_name: "Bash", tool_input: { command: "checks" } });
  State.view = "approval";
  emit({ hook_event_name: "Interrupt", coucou_agent: "codex", session_id: s2, turn_id: "new" });
  check(
    "interrupt releases matching approval",
    State.pendingApproval == null && declined.includes("req-interrupt") && !State.isPinned && State.view !== "approval",
  );
  check("interruption idles without finishing", t2.state === "idle" && t2.steps.at(-1) === "interrupted");

  // Session end releases its own approval and removes only its pill.
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s2, request_id: "req-end", tool_name: "Bash", tool_input: { command: "checks" } });
  emit({ hook_event_name: "SessionEnd", coucou_agent: "codex", session_id: s2 });
  check("session end releases matching approval", State.pendingApproval == null && declined.includes("req-end") && !State.isPinned);
  check("session end removes its own pill", !State.tasks.some((t) => t.id === id2) && State.tasks.some((t) => t.id === id1));

  // A new turn expires its own stale card; a foreign card is preserved.
  State.pendingApproval = { requestId: "req-foreign", sessionId: "other", tool: "Bash", command: "Bash", taskId: "integration_claude" };
  State.isPinned = true;
  emit({ hook_event_name: "UserPromptSubmit", coucou_agent: "codex", session_id: s1, turn_id: "later", prompt: "again" });
  check("foreign approval survives our new turn", State.pendingApproval?.requestId === "req-foreign");
  State.pendingApproval = null;
  State.isPinned = false;
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s1, turn_id: "later", request_id: "req-stale", tool_name: "Bash", tool_input: { command: "x" } });
  emit({ hook_event_name: "UserPromptSubmit", coucou_agent: "codex", session_id: s1, turn_id: "newer", prompt: "moved on" });
  check("new turn expires its own stale card", State.pendingApproval == null && declined.includes("req-stale"));

  // Expired timeout cannot clear a newer card.
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s1, request_id: "req-old", tool_name: "Bash", tool_input: { command: "x" } });
  State.pendingApproval = { requestId: "req-new", sessionId: s1, tool: "Bash", command: "Bash", taskId: id1 };
  advance(110000);
  check("expired timeout keeps the newer card", State.pendingApproval?.requestId === "req-new");
  State.pendingApproval = null;
  State.isPinned = false;

  // Paused defers promptly.
  State.paused = true;
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s1, request_id: "req-3" });
  check("paused Choom defers to the terminal", declined.includes("req-3"));
  State.paused = false;
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
