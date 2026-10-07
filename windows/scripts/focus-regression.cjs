// Focus behavioral regressions: working-code priority, collapse handoff,
// permission and pin presentation, queue bounds and recovery, pause reset,
// hidden wall-time listening, replay versus seek, and outfit transitions.
// No dependencies: real compiled modules, stubbed timers and clocks.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "focus-regression-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/choom/focus.ts",
    "src/choom/musicMood.ts",
    "src/mochi/engine.ts",
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
const { FocusEngine, Focus, startFocus } = require(path.join(out, "choom/focus.js"));
const { MusicMood } = require(path.join(out, "choom/musicMood.js"));
const { BotEngine } = require(path.join(out, "mochi/engine.js"));

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

// Deterministic timers and wall clock for every suite below.
const realNow = Date.now;
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const realSetImmediate = setImmediate;
let clock = 100000;
const scheduled = new Map();
let timerID = 0;
global.setTimeout = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms }); return id; };
global.clearTimeout = (id) => { scheduled.delete(id); };
global.setInterval = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms, interval: ms }); return id; };
global.clearInterval = (id) => { scheduled.delete(id); };
Date.now = () => clock;
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
    if (next.interval) next.at += next.interval;
    else scheduled.delete(id);
    next.fn();
  }
  clock = target;
}
const flush = () => new Promise((r) => realSetImmediate(r));

function codeTask(id, state) {
  return {
    id, name: id, color: "#fff", state, steps: [`last step of ${id}`],
    stepIndex: 0, source: "agent", isIntegration: false,
  };
}

