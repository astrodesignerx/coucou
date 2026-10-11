// Jobs/System fixture: the real production shell composition (production
// header, production overview layout with card plus rail, production BotEngine
// mascot at production botPosition geometry), driven by synthetic labeled
// fixture data only. No Windows API access, no model calls, no live data.
// Served by `npm run dev` at /dev/jobs-system-fixture.html, never bundled.
//
// What this proves and what it does not: the cards, header, rail rows and
// mascot are the actual production components at production sizes, so
// selection, pinning, Auto, live in-place updates, rail reachability and
// readings can be exercised here. Pill peek animation, wake gating, native
// snapshots and hover timing belong to the app shell and must be checked in
// the running app; the readout below reports functional state, never visual
// proof on its own.

import "../src/style.css";
import "../src/choom/choom.css";
import { EXPANDED_W, botPosition } from "../src/core/layout";
import { State, type AgentTask } from "../src/core/state";
import { BotEngine, hexToRGB } from "../src/mochi/engine";
import { tickMiniBots } from "../src/mochi/minibots";
import { MUSIC_ID, Focus, startFocus } from "../src/choom/focus";
import {
  JOBS_ID,
  UTILITY_ID,
  currentSystemMood,
  getPinnedJobId,
  jobsLiveHeight,
  setPinnedJobId,
  syncUtilityPill,
  systemLiveHeight,
} from "../src/choom/quickAdditions";
import {
  jobsCard,
  systemCard,
  updateJobsCard,
  updateSystemCard,
} from "../src/choom/quickAdditionsSection";
import { buildRail } from "../src/choom/rail";
import { buildHeader, type ViewActions } from "../src/views/views";

const shell = document.getElementById("island-shell")!;
const hdrMount = document.getElementById("hdr")!;
const ovWrap = document.getElementById("ovwrap")!;
const mascotCanvas = document.getElementById("fixture-mascot") as HTMLCanvasElement;
const stage = document.getElementById("stage")!;
const buttons = document.getElementById("buttons")!;
const readout = document.getElementById("readout")!;
const logEl = document.getElementById("log")!;

function say(line: string) {
  logEl.textContent += line + "\n";
}

let n = 0;
function fixtureJob(state: AgentTask["state"] = "working"): AgentTask {
  n += 1;
  return {
    id: `agent_fixture_${n}`,
    name: `Fixture job ${n}`,
    color: "#7BA7D9",
    state,
    stepIndex: 0,
    steps: [`Fixture step ${n}`],
    source: "agent",
    isIntegration: false,
    pillBadge: null,
  };
}

// Production state wiring with fixture jobs only.
State.tasks = [
  { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  fixtureJob("working"),
  fixtureJob("finished"),
];
State.focusId = JOBS_ID;
State.mode = "expanded";
State.view = "overview";
State.paused = false;
State.settings.jobRadar = true;
State.settings.pcVitals = true;
State.settings.batteryMonitor = true;
State.integrations[UTILITY_ID] = {
  data: {
    vitals: { cpuPercent: 12, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 50, unavailable: null },
    battery: { hasBattery: true, percent: 82, charging: false, acOnline: false, timeSecs: 3600, state: "discharging", error: null },
  },
  error: null,
  loaded: true,
  configured: true,
};
syncUtilityPill();
State.setFocus(JOBS_ID);
startFocus();

// Real production header. Fixture actions only flip local fixture state.
const actions: ViewActions = {
  setView: (v) => { State.view = v; render(); },
  collapse: () => say("Fixture: collapse (app shell owns collapse)"),
  setFocus: (id) => State.setFocus(id),
  openTerminal: () => say("Fixture: openTerminal (no app shell)"),
  openTarget: () => say("Fixture: openTarget (no app shell)"),
  openUrl: () => say("Fixture: openUrl (no app shell)"),
  decide: () => say("Fixture: decide (no approval in fixture)"),
  toggleSound: () => say("Fixture: toggleSound (no audio in fixture)"),
  setVolume: () => say("Fixture: setVolume (no audio in fixture)"),
  setAutoClose: () => say("Fixture: setAutoClose (no timers in fixture)"),
  openSettingsWindow: () => say("Fixture: openSettingsWindow (no app shell)"),
  blip: () => {},
};
const header = buildHeader(actions);
hdrMount.append(header.el);

// Production overview composition: card on the left, rail on the right.
const ov = document.createElement("div");
ov.className = "view overview has-rail on";
const left = document.createElement("div");
left.className = "left";
const card = document.createElement("div");
card.className = "card";
const leftBody = document.createElement("div");
leftBody.className = "left-body";
const jump = document.createElement("button");
jump.className = "icon-btn jump";
jump.title = "Open";
jump.style.display = "none";
jump.textContent = "↗";
card.append(leftBody, jump);
left.append(card);
const right = document.createElement("div");
right.className = "right rail-col";
const rail = buildRail({ setFocus: (id) => State.setFocus(id) });
right.append(rail.el);
ov.append(left, right);
ovWrap.append(ov);

// Production mascot pipeline (island drawBot, single shell): BotEngine with
// production body color, production system mood gating and production
// botPosition geometry. The app shell animates it every frame; here a light
// loop redraws it while expanded and stops while hidden.
const engine = new BotEngine();
const BOT_OVERHANG = 40;
function islandHeight(): number {
  if (State.view !== "overview") return 184;
  if (State.focusId === JOBS_ID) return jobsLiveHeight();
  if (State.focusId === UTILITY_ID) return systemLiveHeight();
  return 184;
}
function drawMascot() {
  const h = islandHeight();
  const p = botPosition(State.mode === "expanded" ? "expanded" : "compact", "overview", h, 0);
  const size = p.diameter / 0.6;
  const w = Math.max(1, Math.round(size));
  const hCss = w + BOT_OVERHANG;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  mascotCanvas.width = Math.round(w * dpr);
  mascotCanvas.height = Math.round(hCss * dpr);
  mascotCanvas.style.width = `${w}px`;
  mascotCanvas.style.height = `${hCss}px`;
  mascotCanvas.style.left = `${p.cx - w / 2}px`;
  mascotCanvas.style.top = `${p.cy - BOT_OVERHANG / 2 - hCss / 2}px`;
  const ctx = mascotCanvas.getContext("2d");
  if (!ctx) return;
  const focus = State.focusTask;
  engine.bodyColor = State.focusId === MUSIC_ID
    ? hexToRGB(focus?.color ?? "#1ED760")
    : focus?.isIntegration
      ? hexToRGB(focus.color)
      : null;
  engine.systemMood =
    State.focusId === UTILITY_ID && State.mode === "expanded" && State.view === "overview"
      ? currentSystemMood()
      : null;
  engine.particleOverhang = BOT_OVERHANG;
  engine.lookX = 0;
  engine.lookY = 0;
  engine.update(0.016);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hCss);
  engine.draw(ctx, w, hCss);
}

