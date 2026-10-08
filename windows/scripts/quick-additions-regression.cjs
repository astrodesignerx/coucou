// Quick additions behavioral regressions: job radar ranking and cap,
// vitals sustain/cooldown/hysteresis/latch, disabled and hidden sampling,
// stale async drops, CPU warmup, battery crossings/suppression/rearm, absent
// and unknown batteries, and tracker cleanup. No dependencies beyond the
// compiled modules, stubbed timers and injected fakes.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "quick-additions-built");
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

// Deterministic timers and clock. Monitors use the injected now(), the
// interval stubs below only decide when ticks run.
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const realSetImmediate = setImmediate;
let clock = 1_000_000;
const scheduled = new Map();
let timerID = 0;
global.setTimeout = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms }); return id; };
global.clearTimeout = (id) => { scheduled.delete(id); };
global.setInterval = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms, interval: ms }); return id; };
global.clearInterval = (id) => { scheduled.delete(id); };
function runDue() {
  for (const [id, t] of [...scheduled]) {
    if (t.at <= clock) {
      if (t.interval) t.at += t.interval;
      else scheduled.delete(id);
      t.fn();
    }
  }
}
const flush = () => new Promise((r) => realSetImmediate(r));

function agentTask(id, name, state, steps, badge) {
  return {
    id, name, color: "#fff", state, steps: steps ?? [], stepIndex: 0,
    source: "agent", isIntegration: false, pillBadge: badge ?? null,
  };
}

function vitalsReading(cpuPercent, memPercent) {
  return { cpuPercent, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000, memPercent, unavailable: null };
}

function batteryReading(percent, opts) {
  return {
    hasBattery: true, percent, charging: null, acOnline: false,
    timeSecs: 3600, state: "discharging", error: null, ...(opts ?? {}),
  };
}

