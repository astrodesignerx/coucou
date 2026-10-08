// System design regressions for Choom 0.1.4: job priority order with error
// ahead of work, one lead plus three pills, explicit pinning, state colors,
// vitals mood thresholds with dwell, honest unknown data and compact heights.
// Pure helpers only, no DOM. Follows the quick-additions script pattern.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "system-design-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/choom/quickAdditions.ts",
    "src/core/state.ts",
    "src/choom/focus.ts",
    "src/core/layout.ts",
    "--outDir", out,
    "--module", "commonjs",
    "--target", "es2022",
    "--lib", "es2022,dom",
    "--skipLibCheck",
    "--noUnusedLocals", "false",
    "--noUnusedParameters", "false",
  ],
  { cwd: windowsDir, stdio: "inherit" },
);

const QA = require(path.join(out, "choom/quickAdditions.js"));
const { State } = require(path.join(out, "core/state.js"));

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

function agentTask(id, name, state, steps, badge) {
  return {
    id, name, color: "#fff", state, steps: steps ?? [], stepIndex: 0,
    source: "agent", isIntegration: false, pillBadge: badge ?? null,
  };
}

function main() {
  const savedTasks = State.tasks;
  const savedSettings = { ...State.settings };
  const savedIntegrations = State.integrations;

  // Priority: approval and error before active work before finished and idle.
  State.tasks = [
    agentTask("agent_idle", "Idle", "idle", []),
    agentTask("agent_fin", "Fin", "finished", ["done"]),
    agentTask("agent_work", "Work", "working", ["doing"]),
    agentTask("agent_err", "Err", "idle", [], "error"),
    agentTask("agent_appr", "Appr", "working", ["w"], "approval"),
    agentTask("agent_think", "Think", "thinking", ["t"]),
    agentTask("agent_search", "Search", "searching", ["s"]),
  ];
  let rows = QA.jobRadarRows(State.tasks);
  check("radar caps at four rows", rows.length === 4);
  check(
    "approval and error outrank active work",
    rows[0].id === "agent_appr" && rows[1].id === "agent_err",
  );
  check(
    "active work keeps radar order ahead of finished and idle",
    rows[2].id === "agent_work" && rows[3].id === "agent_think",
  );
  State.tasks = [
    agentTask("agent_fin", "Fin", "finished", ["done"]),
    agentTask("agent_idle", "Idle", "idle", []),
  ];
  rows = QA.jobRadarRows(State.tasks);
  check("finished outranks idle", rows[0].id === "agent_fin" && rows[1].id === "agent_idle");

  // Lead selection: one lead, three pills maximum, explicit pinning.
  QA.setPinnedJobId(null);
  State.tasks = [
    agentTask("agent_a", "A", "working", ["a"]),
    agentTask("agent_b", "B", "working", ["b"]),
    agentTask("agent_c", "C", "finished", ["c"]),
    agentTask("agent_d", "D", "idle", []),
    agentTask("agent_e", "E", "idle", []),
  ];
  rows = QA.jobRadarRows(State.tasks);
  let sel = QA.resolveLeadJob(rows);
  check("auto lead is the top priority row", sel.lead.id === "agent_a" && sel.pinned === false);
  check("at most three pills follow the lead", sel.rest.length === 3);
  check("pills exclude the lead", sel.rest.every((r) => r.id !== sel.lead.id));
  QA.setPinnedJobId("agent_c");
  sel = QA.resolveLeadJob(rows);
  check("a user pin wins over priority", sel.lead.id === "agent_c" && sel.pinned === true);
  check("pinned rest still caps at three", sel.rest.length === 3);
  QA.setPinnedJobId("agent_gone");
  sel = QA.resolveLeadJob(rows);
  check("a stale pin releases silently back to Auto", sel.lead.id === "agent_a" && sel.pinned === false);
  check("stale release clears the stored pin", QA.getPinnedJobId() === null);
  sel = QA.resolveLeadJob([]);
  check("no rows means no lead", sel.lead === null && sel.rest.length === 0);

  // State colors: amber approval, coral error, green work, blue checking, grey rest.
  check("approval maps to amber", QA.jobSignalColor("approval") === "#E6B35E");
  check("error maps to coral", QA.jobSignalColor("error") === "#EB7B6E");
  check("working maps to green", QA.jobSignalColor("working") === "#66C99B");
  check("thinking and searching map to blue",
    QA.jobSignalColor("thinking") === "#80AFE5" && QA.jobSignalColor("searching") === "#80AFE5");
  check("finished and idle map to grey",
    QA.jobSignalColor("finished") === "#788188" && QA.jobSignalColor("idle") === "#788188");
  check("live states pulse, finished and idle stay flat",
    QA.jobIsLive("approval") && QA.jobIsLive("error") && QA.jobIsLive("working") &&
    QA.jobIsLive("thinking") && QA.jobIsLive("searching") &&
    !QA.jobIsLive("finished") && !QA.jobIsLive("idle"));

  // Mood thresholds with honest unknown handling.
  check("unknown readings stay honest", QA.moodForVitals(null, 20) === null);
  check("unknown readings stay honest", QA.moodForVitals(90, null) === null);
  check("high at exactly 80 CPU", QA.moodForVitals(80, 20) === "high");
  check("high at exactly 85 memory", QA.moodForVitals(20, 85) === "high");
  check("79 CPU with 84 memory is balanced", QA.moodForVitals(79, 84) === "balanced");
  check("efficient needs both low", QA.moodForVitals(29, 49) === "efficient");
  check("30 CPU alone is balanced", QA.moodForVitals(30, 49) === "balanced");
  check("50 memory alone is balanced", QA.moodForVitals(29, 50) === "balanced");

  // Dwell: brief spikes never flicker the mood, unknown never moves it.
  const vitals = (cpu, mem) => ({
    cpuPercent: cpu, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000,
    memPercent: mem, unavailable: null,
  });
  State.integrations = { utility_system: { data: { vitals: vitals(10, 20) }, error: null, loaded: true, configured: true } };
  QA.resetSystemMood(0);
  check("calm readings rest efficient", QA.currentSystemMood(9000) === "efficient");
  State.integrations.utility_system.data.vitals = vitals(95, 95);
  check("a fresh spike waits out the dwell", QA.currentSystemMood(9500) === "efficient");
  check("a held spike switches after the dwell", QA.currentSystemMood(17500) === "high");
  State.integrations.utility_system.data.vitals = vitals(10, 20);
  check("recovery also waits out the dwell", QA.currentSystemMood(18000) === "high");
  check("recovery lands after the dwell", QA.currentSystemMood(26000) === "efficient");
  State.integrations.utility_system.data.vitals = vitals(null, null);
  check("unknown readings never move the mood", QA.currentSystemMood(40000) === "efficient");
  State.integrations = {};
  check("missing readings never move the mood", QA.currentSystemMood(50000) === "efficient");

  // Compact heights: content decides, nothing scrolls or clips.
  check("PC takes the tall stack", QA.systemIslandHeight("pc", 0, false) === 264);
  check("empty Jobs falls back to overview height", QA.systemIslandHeight("jobs", 0, false) === 184);
  check("Jobs with rows stays short", QA.systemIslandHeight("jobs", 3, false) === 208);
  check("a pinned note grows Jobs slightly", QA.systemIslandHeight("jobs", 3, true) === 222);
  QA.setUtilityTab("jobs");
  check("tabs switch between Jobs and PC", QA.getUtilityTab() === "jobs");
  QA.setUtilityTab("pc");
  check("tabs switch between Jobs and PC", QA.getUtilityTab() === "pc");
  QA.setUtilityTab("jobs");

  // utilityIslandHeight reads live state end to end.
  State.settings = { ...State.settings, jobRadar: true };
  State.tasks = [
    agentTask("agent_a", "A", "working", ["a"]),
    agentTask("agent_b", "B", "working", ["b"]),
  ];
  QA.setPinnedJobId(null);
  QA.setUtilityTab("jobs");
  check("live Jobs height matches the helper", QA.utilityIslandHeight() === 208);
  QA.setUtilityTab("pc");
  check("live PC height matches the helper", QA.utilityIslandHeight() === 264);
  QA.setUtilityTab("jobs");
  State.settings = { ...State.settings, jobRadar: false };
  check("a silenced radar reads empty", QA.utilityIslandHeight() === 184);

  State.tasks = savedTasks;
  State.settings = savedSettings;
  State.integrations = savedIntegrations;
  QA.setPinnedJobId(null);
  QA.setUtilityTab("jobs");
  QA.resetSystemMood(0);
}

main();
process.exitCode = failed ? 1 : 0;