let loopOn = false;
function loop() {
  if (!loopOn) return;
  if (State.mode === "hidden") {
    requestAnimationFrame(loop);
    return;
  }
  drawMascot();
  tickMiniBots(0.016);
  requestAnimationFrame(loop);
}
function ensureLoop() {
  if (loopOn) return;
  loopOn = true;
  requestAnimationFrame(loop);
}

let stageW = EXPANDED_W;
let cardKey = "";
let focusCheck: string = "not run yet";

function render() {
  rail.sync();
  header.sync();
  stage.style.width = `${stageW}px`;
  const h = islandHeight();
  shell.style.width = `${stageW}px`;
  shell.style.height = `${h}px`;
  const task = State.focusTask;
  const key = State.view === "overview" ? (task?.id ?? "none") : `view:${State.view}`;
  if (key !== cardKey) {
    cardKey = key;
    while (leftBody.firstChild) leftBody.removeChild(leftBody.firstChild);
    if (State.view !== "overview") {
      leftBody.textContent = "Fixture mounts the production overview only.";
    } else if (key === JOBS_ID) {
      leftBody.append(jobsCard({ openSession: (id) => State.setFocus(id) }));
    } else if (key === UTILITY_ID) {
      leftBody.append(systemCard());
    } else {
      leftBody.textContent = "Fixture: select Jobs or System in the sidebar rail.";
    }
  } else if (State.view === "overview") {
    if (key === JOBS_ID) {
      updateJobsCard(leftBody.firstElementChild as HTMLElement | null, { openSession: (id) => State.setFocus(id) });
    } else if (key === UTILITY_ID) {
      updateSystemCard(leftBody.firstElementChild as HTMLElement | null);
    }
  }
  drawMascot();
  ensureLoop();

  const headerName = hdrMount.querySelector(".mode-label strong")?.textContent ?? "?";
  const railTitles = [...rail.el.querySelectorAll(".ri")].map((b) => b.getAttribute("title") ?? "?");
  const tabs = leftBody.querySelector(".sys-tabs, .sys-tab");
  const auto = leftBody.querySelector(".sys-auto");
  const tileValues = [...leftBody.querySelectorAll(".sys-tile")].map((t) => {
    const v = t.querySelector(".vl")?.textContent ?? "?";
    const d = t.querySelector(".dt")?.textContent ?? "?";
    return `${v} (${d})`;
  });
  const owner = Focus.owner;
  readout.textContent =
    `STAGE width=${stageW} (production island is ${EXPANDED_W}; narrow is a squeeze stress check)\n` +
    `focus=${State.focusId} header=${headerName} islandH=${h} mood=${currentSystemMood()} pin=${getPinnedJobId() ?? "auto"}\n` +
    `rail=[${railTitles.join(" | ")}]\n` +
    `innerTabs=${tabs ? "PRESENT (bad)" : "absent (good)"} auto=${auto ? auto.textContent : "absent (Jobs only)"}\n` +
    `tiles=${tileValues.length > 0 ? tileValues.join(" | ") : "n/a (Jobs destination)"}\n` +
    `moment=${owner.moment ? `${owner.moment.taskId}:${owner.moment.line1}` : "none"} focusCheck=${focusCheck}`;
}

