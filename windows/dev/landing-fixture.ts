// Landing fixture: real production header plus the real production overview
// with landing A/B/C, real rail and real BotEngine mascot at production
// geometry. Synthetic fixture data only, no Windows API, no model calls.
// Served by `npm run dev` at /dev/landing-fixture.html, never bundled.
//
// What this proves and what it does not: the header, overview cards, rail,
// subline rotation, controls and mascot are production components at
// production sizes, so A/B/C selection, pinning, focus retention, empty
// states and readings can be exercised here. Pill peek, wake gating, native
// snapshots, hover timing and audio capture need the running app; the readout
// below reports functional state, never visual proof on its own.

import "../src/style.css";
import "../src/choom/choom.css";
import { EXPANDED_W, botPosition } from "../src/core/layout";
import { State, type AgentTask } from "../src/core/state";
import { BotEngine } from "../src/mochi/engine";
import { tickMiniBots } from "../src/mochi/minibots";
import { MUSIC_ID } from "../src/choom/focus";
import {
  JOBS_ID,
  UTILITY_ID,
  jobsLiveHeight,
  systemLiveHeight,
} from "../src/choom/quickAdditions";
import { TOOLS_ID } from "../src/choom/tools";
import {
  dismissToHome,
  getLandingMode,
  isLaunchpadVisible,
  noteFocusSelected,
  showHome,
  showLaunchpad,
  sublineLines,
} from "../src/choom/landing";
import { landingLaunchpadHeight } from "../src/choom/landingSection";
import { Voice } from "../src/choom/voice";
import { buildHeader, buildViews, type ViewActions } from "../src/views/views";

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

