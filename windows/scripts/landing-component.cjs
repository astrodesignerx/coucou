// Landing component and controller regressions: real production components
// (landing cards, voice demand editor, Tools action controller, overview
// switching, Island geometry) under a stub DOM with fake timers and a stubbed
// Tauri bridge. No source-string assertions: every check drives the actual
// modules, synthetic fixture state only.
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "landing-component-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "--project", ".",
    "--outDir", out,
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--verbatimModuleSyntax", "false",
    "--noEmit", "false",
    "--noUnusedLocals", "false",
    "--noUnusedParameters", "false",
  ],
  { cwd: windowsDir, stdio: "inherit" },
);

// ── Tauri stub (bridge degrades to null/throw without it) ────────────────────
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@tauri-apps/api/core") return { invoke: async () => { throw new Error("stubbed tauri"); } };
  if (request === "@tauri-apps/api/event") return { listen: async () => () => {} };
  if (request === "@tauri-apps/api/webview") {
    return { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) };
  }
  if (/\.css$/.test(request)) return {};
  return origLoad.call(this, request, parent, isMain);
};

// ── Fake timers ──────────────────────────────────────────────────────────────
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realSetInterval = setInterval;
const realClearInterval = clearInterval;
const realSetImmediate = setImmediate;
const realDateNow = Date.now;
let clock = 100000;
let timerID = 0;
const scheduled = new Map();
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++timerID;
  scheduled.set(id, { fn, at: clock + Number(ms || 0), args });
  return id;
}
function fakeClearTimeout(id) { scheduled.delete(id); }
function fakeSetInterval(fn, ms, ...args) {
  const id = ++timerID;
  scheduled.set(id, { fn, at: clock + Number(ms || 0), interval: Number(ms || 0), args });
  return id;
}
function fakeClearInterval(id) { scheduled.delete(id); }
function advance(ms) {
  const target = clock + ms;
  for (let guard = 0; guard < 100000; guard++) {
    let bid = null;
    let best = null;
    for (const [id, t] of scheduled) {
      if (t.at <= target && (!best || t.at < best.at)) { bid = id; best = t; }
    }
    if (!best) break;
    clock = best.at;
    if (best.interval) best.at += best.interval;
    else scheduled.delete(bid);
    best.fn(...(best.args || []));
  }
  clock = target;
}
global.setTimeout = fakeSetTimeout;
global.clearTimeout = fakeClearTimeout;
global.setInterval = fakeSetInterval;
global.clearInterval = fakeClearInterval;
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
Date.now = () => clock;
const flush = () => new Promise((r) => realSetImmediate(r));

// ── Stub DOM ─────────────────────────────────────────────────────────────────
function matchSimple(el, sel) {
  sel = sel.trim();
  if (!sel || sel.includes(" ") || sel.includes(":") || sel.includes("[")) return false;
  if (sel.startsWith(".")) return el._class.has(sel.slice(1));
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(sel)) return el.tagName === sel.toUpperCase();
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)\.([\w-]+)$/);
  if (m) return el.tagName === m[1].toUpperCase() && el._class.has(m[2]);
  return false;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._class = new Set();
    this.dataset = {};
    this.style = {};
    this.style.setProperty = (k, v) => { this.style[k] = String(v); };
    this.style.removeProperty = (k) => { delete this.style[k]; };
    this.style.getPropertyValue = (k) => this.style[k] ?? "";
    this.classList = {
      add: (...c) => c.forEach((x) => this._class.add(x)),
      remove: (...c) => c.forEach((x) => this._class.delete(x)),
      toggle: (c, force) => {
        const has = this._class.has(c);
        const on = force === undefined ? !has : !!force;
        if (on) this._class.add(c);
        else this._class.delete(c);
        return on;
      },
      contains: (c) => this._class.has(c),
    };
    this.textContent = "";
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
  }
  get className() { return [...this._class].join(" "); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.children[0] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return !!n.__connected;
  }
  append(...nodes) {
    for (let n of nodes) {
      if (n == null || n === false) continue;
      if (typeof n === "string") n = { textContent: n, parentNode: null, nodeType: 3 };
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.children.push(n);
    }
    return nodes[0];
  }
  appendChild(n) { return this.append(n); }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const list = this.listeners.get(t);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === "class") this.className = String(v);
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  matches(sel) {
    if (/:(hover|focus|focus-within|focus-visible|active)\b/.test(sel)) return false;
    return matchSimple(this, sel);
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n instanceof El && matchSimple(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c instanceof El) {
          if (matchSimple(c, sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 };
  }
  getContext() { return null; }
  focus() { global.document.activeElement = this; }
  blur() { if (global.document.activeElement === this) global.document.activeElement = null; }
  click() { fire(this, "click"); }
  scrollIntoView() {}
  select() {}
}

function fire(el, type, extra = {}) {
  const evt = { type, target: el, currentTarget: el, stopPropagation() {}, preventDefault() {}, ...extra };
  for (const fn of [...(el.listeners.get(type) ?? [])]) fn.call(el, evt);
}

function btnConnected(el) {
  let n = el;
  while (n.parentNode) n = n.parentNode;
  return !!n.__connected;
}

function makeRoot() {
  const root = new El("div");
  docRoot.append(root);
  return root;
}

const docRoot = new El("doc");
docRoot.__connected = true;

let reducedMotion = false;
const docListeners = new Map();
global.document = {
  activeElement: null,
  hidden: false,
  createElement: (t) => new El(t),
  createElementNS: (_ns, t) => new El(t),
  createTextNode: (t) => ({ textContent: String(t), parentNode: null, nodeType: 3 }),
  addEventListener: (t, fn) => {
    if (!docListeners.has(t)) docListeners.set(t, []);
    docListeners.get(t).push(fn);
  },
  removeEventListener: (t, fn) => {
    const list = docListeners.get(t);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  body: new El("body"),
};
global.document.body.__connected = true;
global.window = {
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  matchMedia: () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  }),
  devicePixelRatio: 1,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  getComputedStyle: () => ({ font: "600 13px sans-serif" }),
  addEventListener() {},
  removeEventListener() {},
};
global.navigator = {};

