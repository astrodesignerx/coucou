// Codex lifecycle plus rail centering regressions: per-session identity,
// supported events only, permission reuse, interruption versus finish, and the
// four-row centred rail. Uses fixture payloads, never user files.
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
  setView(v) { islandCalls.push(["setView", v]); },
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
  // Clean world: real State with two fixture Codex sessions plus Claude.
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

  check("codex task ids are stable per session", hooks.codexTaskId("ABC-123_xyz") === hooks.codexTaskId("ABC-123_xyz"));
  check("codex sessions fall back to a shared pill", hooks.codexTaskId(undefined) === "agent_codex");
  check("different sessions never share a pill", hooks.codexTaskId("ses-a") !== hooks.codexTaskId("ses-b"));

  const s1 = "ses-codex-1";
  const s2 = "ses-codex-2";
  emit({ hook_event_name: "SessionStart", coucou_agent: "codex", session_id: s1, cwd: "C:\\repo\\alpha" });
  emit({ hook_event_name: "SessionStart", coucou_agent: "codex", session_id: s2, cwd: "C:\\repo\\beta" });
  const id1 = hooks.codexTaskId(s1);
  const id2 = hooks.codexTaskId(s2);
  check("concurrent sessions create two pills", State.tasks.some((t) => t.id === id1) && State.tasks.some((t) => t.id === id2));
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

  // Unsupported Codex-adjacent events never become state.
  const stepsBefore = t1.steps.length;
  const momentsBefore = moments.length;
  Focus.moment = (m) => { moments.push(m); };
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
  State.pendingApproval = null;
  State.isPinned = false;

  // Finish versus interruption.
  emit({ hook_event_name: "Stop", coucou_agent: "codex", session_id: s1, last_assistant_message: "done here" });
  check("stop finishes with the last text", t1.state === "finished" && t1.steps.at(-1) === "done here");
  check("stop never reports error", t1.state !== "error");
  advance(5200);
  check("finish settles back to idle", t1.state === "idle" && t1.pillBadge == null);
  emit({ hook_event_name: "Interrupt", coucou_agent: "codex", session_id: s2 });
  check("interruption idles without finishing", t2.state === "idle" && t2.steps.at(-1) === "interrupted");

  // Session end removes only its own pill.
  emit({ hook_event_name: "SessionEnd", coucou_agent: "codex", session_id: s1 });
  check("session end removes its own pill", !State.tasks.some((t) => t.id === id1) && State.tasks.some((t) => t.id === id2));

  // Paused defers promptly.
  State.paused = true;
  emit({ hook_event_name: "PermissionRequest", coucou_agent: "codex", session_id: s2, request_id: "req-3" });
  check("paused Choom defers to the terminal", declined.includes("req-3"));
  State.paused = false;

  // Rail: four rows max, centred group, no scrollbars or clipping.
  const css = fs.readFileSync(path.join(windowsDir, "src", "choom", "choom.css"), "utf8");
  check("rail group centres vertically", css.includes("align-content: center"));
  check("rail centres in its column", css.includes(".rail {") && css.includes("justify-content: center"));
  check("rest rows centre without clipping", css.includes(".rail-col:not(:hover):not(:focus-within) .ri") && css.includes("overflow-y: hidden"));
  const railSrc = fs.readFileSync(path.join(windowsDir, "src", "choom", "rail.ts"), "utf8");
  check("rail still shows at most four rows", railSrc.includes("slice(0, 4)"));
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