function button(label: string, fn: () => void) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    try {
      fn();
    } catch (err) {
      say(`button ${label} threw: ${String(err)}`);
    }
    render();
  });
  buttons.append(btn);
}

button("Select Jobs", () => State.setFocus(JOBS_ID));
button("Select System", () => State.setFocus(UTILITY_ID));
button("Crowded rail (5 agents)", () => {
  for (let i = 0; i < 5; i++) State.tasks.push(fixtureJob("working"));
  State.notify();
  say("Fixture: 5 live agents added. Rail must keep Jobs and System reachable via scroll.");
});
button("Idle rail", () => {
  State.tasks = State.tasks.filter((t) => !t.id.startsWith("agent_fixture_") || t.id === "agent_fixture_1");
  const first = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (first) { first.state = "working"; first.steps = ["Fixture step (live)"]; }
  State.notify();
  say("Fixture: back to one live job.");
});
button("Live tick", () => {
  const job = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (job) {
    job.steps.push(`Fixture live tick ${job.steps.length}`);
    State.notify();
    say("Fixture: live step appended; card updates in place.");
  }
});
button("Pin first pill", () => {
  const rows = State.tasks.filter((t) => t.id === "integration_claude" || t.id.startsWith("agent_"));
  const rest = rows.filter((t) => t.id.startsWith("agent_fixture_")).slice(1);
  const target = rest[0] ?? rows.find((t) => t.id.startsWith("agent_fixture_"));
  if (target) {
    setPinnedJobId(target.id);
    State.notify();
    say(`Fixture: pinned ${target.id}. Pin must survive live ticks until Resume Auto.`);
  }
});
button("Resume Auto", () => {
  setPinnedJobId(null);
  State.notify();
  say("Fixture: Auto resumed.");
});
button("Focus check: live update keeps control", () => {
  State.setFocus(JOBS_ID);
  State.view = "overview";
  render();
  const auto = leftBody.querySelector(".sys-auto") as HTMLElement | null;
  if (!auto) {
    focusCheck = "no Auto control (bad)";
    say("Fixture: no Auto control found on Jobs.");
    return;
  }
  auto.focus();
  const before = document.activeElement;
  const job = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (job) job.steps.push("Fixture focus-check tick");
  State.notify();
  updateJobsCard(leftBody.firstElementChild as HTMLElement | null, { openSession: (id) => State.setFocus(id) });
  rail.sync();
  header.sync();
  focusCheck = document.activeElement === before ? "Auto kept focus (good)" : "focus moved (bad)";
  say(`Fixture: live update focus check: ${focusCheck}.`);
});
button("High load", () => {
  State.integrations[UTILITY_ID] = {
    ...State.integrations[UTILITY_ID],
    data: {
      ...(State.integrations[UTILITY_ID]?.data ?? {}),
      vitals: { cpuPercent: 95, memUsedBytes: 15_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 94, unavailable: null },
    },
  };
  State.notify();
  say("Fixture: high load stored under System only; Jobs face must stay state-driven.");
});
button("Efficient load", () => {
  State.integrations[UTILITY_ID] = {
    ...State.integrations[UTILITY_ID],
    data: {
      ...(State.integrations[UTILITY_ID]?.data ?? {}),
      vitals: { cpuPercent: 10, memUsedBytes: 4_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 25, unavailable: null },
    },
  };
  State.notify();
  say("Fixture: efficient load stored.");
});
button("Battery low warning", () => {
  Focus.moment({ taskId: UTILITY_ID, kind: "warning", line1: "Battery at 19% (Fixture)", line2: "Running on battery", ms: 8000 });
  say("Fixture: System warning moment queued. Pill peek needs the app shell; owner is reported above.");
});
button("Normal 640", () => {
  stageW = EXPANDED_W;
  say("Fixture: production island width 640.");
});
button("Narrow 560", () => {
  stageW = 560;
  say("Fixture: 560 squeeze stress check. Tile percentages must stay readable; details hide by production container query.");
});
button("Reduced motion", () => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  say(`Fixture: prefers-reduced-motion=${mq}. Card, rail and mascot motion rest under the production reduced-motion rules.`);
});
button("Hidden", () => {
  State.mode = "hidden";
  say("Fixture: hidden. Card takes is-hidden, animations pause, mascot loop idles.");
});
button("Expanded", () => {
  State.mode = "expanded";
  State.view = "overview";
  State.notify();
  say("Fixture: expanded overview.");
});

State.subscribe(render);
render();
say("Fixture ready. Production shell with fixture data. Check rail reachability, pinning, Auto, tiles and header here; pill peek and wake need the running app.");