// ── Modules ──────────────────────────────────────────────────────────────────
const { State } = require(path.join(out, "core/state.js"));
const landing = require(path.join(out, "choom/landing.js"));
const landingSection = require(path.join(out, "choom/landingSection.js"));
const { Voice, resetSubmissionGuard } = require(path.join(out, "choom/voice.js"));
const voiceSection = require(path.join(out, "choom/voiceSection.js"));
const { Focus } = require(path.join(out, "choom/focus.js"));
const toolsStore = require(path.join(out, "choom/tools.js"));
const toolsSection = require(path.join(out, "choom/toolsSection.js"));
const { Bridge } = require(path.join(out, "core/bridge.js"));

// Listener counters prove disposal restores subscriptions.
const origStateSub = State.subscribe.bind(State);
const origVoiceSub = Voice.subscribe.bind(Voice);
let stateActive = 0;
let voiceActive = 0;
State.subscribe = (fn) => {
  stateActive++;
  const off = origStateSub(fn);
  return () => { stateActive--; off(); };
};
Voice.subscribe = (fn) => {
  voiceActive++;
  const off = origVoiceSub(fn);
  return () => { voiceActive--; off(); };
};

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

function resetWorld() {
  State.tasks = [
    { id: "integration_claude", name: "VS Code", color: "#ffffff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  ];
  State.focusId = "integration_claude";
  State.pendingApproval = null;
  State.integrations = {};
  State.mode = "expanded";
  State.view = "overview";
  State.paused = false;
  State.settings.jobRadar = true;
  State.settings.tools = { version: 1, colours: [], shortcuts: [], routines: [] };
  Voice.state.runtime = "standby";
  Voice.state.stable = [];
  Voice.state.pendingSegments = [];
  Voice.state.partial = "";
  Voice.state.receipt = null;
  Voice.state.ambiguity = [];
  Voice.state.routinePreview = null;
  Voice.state.approvalNote = null;
  resetSubmissionGuard();
  landing.showHome();
  scheduled.clear();
}

function withMusicAndJob() {
  State.integrations.integration_music = {
    data: { active: true, playing: true, title: "Fixture Song", artist: "Fixture Artist", app: "Fixture Player", art: null, positionMs: 0, durationMs: 204000, updatedAtMs: 0 },
    loaded: true, configured: true, error: null,
  };
  State.tasks.push({ id: "agent_fixture_1", name: "Fixture job 1", color: "#7BA7D9", state: "working", stepIndex: 0, steps: ["Fixture step 1"], source: "agent", isIntegration: false });
}

async function main() {
  // Fix 1: owned disposers; repeated switches restore listener counts.
  resetWorld();
  const baseState = stateActive;
  const baseVoice = voiceActive;
  const micCalls = { start: 0, stop: 0 };
  for (let i = 0; i < 5; i++) {
    const home = landingSection.landingHomeCard({
      onInput: () => {},
      onOpenVoice: () => {},
      onMicStart: () => { micCalls.start++; },
      onMicStop: () => { micCalls.stop++; },
    });
    const root = makeRoot();
    root.append(home.el);
    advance(6000);
    home.stop();
    root.remove();
  }
  check("repeated home mounts release every subscription", stateActive === baseState && voiceActive === baseVoice);
  check("repeated mounts leave no live interval behind", scheduled.size === 0);

  // Detached timer auto-stop also unsubscribes without an explicit stop.
  resetWorld();
  const leaked = landingSection.landingHomeCard({
    onInput: () => {}, onOpenVoice: () => {}, onMicStart: () => {}, onMicStop: () => {},
  });
  const leakRoot = makeRoot();
  leakRoot.append(leaked.el);
  const duringState = stateActive;
  check("mounted home holds subscriptions", duringState > baseState);
  leakRoot.remove();
  advance(6000);
  check("detached card auto-stops its timer and subscriptions", stateActive === baseState && voiceActive === baseVoice);

  // Wave and mic runners are owned too.
  resetWorld();
  State.settings.voiceEnabled = true;
  const wave = landingSection.buildLandingWave();
  const wroot = makeRoot();
  wroot.append(wave.el);
  wave.stop();
  wroot.remove();
  const ctrls = landingSection.buildLandingControls({
    onInput: () => {}, onOpenVoice: () => {}, onMicStart: () => { micCalls.start++; }, onMicStop: () => { micCalls.stop++; },
  });
  const croot = makeRoot();
  croot.append(ctrls.el);
  const mic = ctrls.el.querySelector(".landing-mic");
  Voice.state.runtime = "standby";
  Voice.notify();
  fire(mic, "click");
  await flush();
  check("landing mic runs the injected starter", micCalls.start === 1);
  Voice.state.runtime = "listening";
  Voice.notify();
  fire(mic, "click");
  await flush();
  check("landing mic runs the injected stopper while listening", micCalls.stop === 1);
  ctrls.stop();
  croot.remove();
  check("controls release their subscription", stateActive === baseState && voiceActive === baseVoice);

  // Fix 2: Input reaches the production demand editor, first use included.
  resetWorld();
  State.settings.voiceEnabled = true;
  let heightCalls = 0;
  const voiceView = voiceSection.buildVoiceView(() => { heightCalls++; });
  const vroot = makeRoot();
  vroot.append(voiceView.el);
  let viewed = null;
  const home2 = landingSection.landingHomeCard({
    onInput: () => { viewed = "voice"; voiceSection.openVoiceEditor(); },
    onOpenVoice: () => {},
    onMicStart: () => {},
    onMicStop: () => {},
  });
  const hroot = makeRoot();
  hroot.append(home2.el);
  const inputBtn = home2.el.querySelector(".landing-input");
  fire(inputBtn, "click");
  const edit = voiceView.el.querySelector(".voice-edit");
  const editWrap = voiceView.el.querySelector(".voice-editor");
  check("landing Input navigates to the voice view", viewed === "voice");
  check("landing Input opens the demand editor on first use", editWrap && editWrap.style.display !== "none");
  check("editor takes keyboard focus", global.document.activeElement === edit);
  // Draft round-trip through the production editor.
  edit.value = "keep my words";
  fire(edit, "input");
  const doneBtn = voiceView.el.querySelector(".voice-edit-close");
  fire(doneBtn, "click");
  check("Done closes the editor and keeps the draft", editWrap.style.display === "none");
  fire(inputBtn, "click");
  check("reopening restores the preserved draft", edit.value === "keep my words");
  fire(edit, "keydown", { key: "Escape" });
  check("Escape closes and keeps the draft", editWrap.style.display === "none" && edit.value === "keep my words");
  fire(inputBtn, "click");
  edit.value = "";
  fire(edit, "keydown", { key: "Enter" });
  await flush();
  check("Enter on an empty turn closes without submitting", editWrap.style.display === "none" && Voice.state.pendingSegments.length === 0);
  // Capture is untouched by opening the editor.
  Voice.state.runtime = "listening";
  Voice.notify();
  const opened = voiceSection.openVoiceEditor();
  check("opening the editor never cancels capture", opened === true && Voice.state.runtime === "listening");
  Voice.state.runtime = "standby";
  Voice.notify();
  voiceView.dispose();
  home2.stop();
  vroot.remove();
  hroot.remove();
  check("voice and home disposal restores counts", stateActive === baseState && voiceActive === baseVoice);
  const afterDispose = voiceSection.openVoiceEditor();
  check("disposed editor releases its opener", afterDispose === false);

  // Fix 3: cadence survives one-second live updates; real turn labels.
  resetWorld();
  withMusicAndJob();
  const card3 = landingSection.landingHomeCard({
    onInput: () => {}, onOpenVoice: () => {}, onMicStart: () => {}, onMicStop: () => {},
  });
  const root3 = makeRoot();
  root3.append(card3.el);
  const sub = card3.el.querySelector(".landing-subline");
  const first = sub.textContent;
  check("subline starts on the approved invitation", first === "Say Choom, or tap the mic");
  const job = State.tasks.find((t) => t.id === "agent_fixture_1");
  job.steps.push("Fixture tick 2");
  State.notify();
  check("a one-second job tick preserves the rotation slot", sub.textContent === first);
  advance(5000);
  const second = sub.textContent;
  check("rotation still advances on its cadence", second !== first);
  job.steps.push("Fixture tick 3");
  State.notify();
  check("ticks never reset the alternating activity line", sub.textContent === second);
  advance(5000);
  const third = sub.textContent;
  check("rotation continues across updates", third !== second);
  // Explicit click while listening keeps the turn status.
  Voice.state.runtime = "listening";
  Voice.notify();
  check("listening supersedes with its real label", sub.textContent === "Listening to you");
  fire(sub, "click");
  check("clicking while listening keeps the turn status", sub.textContent === "Listening to you");
  Voice.state.runtime = "processing";
  Voice.notify();
  check("processing shows its real state", sub.textContent === "Heard it, thinking");
  Voice.state.runtime = "working";
  Voice.notify();
  check("working shows its real state", sub.textContent === "Working");
  Voice.state.runtime = "speaking";
  Voice.notify();
  check("speaking shows its real state", sub.textContent === "Speaking");
  Voice.state.runtime = "standby";
  Voice.notify();
  // Waveform follows capture only.
  const waveEl = card3.el.querySelector(".landing-wave");
  Voice.state.runtime = "working";
  Voice.notify();
  check("waveform rests while working without capture", !waveEl.classList.contains("live"));
  Voice.state.runtime = "listening";
  Voice.notify();
  check("waveform animates while capturing", waveEl.classList.contains("live"));
  Voice.state.runtime = "standby";
  Voice.notify();
  card3.stop();
  root3.remove();

  // Reduced motion: no auto-advance, deliberate click cycles.
  resetWorld();
  withMusicAndJob();
  reducedMotion = true;
  const card4 = landingSection.landingHomeCard({
    onInput: () => {}, onOpenVoice: () => {}, onMicStart: () => {}, onMicStop: () => {},
  });
  const root4 = makeRoot();
  root4.append(card4.el);
  const sub4 = card4.el.querySelector(".landing-subline");
  const rmFirst = sub4.textContent;
  advance(15000);
  check("reduced motion pauses automatic rotation", sub4.textContent === rmFirst);
  fire(sub4, "click");
  check("reduced motion cycles deliberately on click", sub4.textContent !== rmFirst);
  card4.stop();
  root4.remove();
  reducedMotion = false;

  // Fix 6: shared Tools controller outcomes plus preview workflow.
  resetWorld();
  State.settings.tools = {
    version: 1,
    colours: [],
    shortcuts: [
      { id: "sc-app", name: "Real App", kind: "app", target: "C:\\Tools\\real.exe" },
      { id: "sc-dir", name: "Real Folder", kind: "folder", target: "C:\\Tools" },
    ],
    routines: [{ id: "rt-demo", name: "Demo Routine", steps: ["sc-app", "sc-dir"] }],
  };
  const launched = [];
  const routineCalls = [];
  let routineResult = [{ id: "sc-app", status: "ok", message: "Opened." }, { id: "sc-dir", status: "ok", message: "Opened." }];
  let routineError = null;
  Bridge.toolsLaunchApp = async (target) => { launched.push(target); };
  Bridge.toolsOpenFolder = async (target) => { launched.push(target); };
  Bridge.toolsRoutineStart = async (id, steps) => {
    routineCalls.push({ id, steps });
    if (routineError) throw new Error(routineError);
    return routineResult;
  };
  Bridge.toolsRoutineCancel = async () => {};
  const routine = State.settings.tools.routines[0];
  let outcome = await toolsSection.runToolRoutineAction(routine);
  check("successful run reports real steps", outcome.ok === true && outcome.message === "Ran 2 step(s)." && outcome.results.length === 2);
  routineResult = null;
  outcome = await toolsSection.runToolRoutineAction(routine);
  check("null backend result never claims success", outcome.ok === false && outcome.message === "Finished without reporting results." && outcome.results.length === 0);
  routineResult = [];
  outcome = await toolsSection.runToolRoutineAction(routine);
  check("empty backend result never claims success", outcome.ok === false && outcome.results.length === 0);
  routineError = "backend exploded";
  outcome = await toolsSection.runToolRoutineAction(routine);
  check("backend failure reports honestly", outcome.ok === false && outcome.message === "backend exploded");
  routineError = null;
  routineResult = [{ id: "sc-app", status: "ok", message: "Opened." }];
  const card6 = landingSection.landingLaunchpadCard({ onDone: () => {}, onOpenTools: () => {} });
  const root6 = makeRoot();
  root6.append(card6.el);
  const tiles = card6.el.querySelectorAll(".landing-tile");
  check("launchpad shows only configured tiles", tiles.length === 3);
  check("tiles carry calm cropped assets", tiles.every((t) => t.querySelector(".landing-asset")));
  const routineTile = tiles[2];
  fire(routineTile, "click");
  const steps = card6.el.querySelector(".landing-steps");
  check("routine tile opens the resolved-step preview", !!steps && steps.children.length === 2);
  const runBtn = card6.el.querySelector(".landing-run");
  check("preview owns an explicit Run control", !!runBtn);
  fire(runBtn, "click");
  await flush();
  await flush();
  const status6 = card6.el.querySelector(".landing-status");
  check("run reports the honest partial message", /Reported 1 of 2 steps/.test(status6.textContent));
  // Cancel path with a pending backend run.
  let releaseRun;
  Bridge.toolsRoutineStart = (id, steps) => new Promise((resolve) => { releaseRun = () => resolve([{ id: "sc-app", status: "ok", message: "Opened." }]); });
  fire(card6.el.querySelector(".landing-run"), "click");
  await flush();
  const cancelBtn = card6.el.querySelector(".landing-cancel");
  check("pending run offers Cancel", !!cancelBtn);
  fire(cancelBtn, "click");
  releaseRun();
  await flush();
  await flush();
  check("cancelled run reports honestly", /Cancelled/.test(card6.el.querySelector(".landing-status").textContent));
  // Freshness: a step removed after preview never runs stale.
  State.settings.tools = { version: 1, colours: [], shortcuts: [{ id: "sc-app", name: "Real App", kind: "app", target: "C:\\Tools\\real.exe" }], routines: [{ id: "rt-demo", name: "Demo Routine", steps: ["sc-app", "sc-gone"] }] };
  const stale = await toolsSection.runToolRoutineAction(State.settings.tools.routines[0]);
  check("stale targets fail closed", stale.started === false && /no longer exists/.test(stale.message));
  // Exact per-request occurrence matching on the shared controller.
  State.settings.tools = {
    version: 1, colours: [],
    shortcuts: [
      { id: "sc-a", name: "A", kind: "app", target: "C:\\Tools\\a.exe" },
      { id: "sc-b", name: "B", kind: "app", target: "C:\\Tools\\b.exe" },
    ],
    routines: [{ id: "rt-two", name: "Two", steps: ["sc-a", "sc-b"] }],
  };
  const two = State.settings.tools.routines[0];
  routineResult = [{ id: "sc-a", status: "ok", message: "Opened." }];
  routineError = null;
  Bridge.toolsRoutineStart = async (id, steps) => {
    routineCalls.push({ id, steps });
    if (routineError) throw new Error(routineError);
    return routineResult;
  };
  let m = await toolsSection.runToolRoutineAction(two);
  check("partial results never claim all-success", m.ok === false && m.message === "Reported 1 of 2 steps." && m.results.length === 1);
  routineResult = [{ id: "sc-a", status: "ok", message: "Opened." }, { id: "sc-b", status: "weird", message: "Huh." }];
  m = await toolsSection.runToolRoutineAction(two);
  check("unknown statuses never claim all-success", m.ok === false && /unknown outcome/.test(m.message) && m.results.length === 2);
  routineResult = [{ id: "sc-a", status: "ok", message: "Opened." }, { id: "sc-other", status: "ok", message: "Opened." }];
  m = await toolsSection.runToolRoutineAction(two);
  check("mismatched ids never claim all-success", m.ok === false && /do not match/.test(m.message));
  State.settings.tools.routines = [{ id: "rt-one", name: "One", steps: ["sc-a"] }];
  routineResult = [{ id: "sc-a", status: "ok", message: "Opened." }, { id: "sc-a", status: "ok", message: "Opened." }];
  m = await toolsSection.runToolRoutineAction(State.settings.tools.routines[0]);
  check("duplicate reports never claim all-success", m.ok === false && m.results.length === 2);
  State.settings.tools.routines = [{ id: "rt-rep", name: "Rep", steps: ["sc-a", "sc-a"] }];
  routineResult = [{ id: "sc-a", status: "ok", message: "Opened." }, { id: "sc-a", status: "ok", message: "Opened." }];
  m = await toolsSection.runToolRoutineAction(State.settings.tools.routines[0]);
  check("valid repeated shortcut ids still succeed exactly", m.ok === true && m.message === "Ran 2 step(s).");
  const ghost = { id: "rt-gone", name: "Gone", steps: ["sc-a"] };
  m = await toolsSection.runToolRoutineAction(ghost);
  check("deleted routines never run a stale object", m.started === false && /gone/.test(m.message) && m.results.length === 0);
  card6.stop();
  root6.remove();

  // Fix 3: reviewed-plan capture and freshness gates before Run.
  resetWorld();
  State.settings.tools = {
    version: 1, colours: [],
    shortcuts: [
      { id: "sc-x", name: "X", kind: "app", target: "C:\\X\\x.exe" },
      { id: "sc-y", name: "Y", kind: "folder", target: "C:\\Y" },
    ],
    routines: [{ id: "rt-xy", name: "XY", steps: ["sc-x", "sc-y"] }],
  };
  launched.length = 0;
  routineCalls.length = 0;
  Bridge.toolsLaunchApp = async (target) => { launched.push(target); };
  Bridge.toolsOpenFolder = async (target) => { launched.push(target); };
  Bridge.toolsRoutineStart = async (id, steps) => {
    routineCalls.push({ id, steps });
    return steps.map((s) => ({ id: s.id, status: "ok", message: "Opened." }));
  };
  const cardF = landingSection.landingLaunchpadCard({ onDone: () => {}, onOpenTools: () => {} });
  const rootF = makeRoot();
  rootF.append(cardF.el);
  const statusF = () => cardF.el.querySelector(".landing-status").textContent;
  const rTileF = cardF.el.querySelectorAll(".landing-tile").find((t) => t.getAttribute("aria-label") === "Preview XY");
  fire(rTileF, "click");
  const stepDetail = cardF.el.querySelector(".landing-steps").children
    .map((li) => li.children[1].textContent).join(" | ");
  check("preview displays resolved target details", stepDetail.includes("C:\\X\\x.exe") && stepDetail.includes("C:\\Y"));
  const runNow = () => fire(cardF.el.querySelector(".landing-run"), "click");
  State.settings.tools.shortcuts.find((s) => s.id === "sc-x").target = "C:\\X\\changed.exe";
  runNow();
  check("changed target blocks the launch", routineCalls.length === 0);
  check("changed target requires another deliberate click", /Review the steps/.test(statusF()));
  runNow();
  await flush();
  await flush();
  check("re-review runs the fresh plan", routineCalls.length === 1 && routineCalls[0].steps[0].target === "C:\\X\\changed.exe");
  State.settings.tools.shortcuts.find((s) => s.id === "sc-y").kind = "app";
  runNow();
  check("changed kind blocks the launch", routineCalls.length === 1 && /Review the steps/.test(statusF()));
  runNow();
  await flush();
  await flush();
  check("re-review runs after kind change", routineCalls.length === 2);
  State.settings.tools.routines[0].steps = ["sc-y", "sc-x"];
  runNow();
  check("changed order blocks the launch", routineCalls.length === 2 && /Review the steps/.test(statusF()));
  runNow();
  await flush();
  await flush();
  check("re-review runs after order change", routineCalls.length === 3);
  State.settings.tools.routines = [];
  runNow();
  check("deleted routine never launches", routineCalls.length === 3 && /gone/.test(statusF()));
  check("deleted routine clears its preview", cardF.el.querySelector(".landing-steps") == null);
  State.settings.tools = {
    version: 1, colours: [],
    shortcuts: [{ id: "sc-z", name: "Z", kind: "app", target: "C:\\Z\\z.exe" }],
    routines: [],
  };
  const cardG = landingSection.landingLaunchpadCard({ onDone: () => {}, onOpenTools: () => {} });
  const rootG = makeRoot();
  rootG.append(cardG.el);
  const zTile = cardG.el.querySelectorAll(".landing-tile").find((t) => t.getAttribute("aria-label") === "Launch Z");
  State.settings.tools.shortcuts = [];
  const launchedBefore = launched.length;
  fire(zTile, "click");
  await flush();
  check("deleted shortcut never launches an obsolete target", launched.length === launchedBefore);
  check("deleted shortcut reports honestly", /gone/.test(cardG.el.querySelector(".landing-status").textContent));
  cardF.stop();
  rootF.remove();
  cardG.stop();
  rootG.remove();

  // Fix 7: heading versus subline, adapter-driven job line, music fields.
  resetWorld();
  withMusicAndJob();
  const card7 = landingSection.landingHomeCard({
    onInput: () => {}, onOpenVoice: () => {}, onMicStart: () => {}, onMicStop: () => {},
  });
  const root7 = makeRoot();
  root7.append(card7.el);
  const heading = card7.el.querySelector(".landing-title");
  const sub7 = card7.el.querySelector(".landing-subline");
  check("heading keeps its invitation line", heading && heading.textContent === "What shall we do?");
  check("subline uses the approved line, not a duplicate", sub7 && sub7.textContent === "Say Choom, or tap the mic");
  const lines = landing.sublineLines();
  check("music line uses real app metadata", lines.some((l) => l.includes("Fixture Player") && l.includes("Fixture Song")));
  const { resolveLeadJob, jobRadarRows } = require(path.join(out, "choom/quickAdditions.js"));
  const expected = resolveLeadJob(jobRadarRows(State.tasks)).lead;
  check("job line follows the existing lead adapter", lines.some((l) => expected && l.includes(expected.name)));
  card7.stop();
  root7.remove();

  // Fix 4 + 5: overview switching and Island geometry, including empty Home.
  check("component suites restore every subscription", stateActive === baseState && voiceActive === baseVoice);
  resetWorld();
  let islandSuite = false;
  try {
    const views = require(path.join(out, "views/views.js"));
    const viewActions = {
      setView: (v) => { State.view = v; },
      collapse: () => {},
      setFocus: (id) => { State.setFocus(id); },
      openTerminal: () => {},
      openTarget: () => {},
      openUrl: () => {},
      decide: () => {},
      toggleSound: () => {},
      setVolume: () => {},
      setAutoClose: () => {},
      openSettingsWindow: () => {},
      blip: () => {},
    };
    const header = views.buildHeader(viewActions);
    const hroot = makeRoot();
    hroot.append(header.el);
    const homeTab = header.el.querySelector(".tab");
    fire(homeTab, "click");
    check("header Home reaches the overview", State.view === "overview" && landing.getLandingMode() === "home");
    const allViews = views.buildViews(viewActions, () => {});
    const overview = allViews.get("overview");
    const oroot = makeRoot();
    oroot.append(overview.el);
    overview.el.classList.add("on");
    State.tasks = [];
    State.focusId = null;
    landing.showHome();
    overview.sync();
    check("empty workspace Home renders A", overview.el.querySelector(".landing-home") != null);
    check("empty workspace rail stays reachable without crashing", overview.el.querySelectorAll(".ri").length === 0);
    overview.dispose();
    oroot.remove();
    hroot.remove();
    islandSuite = true;
  } catch (err) {
    failed++;
    console.log(`FAIL: production view suite must run, not skip (${String(err).split("\n")[0]})`);
  }

  try {
    const islandMod = require(path.join(out, "island/island.js"));
    const iroot = makeRoot();
    const island = new islandMod.Island(iroot);
    State.tasks = [];
    State.focusId = null;
    State.pendingApproval = null;
    State.view = "overview";
    State.mode = "expanded";
    landing.showHome();
    const homeSize = island.targetSize();
    check("empty Home uses the base overview height", homeSize.h === 184);
    // Long approval content bypasses home geometry.
    State.tasks = [
      { id: "integration_claude", name: "VS Code", color: "#ffffff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
    ];
    State.focusId = "integration_claude";
    State.pendingApproval = { requestId: "r-long", sessionId: "s", tool: "Bash", command: `run ${"x".repeat(500)}`, taskId: "integration_claude" };
    landing.showHome();
    check("approval bypasses effective home", landing.isHomeVisible() === false);
    // Tools activity geometry is taller than home: open the shortcut form so
    // the bypass is distinguishable from the forced home height.
    toolsStore.setToolsTab("shortcuts");
    toolsStore.setShortcutForm({ editingId: null, name: "", kind: "app", target: "", error: null, confirmSave: false });
    State.focusId = "utility_tools";
    State.tasks.push({ id: "utility_tools", name: "Tools", color: "#EAB308", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false });
    const approvalSize = island.targetSize();
    check("bypassed approval keeps activity geometry", approvalSize.h === 248);
    State.pendingApproval = null;
    toolsStore.setShortcutForm(null);
    const homeAgain = island.targetSize();
    check("effective home restores the base height", homeAgain.h === 184);
    // C-owned measurement: fallback estimate grows with real content and
    // stays bounded; the island follows the C controller, not Tools.
    State.settings.tools = { version: 1, colours: [], shortcuts: [{ id: "sc-1", name: "One", kind: "app", target: "C:\\1.exe" }], routines: [] };
    landing.showLaunchpad();
    State.focusId = "utility_tools";
    State.tasks.push({ id: "utility_tools", name: "Tools", color: "#EAB308", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false });
    check("small C keeps the base height", landingSection.landingLaunchpadHeight() === 184);
    State.settings.tools = {
      version: 1, colours: [],
      shortcuts: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `sc-${i}`, name: `App ${i}`, kind: "app", target: `C:\\${i}.exe` })),
      routines: [
        { id: "rt-a", name: "A", steps: ["sc-1"] },
        { id: "rt-b", name: "B", steps: ["sc-2"] },
        { id: "rt-long", name: "Long", steps: ["sc-1", "sc-2", "sc-3", "sc-4", "sc-5", "sc-6", "sc-1", "sc-2"] },
      ],
    };
    const manyHeight = landingSection.landingLaunchpadHeight();
    check("C estimate grows with real tiles", manyHeight > 184);
    check("C estimate stays bounded", manyHeight <= 320);
    const launchSize = island.targetSize();
    check("island follows the C-owned measurement", launchSize.h === manyHeight);
    // Actual approval route through the real island.
    State.pendingApproval = { requestId: "r-route", sessionId: "s", tool: "Bash", command: `approve ${"y".repeat(300)}`, taskId: "integration_claude" };
    State.tasks = [
      { id: "integration_claude", name: "VS Code", color: "#ffffff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
    ];
    State.focusId = "integration_claude";
    landing.showHome();
    island.alert("approval");
    island.syncDom();
    check("alert opens the approval view", State.view === "approval");
    check("approval keeps its native base height", island.targetSize().h === 160);
    const approvalButtons = [];
    const textOf = (el) => {
      let text = "";
      const walkText = (n) => {
        if (typeof n.textContent === "string" && (!n.children || n.children.length === 0)) text += n.textContent;
        for (const c of n.children || []) walkText(c);
      };
      walkText(el);
      return text;
    };
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c.tagName === "BUTTON") approvalButtons.push(textOf(c));
        walk(c);
      }
    };
    walk(iroot);
    check("permission actions are present", approvalButtons.some((t) => t.includes("Allow")) && approvalButtons.some((t) => t.includes("Deny")));
    check("no landing override on the approval route", iroot.querySelector(".landing-home") == null && landing.isHomeVisible() === false);
    State.pendingApproval = null;
    // Small-tab Home reaches A with zero tasks and keeps pins.
    State.tasks = [];
    State.focusId = null;
    island.fsm.forcePetit();
    island.fsm.forceHome();
    check("small-tab Home reaches A with zero tasks", State.view === "overview" && landing.getLandingMode() === "home");
    islandSuite = islandSuite && true;
  } catch (err) {
    failed++;
    console.log(`FAIL: Island suite must run, not skip (${String(err).split("\n")[0]})`);
  }
  if (!islandSuite) {
    failed++;
    console.log("FAIL: production view and Island suites must run, not skip");
  }
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
