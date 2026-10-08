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

  // Dwell: a candidate must survive a full 8 seconds before it takes over.
  // The candidate clock starts on first sight and resets on any change, on
  // missing data and on disabled monitoring. Missing or disabled data falls
  // back to balanced at once, never retaining burnout or zen falsely.
  const vitals = (cpu, mem) => ({
    cpuPercent: cpu, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000,
    memPercent: mem, unavailable: null,
  });
  const storeVitals = (cpu, mem) => {
    State.integrations = { utility_system: { data: { vitals: vitals(cpu, mem) }, error: null, loaded: true, configured: true } };
  };
  State.settings = { ...State.settings, pcVitals: true };
  QA.resetSystemMood(0);
  storeVitals(10, 20);
  check("a fresh calm candidate starts its clock", QA.currentSystemMood(1000) === "balanced");
  check("calm readings rest efficient after the dwell", QA.currentSystemMood(9000) === "efficient");
  storeVitals(95, 95);
  check("a fresh spike waits out the dwell", QA.currentSystemMood(9500) === "efficient");
  check("a held spike switches after the dwell", QA.currentSystemMood(17500) === "high");
  storeVitals(10, 20);
  check("recovery also waits out the dwell", QA.currentSystemMood(18000) === "high");
  check("recovery lands after the dwell", QA.currentSystemMood(26000) === "efficient");
  // Flapping restarts the candidate clock instead of inheriting it.
  storeVitals(95, 95);
  check("a new spike restarts its own clock", QA.currentSystemMood(26500) === "efficient");
  storeVitals(10, 20);
  check("a change of mind resets the spike clock", QA.currentSystemMood(30000) === "efficient");
  storeVitals(95, 95);
  check("the renewed spike waits a full dwell", QA.currentSystemMood(34000) === "efficient");
  check("the renewed spike lands after its dwell", QA.currentSystemMood(42000) === "high");
  // Missing data resets the clock and releases the mood at once.
  storeVitals(null, null);
  check("unknown readings fall back to balanced", QA.currentSystemMood(42500) === "balanced");
  storeVitals(95, 95);
  check("a spike after a gap starts a fresh clock", QA.currentSystemMood(43000) === "balanced");
  check("the fresh spike still needs its dwell", QA.currentSystemMood(47000) === "balanced");
  check("the fresh spike lands after its dwell", QA.currentSystemMood(51000) === "high");
  State.integrations = {};
  check("missing readings fall back to balanced", QA.currentSystemMood(52000) === "balanced");
  // Disabled monitoring cannot hold a mood either.
  storeVitals(10, 20);
  QA.resetSystemMood(0);
  State.settings = { ...State.settings, pcVitals: true };
  check("disabled setup starts balanced", QA.currentSystemMood(1000) === "balanced");
  check("disabled setup rests efficient", QA.currentSystemMood(9000) === "efficient");
  storeVitals(95, 95);
  State.settings = { ...State.settings, pcVitals: false };
  check("disabled monitoring falls back to balanced", QA.currentSystemMood(9500) === "balanced");
  check("disabled monitoring never adopts a spike", QA.currentSystemMood(20000) === "balanced");
  State.settings = { ...State.settings, pcVitals: true };

  // Compact heights: the normal overview height fits both tabs, only a pinned
  // note grows Jobs slightly.
  check("PC takes the normal height", QA.systemIslandHeight("pc", 0, false) === 184);
  check("empty Jobs takes the normal height", QA.systemIslandHeight("jobs", 0, false) === 184);
  check("Jobs with rows stays at the normal height", QA.systemIslandHeight("jobs", 3, false) === 184);
  check("a pinned note grows Jobs slightly", QA.systemIslandHeight("jobs", 3, true) === 200);
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
  check("live Jobs height matches the helper", QA.utilityIslandHeight() === 184);
  QA.setUtilityTab("pc");
  check("live PC height matches the helper", QA.utilityIslandHeight() === 184);
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