State.tasks = [
  { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  fixtureJob("working"),
  { id: MUSIC_ID, name: "Music", color: "#1ED760", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false },
  { id: JOBS_ID, name: "Jobs", color: "#7BA7D9", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false },
  { id: UTILITY_ID, name: "System", color: "#8E939C", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false },
  { id: TOOLS_ID, name: "Tools", color: "#EAB308", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false },
];
State.focusId = "integration_claude";
State.mode = "expanded";
State.view = "overview";
State.paused = false;
State.settings.jobRadar = true;
State.settings.pcVitals = true;
State.settings.batteryMonitor = true;
State.settings.voiceEnabled = true;
State.settings.tools = {
  version: 1,
  colours: [],
  shortcuts: [
    { id: "sc-fixture-app", name: "Fixture App", kind: "app", target: "C:\\Tools\\fixture.exe" },
    { id: "sc-fixture-dir", name: "Fixture Folder", kind: "folder", target: "C:\\Tools" },
  ],
  routines: [{ id: "rt-fixture", name: "Fixture Routine", steps: ["sc-fixture-app"] }],
};
State.integrations[MUSIC_ID] = {
  data: { active: true, playing: false, title: "Fixture Song", artist: "Fixture Artist", app: "Fixture Player", art: null, positionMs: 0, durationMs: 204000, updatedAtMs: Date.now() },
  error: null, loaded: true, configured: true,
};
State.integrations[UTILITY_ID] = {
  data: {
    vitals: { cpuPercent: 12, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 50, unavailable: null },
    battery: { hasBattery: true, percent: 82, charging: false, acOnline: false, timeSecs: 3600, state: "discharging", error: null },
  },
  error: null, loaded: true, configured: true,
};
Voice.state.runtime = "standby";
showHome();

const actions: ViewActions = {
  setView: (v) => { State.view = v; render(); },
  collapse: () => say("Fixture: collapse (app shell owns collapse)"),
  setFocus: (id) => { noteFocusSelected(id); State.setFocus(id); },
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
const views = buildViews(actions, () => render());
const overview = views.get("overview")!;
ovWrap.append(overview.el);
overview.el.classList.add("on");

const engine = new BotEngine();
const BOT_OVERHANG = 40;
function islandHeight(): number {
  if (State.view !== "overview") return 184;
  if (getLandingMode() === "home") return 184;
  // Same production controller as the island: C measures its mounted card.
  if (isLaunchpadVisible()) return landingLaunchpadHeight();
  if (State.focusId === JOBS_ID) return jobsLiveHeight();
  if (State.focusId === UTILITY_ID) return systemLiveHeight();
  return 184;
}
function drawMascot() {
  const h = islandHeight();
  const p = botPosition("expanded", "overview", h, 0);
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
let focusCheck = "not run yet";

function clipReport(): string {
  const left = ovWrap.querySelector(".left") as HTMLElement | null;
  if (!left) return "no left card";
  const over = left.scrollWidth > left.clientWidth + 1 || left.scrollHeight > left.clientHeight + 1;
  const bars = Array.from(ovWrap.querySelectorAll("*")).filter((el) => {
    const h = el as HTMLElement;
    return h.scrollWidth > h.clientWidth + 2 && h.clientWidth > 0;
  }).length;
  return over ? `clipped (${bars} overflowing nodes)` : "no clipped controls";
}

function render() {
  header.sync();
  overview.sync();
  stage.style.width = `${stageW}px`;
  const h = islandHeight();
  shell.style.width = `${stageW}px`;
  shell.style.height = `${h + 44}px`;
  drawMascot();
  ensureLoop();
  const sub = ovWrap.querySelector(".landing-subline")?.textContent ??
    ovWrap.querySelector(".int-status")?.textContent ?? "(activity card)";
  const railTitles = Array.from(ovWrap.querySelectorAll(".ri")).map((b) => b.getAttribute("title") ?? "?");
  readout.textContent =
    `STAGE width=${stageW} (production 640; compact 560 and 400 stress checks)\n` +
    `landing=${getLandingMode()} focus=${State.focusId} islandH=${h} subline=${sub}\n` +
    `sublines=[${sublineLines().join(" | ")}] voice=${Voice.state.runtime}\n` +
    `rail=[${railTitles.join(" | ")}]\n` +
    `${clipReport()} focusCheck=${focusCheck}`;
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

button("A Home", () => { showHome(); State.view = "overview"; say("Fixture: Home shows A despite music."); });
button("B Music", () => { noteFocusSelected(MUSIC_ID); State.setFocus(MUSIC_ID); });
button("B Jobs", () => { noteFocusSelected(JOBS_ID); State.setFocus(JOBS_ID); });
button("B System", () => { noteFocusSelected(UTILITY_ID); State.setFocus(UTILITY_ID); });
button("C Launchpad", () => { showLaunchpad(); State.setFocus(TOOLS_ID); });
button("C Done returns home", () => { dismissToHome(); State.view = "overview"; });
button("Music playing", () => {
  State.integrations[MUSIC_ID] = { ...State.integrations[MUSIC_ID]!, data: { ...(State.integrations[MUSIC_ID]!.data as object), playing: true } };
  State.notify();
  say("Fixture: music playing; A subline alternates, Home does not follow.");
});
button("Music paused", () => {
  State.integrations[MUSIC_ID] = { ...State.integrations[MUSIC_ID]!, data: { ...(State.integrations[MUSIC_ID]!.data as object), playing: false } };
  State.notify();
});
button("Listening on", () => { Voice.state.runtime = "listening"; Voice.notify(); say("Fixture: listening supersedes rotation; waveform live."); });
button("Listening off", () => { Voice.state.runtime = "standby"; Voice.notify(); });
button("Live job tick", () => {
  const job = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (job) { job.steps.push(`Fixture live tick ${job.steps.length}`); State.notify(); }
});
button("Keyboard: Mic keeps focus on live tick", () => {
  showHome();
  State.view = "overview";
  render();
  const mic = ovWrap.querySelector(".landing-mic") as HTMLElement | null;
  if (!mic) { focusCheck = "no Mic control (bad)"; return; }
  mic.focus();
  const before = document.activeElement;
  const job = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (job) job.steps.push("Fixture focus-check tick");
  State.notify();
  overview.sync();
  focusCheck = document.activeElement === before ? "Mic kept focus (good)" : "focus moved (bad)";
  say(`Fixture: ${focusCheck}.`);
});
button("Empty Tools", () => {
  State.settings.tools = { version: 1, colours: [], shortcuts: [], routines: [] };
  showLaunchpad();
  State.notify();
  say("Fixture: empty launchpad must offer Open Tools settings.");
});
button("Configured Tools", () => {
  State.settings.tools = {
    version: 1, colours: [],
    shortcuts: [
      { id: "sc-fixture-app", name: "Fixture App", kind: "app", target: "C:\\Tools\\fixture.exe" },
      { id: "sc-fixture-dir", name: "Fixture Folder", kind: "folder", target: "C:\\Tools" },
    ],
    routines: [{ id: "rt-fixture", name: "Fixture Routine", steps: ["sc-fixture-app"] }],
  };
  showLaunchpad();
  State.notify();
});
button("Many tiles", () => {
  State.settings.tools = {
    version: 1, colours: [],
    shortcuts: [1, 2, 3, 4, 5, 6].map((i) => ({
      id: `sc-many-${i}`,
      name: `Fixture Application Number ${i} With A Long Name`,
      kind: i % 2 === 0 ? "folder" : "app",
      target: i % 2 === 0 ? `C:\\Tools\\Department ${i}\\Workspace` : `C:\\Tools\\Department ${i}\\fixture-application.exe`,
    })),
    routines: [
      { id: "rt-many", name: "Fixture Long Routine With Many Steps", steps: ["sc-many-1", "sc-many-2", "sc-many-3", "sc-many-4", "sc-many-5", "sc-many-6", "sc-many-1", "sc-many-2"] },
      { id: "rt-extra", name: "Extra Routine", steps: ["sc-many-3"] },
    ],
  };
  showLaunchpad();
  State.setFocus(TOOLS_ID);
  State.notify();
  say("Fixture: stress content; island follows the C-owned measurement, tiles scroll internally at max height.");
});
button("Probe C geometry", () => {
  showLaunchpad();
  State.setFocus(TOOLS_ID);
  State.view = "overview";
  State.mode = "expanded";
  render();
  const island = shell;
  const card = ovWrap.querySelector(".landing-launch") as HTMLElement | null;
  const run = ovWrap.querySelector(".landing-run, .landing-tile") as HTMLElement | null;
  const tiles = ovWrap.querySelector(".landing-tiles") as HTMLElement | null;
  const report = {
    islandH: Math.round(island.getBoundingClientRect().height),
    controllerH: landingLaunchpadHeight(),
    cardTop: card ? Math.round(card.getBoundingClientRect().top - island.getBoundingClientRect().top) : null,
    cardBottom: card ? Math.round(card.getBoundingClientRect().bottom - island.getBoundingClientRect().top) : null,
    runVisible: run ? run.getBoundingClientRect().bottom <= island.getBoundingClientRect().bottom + 1 : null,
    tilesScroll: tiles ? tiles.scrollHeight > tiles.clientHeight + 1 : null,
    stageW,
  };
  say(`PROBE ${JSON.stringify(report)}`);
});
button("Normal 640", () => { stageW = EXPANDED_W; });
button("Compact 560", () => { stageW = 560; });
button("Compact 400", () => { stageW = 400; });
button("Reduced motion", () => {
  say(`Fixture: prefers-reduced-motion=${window.matchMedia("(prefers-reduced-motion: reduce)").matches}. Subline cycles on click; wave still.`);
});
button("Hidden", () => { State.mode = "hidden"; say("Fixture: hidden; rotation pauses, timers idle."); });
button("Expanded", () => { State.mode = "expanded"; State.view = "overview"; State.notify(); });

State.subscribe(render);
render();
say("Fixture ready. Inspect A/B/C at 640 and 560/400; check keyboard focus, touch visibility, reduced-motion cycling, no clipped controls or scrollbars, no empty tall panel on Home.");