async function main() {
  // Suite 1: job radar rows from hook-driven state.
  State.tasks = [
    { id: "integration_claude", name: "Code", color: "#fff", state: "idle", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true },
    agentTask("agent_opencode", "OpenCode", "working", ["answering"]),
    agentTask("agent_codex_abc", "Codex", "thinking", ["reading"]),
    agentTask("agent_side", "Side", "finished", ["done"]),
    agentTask("agent_old", "Old", "idle", []),
    agentTask("agent_extra", "Extra", "idle", []),
    { id: "integration_n8n", name: "n8n", color: "#F29B38", state: "working", steps: ["flow"], stepIndex: 0, source: "n8n", isIntegration: true },
    { id: "integration_music", name: "Music", color: "#1ED760", state: "working", steps: [], stepIndex: 0, source: "agent", isIntegration: false },
    { id: "utility_system", name: "System", color: "#8E939C", state: "idle", steps: [], stepIndex: 0, source: "agent", isIntegration: false },
  ];
  let rows = QA.jobRadarRows(State.tasks);
  check("radar lists at most four jobs", rows.length === 4);
  check(
    "live work outranks finishes and idle sessions",
    rows[0].id === "agent_opencode" && rows[1].id === "agent_codex_abc" &&
    rows[2].id === "agent_side" && rows[3].id === "integration_claude",
  );
  check(
    "services, music and the System entry never appear",
    rows.every((r) => !["integration_n8n", "integration_music", "utility_system"].includes(r.id)),
  );
  const kinds = Object.fromEntries(rows.map((r) => [r.id, r.kind]));
  check(
    "kinds name the supported session sources",
    kinds.agent_opencode === "opencode" && kinds.agent_codex_abc === "codex" &&
    kinds.integration_claude === "claude" && kinds.agent_side === "agent",
  );
  check("rows carry the existing session detail, not fabricated progress", rows[0].detail === "answering");

  State.tasks = [
    agentTask("agent_a", "A", "working", ["w"], "approval"),
    agentTask("agent_b", "B", "working", ["w2"]),
    agentTask("agent_c", "C", "idle", [], "error"),
  ];
  rows = QA.jobRadarRows(State.tasks);
  check("an approval outranks plain work", rows[0].id === "agent_a" && rows[0].status === "approval");
  check("an error badge survives as an error row", rows.some((r) => r.id === "agent_c" && r.status === "error"));

  // A row opens the existing session card: focus moves, nothing is spawned.
  State.focusId = "integration_claude";
  State.tasks = [
    { id: "integration_claude", name: "Code", color: "#fff", state: "idle", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true },
    agentTask("agent_b", "B", "working", ["w2"]),
  ];
  State.setFocus("agent_b");
  check("opening a radar row focuses that existing session", State.focusId === "agent_b");

  // Suite 2: vitals sustain, hysteresis, latch and cooldown.
  let s = QA.initialVitalsWarnState();
  let r = QA.nextVitalsWarn(s, 95, 20, clock);
  check("a fresh breach starts timing without warning", r.warn === null && r.state.cpuMs === 0);
  s = r.state;
  r = QA.nextVitalsWarn(s, 95, 20, clock + 29_999);
  check("29 seconds is not sustained", r.warn === null && r.state.cpuMs === 29_999);
  s = r.state;
  r = QA.nextVitalsWarn(s, 95, 20, clock + 30_000);
  check("30 seconds of heat warns once", r.warn === "cpu");
  s = r.state;
  r = QA.nextVitalsWarn(s, 95, 20, clock + 400_000);
  check("a latched breach never repeats while it stays high", r.warn === null);

  // Recovery hysteresis: the 85 to 90 band neither starts nor clears.
  s = QA.initialVitalsWarnState();
  r = QA.nextVitalsWarn(s, 95, 20, clock);
  s = r.state;
  r = QA.nextVitalsWarn(s, 87, 20, clock + 10_000);
  check("87 keeps a running breach alive", r.state.cpuMs === 10_000 && r.warn === null);
  s = r.state;
  r = QA.nextVitalsWarn(s, 95, 20, clock + 30_000);
  check("the breach warns on its original timer", r.warn === "cpu");
  s = QA.initialVitalsWarnState();
  r = QA.nextVitalsWarn(s, 87, 20, clock);
  check("87 alone never starts a breach", r.state.cpuMs === 0 && r.warn === null);
  r = QA.nextVitalsWarn(QA.initialVitalsWarnState(), 50, 92, clock);
  check("memory breaches accumulate on their own", r.warn === null && r.state.memMs === 0);

  // Recovery then cooldown: a new breach waits out the quiet time.
  s = QA.nextVitalsWarn(QA.initialVitalsWarnState(), 95, 20, clock).state;
  s = QA.nextVitalsWarn(s, 95, 20, clock + 30_000).state;
  s = QA.nextVitalsWarn(s, 80, 20, clock + 40_000).state;
  check("falling below 85 unlatches", s.cpuLatched === false && s.cpuMs === 0);
  r = QA.nextVitalsWarn(s, 95, 20, clock + 70_000);
  check("recovery alone does not cut the cooldown short", r.warn === null && r.state.cpuMs === 30_000);
  r = QA.nextVitalsWarn(r.state, 95, 20, clock + 400_000);
  check("the next breach warns after the cooldown", r.warn === "cpu");

  // Unknown readings freeze: they add no time and change nothing.
  s = QA.nextVitalsWarn(QA.initialVitalsWarnState(), 95, 20, clock).state;
  r = QA.nextVitalsWarn(s, null, null, clock + 120_000);
  check("unknown readings freeze the timers", r.warn === null && r.state.cpuMs === 0);
  r = QA.nextVitalsWarn(r.state, 95, 20, clock + 125_000);
  check("heat after a gap accumulates from the freeze point", r.warn === null && r.state.cpuMs === 5_000);

  // Simultaneous breaches coalesce into one warning.
  s = QA.nextVitalsWarn(QA.initialVitalsWarnState(), 95, 95, clock).state;
  r = QA.nextVitalsWarn(s, 95, 95, clock + 30_000);
  check("CPU and memory warn together, once", r.warn === "both");

  // Suite 3: the sampler only samples while active, drops stale reads.
  const savedIntegrations = State.integrations;
  State.integrations = {};
  let active = true;
  let warnable = true;
  let snapshots = 0;
  let stored = null;
  const warned = [];
  const monitor = new QA.VitalsMonitor({
    now: () => clock,
    snapshot: async () => {
      snapshots++;
      return stored;
    },
    isActive: () => active,
    canWarn: () => warnable,
    warn: (kind) => warned.push(kind),
  });
  stored = vitalsReading(10, 20);
  monitor.start(5000);
  await flush();
  check("visible sampling stores the reading", State.integrations.utility_system?.data.vitals?.cpuPercent === 10);
  check("normal load never warns", warned.length === 0);
  const before = snapshots;
  active = false;
  clock += 60_000;
  runDue();
  await flush();
  check("hidden sampling stops entirely", snapshots === before);
  active = true;
  warnable = false;
  stored = vitalsReading(95, 95);
  for (let t = 0; t < 7; t++) {
    clock += 5000;
    runDue();
    await flush();
  }
  check("a silenced breach still stores readings", State.integrations.utility_system?.data.vitals?.cpuPercent === 95);
  check("a silenced breach never surfaces", warned.length === 0);

  // Stale async responses are dropped after stop.
  let release = null;
  let staleStored = 0;
  const staleMonitor = new QA.VitalsMonitor({
    now: () => clock,
    snapshot: () => new Promise((resolve) => { release = () => resolve(vitalsReading(95, 95)); }),
    isActive: () => true,
    canWarn: () => true,
    warn: () => { staleStored++; },
  });
  staleMonitor.start(5000);
  staleMonitor.stop();
  release();
  await flush();
  check("a response after stop is dropped", staleStored === 0 && staleMonitor.running === false);

  // CPU warmup: the first read stores nothing-to-show, never zero.
  State.integrations = {};
  let warmWarns = 0;
  const warm = new QA.VitalsMonitor({
    now: () => clock,
    snapshot: async () => ({ cpuPercent: null, memUsedBytes: 1, memTotalBytes: 2, memPercent: 50, unavailable: null }),
    isActive: () => true,
    canWarn: () => true,
    warn: () => { warmWarns++; },
  });
  warm.start(5000);
  await flush();
  const warmStored = State.integrations.utility_system?.data.vitals;
  check("warmup stores an empty CPU, not zero", warmStored && warmStored.cpuPercent === null);
  check("warmup never warns", warmWarns === 0);
  warm.stop();
  monitor.stop();
  check("stopping clears every sampler timer", monitor.running === false);

  // Suite 4: battery crossings, suppression, rearm and recovery.
  let b = QA.initialBatteryWarnState();
  const discharging = (pct, extra) => batteryReading(pct, extra);
  r = QA.nextBatteryEvent(b, discharging(21));
  check("a first sighting adopts the baseline silently", r.event === null);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(19));
  check("crossing 20 warns once", r.event?.type === "low" && r.event?.level === 20);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(19));
  check("hovering below 20 never repeats", r.event === null);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(9));
  check("crossing 10 warns again", r.event?.level === 10);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(4));
  check("crossing 5 warns again", r.event?.level === 5);
  b = r.state;

  // A jump across several levels warns once, for the lowest one.
  b = QA.initialBatteryWarnState();
  b = QA.nextBatteryEvent(b, discharging(25)).state;
  r = QA.nextBatteryEvent(b, discharging(4));
  check("a 25 to 4 jump warns once for level 5", r.event?.type === "low" && r.event?.level === 5);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(3));
  check("the rest of that fall stays quiet", r.event === null);

  // Charging suppresses, recovers once, and rearms for the next discharge.
  r = QA.nextBatteryEvent(b, discharging(30, { charging: true, acOnline: true }));
  check("plugging in after a low recovers exactly once", r.event?.type === "recovery");
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(60, { charging: true, acOnline: true }));
  check("every cable event is not a recovery", r.event === null);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(60));
  check("unplugging full is not a low", r.event === null);
  b = r.state;
  r = QA.nextBatteryEvent(b, discharging(19));
  check("the next discharge warns again after rearming", r.event?.level === 20);
  b = r.state;

  // AC without an explicit charging flag suppresses too.
  b = QA.nextBatteryEvent(QA.initialBatteryWarnState(), discharging(50)).state;
  r = QA.nextBatteryEvent(b, discharging(15, { acOnline: true }));
  check("AC power suppresses the crossing", r.event === null);

  // Absent, unknown and failed batteries never warn.
  const quiet = (reading) => QA.nextBatteryEvent(QA.initialBatteryWarnState(), reading).event === null;
  check("no battery never warns", quiet({ ...discharging(10), hasBattery: false, percent: null, state: "no_battery" }));
  check("unknown percentage never warns", quiet({ ...discharging(10), percent: null, state: "unknown" }));
  check("an API failure never warns", quiet({ ...discharging(10), error: "Battery status failed", state: "error" }));
  check("an unavailable platform never warns", quiet({ hasBattery: false, percent: null, charging: null, acOnline: null, timeSecs: null, state: "unavailable", error: null }));

  // A low boot adopts silently, then warns on the next real crossing.
  b = QA.nextBatteryEvent(QA.initialBatteryWarnState(), discharging(15)).state;
  r = QA.nextBatteryEvent(b, discharging(9));
  check("a low boot still warns on the next crossing", r.event?.level === 10);

  // Suite 5: tracker refresh gating, native handling and cleanup.
  let refreshes = 0;
  let lows = [];
  let recoveries = 0;
  let trackerActive = true;
  let trackerWarnable = true;
  let trackerReading = discharging(80);
  let nativeSubscribed = false;
  let nativeUnsubscribed = false;
  const tracker = new QA.BatteryTracker(
    {
      refresh: async () => { refreshes++; return trackerReading; },
      isActive: () => trackerActive,
      canWarn: () => trackerWarnable,
      low: (level) => lows.push(level),
      recovered: () => { recoveries++; },
    },
    (handler) => {
      nativeSubscribed = true;
      tracker.__handler = handler;
      return () => { nativeUnsubscribed = true; };
    },
  );
  tracker.start();
  await flush();
  check("startup refreshes once", refreshes === 1);
  check("startup subscribes to native power events", nativeSubscribed);
  trackerActive = false;
  tracker.refreshNow();
  await flush();
  check("a gated refresh never runs", refreshes === 1);
  trackerActive = true;
  trackerWarnable = false;
  tracker.__handler(discharging(50));
  tracker.__handler(discharging(19));
  check("a silenced native low still stores the battery", State.integrations.utility_system?.data.battery?.percent === 19);
  check("a silenced native low never surfaces", lows.length === 0);
  trackerWarnable = true;
  tracker.__handler(discharging(9));
  tracker.__handler(discharging(4));
  check("native lows warn through the tracker", JSON.stringify(lows) === JSON.stringify([10, 5]));
  tracker.__handler(discharging(40, { charging: true, acOnline: true }));
  check("native charging recovers through the tracker", recoveries === 1);

  // Stale refreshes are dropped after stop.
  let trackerRelease = null;
  let staleLows = 0;
  const staleTracker = new QA.BatteryTracker(
    {
      refresh: () => new Promise((resolve) => { trackerRelease = () => resolve(discharging(4)); }),
      isActive: () => true,
      canWarn: () => true,
      low: () => { staleLows++; },
      recovered: () => {},
    },
    () => () => {},
  );
  staleTracker.start();
  staleTracker.stop();
  trackerRelease();
  await flush();
  check("a battery response after stop is dropped", staleLows === 0);
  tracker.dispose();
  check("disposing unsubscribes the native listener", nativeUnsubscribed && tracker.listening === false);

  // Suite 6: registration keeps the pill quiet and cleans up.
  const savedTasks = State.tasks;
  const savedSettings = { ...State.settings };
  const savedMode = State.mode;
  const savedPaused = State.paused;
  State.tasks = [
    { id: "integration_claude", name: "Code", color: "#fff", state: "idle", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true },
  ];
  State.focusId = "integration_claude";
  State.mode = "expanded";
  State.paused = false;
  State.settings = { ...State.settings, jobRadar: true, pcVitals: false, vitalsWarnings: true, batteryMonitor: true, batteryWarnings: true };
  let unsubNative = false;
  const handles = QA.registerQuickAdditions({
    snapshotVitals: async () => null,
    snapshotBattery: async () => batteryReading(80),
    subscribeBattery: () => () => { unsubNative = true; },
  });
  await flush();
  check("registration creates the quiet pill", State.tasks.some((t) => t.id === "utility_system"));
  check("registration never steals focus", State.focusId === "integration_claude");
  State.settings = { ...State.settings, jobRadar: false, pcVitals: false, batteryMonitor: false };
  State.notify();
  await flush();
  check("disabling every utility removes the pill", !State.tasks.some((t) => t.id === "utility_system"));
  check("removal moves focus home", State.focusId === "integration_claude");
  handles.dispose();
  check("disposing removes the native subscription", unsubNative);
  State.tasks = savedTasks;
  State.settings = savedSettings;
  State.mode = savedMode;
  State.paused = savedPaused;
  State.integrations = savedIntegrations;
  check("no sampler timer survives disposal", scheduled.size === 0);

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