async function main() {
  // Suite 1: ranking through the real state world.
  State.pendingApproval = null;
  State.focusId = "integration_music";
  State.mode = "compact";
  State.tasks = [
    { id: "integration_music", name: "Music", color: "#1ED760", state: "working", steps: [], stepIndex: 0, source: "agent", isIntegration: false },
    { id: "integration_claude", name: "Code", color: "#fff", state: "working", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true },
  ];
  startFocus();
  check("working code outranks playing music regardless of task order", Focus.owner.taskId === "integration_claude");

  State.tasks = [
    { id: "integration_n8n", name: "n8n", color: "#F29B38", state: "working", steps: [], stepIndex: 0, source: "n8n", isIntegration: true },
    { id: "integration_claude", name: "Code", color: "#fff", state: "working", steps: [], stepIndex: 0, source: "claudeCode", isIntegration: true },
    { id: "integration_music", name: "Music", color: "#1ED760", state: "working", steps: [], stepIndex: 0, source: "agent", isIntegration: false },
  ];
  Focus.recompute();
  check("service integrations never rank at agent priority", Focus.owner.taskId === "integration_claude");
  State.tasks = [
    { id: "integration_n8n", name: "n8n", color: "#F29B38", state: "working", steps: [], stepIndex: 0, source: "n8n", isIntegration: true },
    { id: "integration_music", name: "Music", color: "#1ED760", state: "idle", steps: [], stepIndex: 0, source: "agent", isIntegration: false },
  ];
  Focus.recompute();
  check("a lone working service falls through to music", Focus.owner.taskId === "integration_music");

  // Suite 2: permission and pin presentation on an isolated engine.
  const world = {
    taskIds: ["integration_claude", "agent_a", "integration_music"],
    approvalTaskId: null,
    workingIds: ["agent_a"],
    musicId: "integration_music",
    idleId: "integration_claude",
  };
  const shown = new FocusEngine({
    readWorld: () => world, applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  world.approvalTaskId = "agent_a";
  shown.moment({ taskId: "integration_music", kind: "track", line1: "song", line2: "", ms: 4000 });
  await flush();
  check("approval suppresses an unrelated moment", shown.owner.moment === null);
  shown.moment({ taskId: "agent_a", kind: "finished", line1: "done", line2: "", ms: 4000 });
  await flush();
  check("a moment for the approving task still presents", shown.owner.moment?.line1 === "done");
  world.approvalTaskId = null;
  shown.pin("integration_music");
  shown.moment({ taskId: "agent_a", kind: "finished", line1: "stale", line2: "", ms: 4000 });
  await flush();
  check("pin suppresses an unrelated moment", shown.owner.moment === null);
  shown.moment({ taskId: "integration_music", kind: "track", line1: "song", line2: "", ms: 4000 });
  await flush();
  check("a moment for the pinned task still presents", shown.owner.moment?.line1 === "song");
  shown.dispose();

  // Suite 3: collapse handoff and queue recovery.
  let expanded = true;
  const applied = [];
  const hand = new FocusEngine({
    readWorld: () => world, applyFocus: (id) => applied.push(id),
    isExpanded: () => expanded, now: () => clock,
  });
  world.approvalTaskId = null;
  hand.recompute();
  expanded = false;
  hand.recompute();
  check("collapse reapplies the ranked owner", applied.at(-1) === "agent_a");
  hand.dispose();

  const queueWorld = { ...world, taskIds: [...world.taskIds], workingIds: [] };
  const queued = new FocusEngine({
    readWorld: () => queueWorld, applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  queued.moment({ taskId: "agent_a", kind: "finished", line1: "first", line2: "", ms: 4000 });
  queued.moment({ taskId: "integration_music", kind: "track", line1: "second", line2: "", ms: 4000 });
  queueWorld.taskIds = queueWorld.taskIds.filter((id) => id !== "agent_a");
  queued.recompute();
  check("removing the active task advances the queued announcement", queued.owner.moment?.line1 === "second");
  queued.dispose();

  // Suite 4: bounded queue, oldest queued drops first.
  const boundWorld = { ...world, workingIds: [] };
  const bound = new FocusEngine({
    readWorld: () => boundWorld, applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  const seen = [];
  const mk = (n) => ({ taskId: `agent_${n}`, kind: "finished", line1: `m${n}`, line2: "", ms: 1000 });
  boundWorld.taskIds = ["integration_claude", "agent_1", "agent_2", "agent_3", "agent_4", "agent_5", "integration_music"];
  for (let n = 1; n <= 5; n++) bound.moment(mk(n));
  seen.push(bound.owner.moment?.line1);
  advance(1000); seen.push(bound.owner.moment?.line1);
  advance(1000); seen.push(bound.owner.moment?.line1);
  advance(1000); seen.push(bound.owner.moment?.line1);
  advance(1000); seen.push(bound.owner.moment?.line1);
  check(
    "the queue holds three and drops the oldest queued first",
    JSON.stringify(seen) === JSON.stringify(["m1", "m3", "m4", "m5", undefined]),
  );
  bound.dispose();

  // Suite 5: a rejecting gate fails open instead of wedging the queue.
  let gateMode = "reject";
  const gated = new FocusEngine({
    readWorld: () => world, applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  gated.wakeGate = () => (gateMode === "reject"
    ? Promise.reject(new Error("denied"))
    : Promise.resolve(gateMode === "deny" ? false : null));
  gated.moment({ taskId: "agent_a", kind: "finished", line1: "r1", line2: "", ms: 1000 });
  await flush();
  check("a rejecting gate fails open", gated.owner.moment?.line1 === "r1");
  gateMode = "deny";
  gated.moment({ taskId: "integration_music", kind: "track", line1: "r2", line2: "", ms: 1000 });
  advance(1000);
  await flush();
  check("a denied moment is skipped and the queue drains", gated.owner.moment === null);
  gateMode = "allow";
  gated.moment({ taskId: "integration_music", kind: "track", line1: "r3", line2: "", ms: 1000 });
  await flush();
  check("the gate recovers after a denial", gated.owner.moment?.line1 === "r3");
  gated.dispose();

  // Suite 6: moods, with the wall clock under test control.
  State.settings.musicMoods = true;
  function moodCase() {
    let active = true;
    let offscreen = false;
    let callback = () => {};
    const bot = { outfit: "none", singing: false, emit() {}, anim() {} };
    State.integrations.integration_music = {
      data: { active: true, playing: true, title: "Track", artist: "Artist", app: "Player", positionMs: 0, durationMs: 240000 },
      loaded: true, configured: true, error: null,
    };
    const driver = new MusicMood();
    driver.bind({ engine: () => bot, isMusicFocused: () => true, isPlaying: () => active, suspended: () => offscreen });
    driver.start((fn) => { callback = fn; return () => {}; });
    return {
      driver, bot,
      sync: () => callback(),
      pause: () => { active = false; State.integrations.integration_music.data.playing = false; callback(); },
      resume: () => { active = true; State.integrations.integration_music.data.playing = true; callback(); },
      show: () => { offscreen = false; callback(); },
      hide: () => { offscreen = true; callback(); },
    };
  }
  let c = moodCase();
  advance(600001);
  c.sync();
  check("ten minutes playing earns shades", c.bot.outfit === "shades");
  c.pause();
  advance(1000);
  c.resume();
  check("pause resets continuous listening", c.bot.outfit === "headphones");
  advance(60000);
  c.sync();
  check("one minute back is not enough for shades again", c.bot.outfit === "headphones");
  c.driver.dispose();

  c = moodCase();
  c.hide();
  advance(600001);
  c.show();
  check("hidden uninterrupted music keeps its wall time", c.bot.outfit === "shades");
  c.driver.dispose();

  c = moodCase();
  State.integrations.integration_music.data.positionMs = 239500;
  c.sync();
  advance(1000);
  State.integrations.integration_music.data.positionMs = 0;
  c.sync();
  check("same-track restart near its end earns shades", c.bot.outfit === "shades");
  c.driver.dispose();

  c = moodCase();
  State.integrations.integration_music.data.positionMs = 120000;
  c.sync();
  advance(1000);
  State.integrations.integration_music.data.positionMs = 60000;
  c.sync();
  check("a mid-track backward seek earns no shades", c.bot.outfit === "headphones");
  State.integrations.integration_music.data.positionMs = 0;
  c.sync();
  check("seeking to zero without hearing the end earns no shades", c.bot.outfit === "headphones");
  c.driver.dispose();

  c = moodCase();
  advance(600001);
  c.sync();
  check("shades earned before the track change", c.bot.outfit === "shades");
  State.integrations.integration_music.data = {
    active: true, playing: true, title: "Next", artist: "Artist", app: "Player", positionMs: 0, durationMs: 240000,
  };
  c.sync();
  check("a new track restarts the shades clock", c.bot.outfit === "headphones");
  State.integrations.integration_music.data = {
    active: true, playing: true, title: "Track", artist: "Artist", app: "Player", positionMs: 0, durationMs: 240000,
  };
  advance(1000);
  c.sync();
  check("returning to the previous track within seconds is a replay", c.bot.outfit === "shades");
  c.driver.dispose();

  // Suite 7: outfit transitions on the real engine.
  const engine = new BotEngine();
  const frames = (n) => { for (let i = 0; i < n; i++) engine.update(0.016); };
  engine.outfit = "headphones";
  frames(120);
  check("headphones settle in", engine.drawnOutfit === "headphones" && engine.outfitT === 1);
  engine.outfit = "shades";
  frames(4);
  const fading = engine.drawnOutfit === "headphones" && engine.outfitT < 1 && engine.outfitT > 0;
  frames(120);
  check("headphones fade out before shades fade in", fading && engine.drawnOutfit === "shades" && engine.outfitT === 1);
  engine.outfit = "none";
  frames(2);
  const fadingOut = engine.drawnOutfit === "shades" && engine.outfitT < 1 && engine.outfitT > 0;
  frames(120);
  check("removal fades out instead of snapping", fadingOut && engine.drawnOutfit === "none" && engine.outfitT === 0);

  global.window = { matchMedia: () => ({ matches: true, addEventListener() {} }) };
  engine.outfit = "shades";
  engine.update(0.016);
  check("reduced motion snaps the outfit", engine.drawnOutfit === "shades" && engine.outfitT === 1);
  delete global.window;

  Focus.dispose();
  Date.now = realNow;
  Object.assign(global, {
    setTimeout: realSetTimeout,
    clearTimeout: realClearTimeout,
    setInterval: realSetInterval,
    clearInterval: realClearInterval,
  });
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
