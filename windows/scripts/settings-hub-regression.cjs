// Settings hub regression: hub navigation, category wiring, history and
// privacy behavior. Run from windows/:
// node scripts/settings-hub-regression.cjs
//
// Behavioral tests through a minimal DOM stub: navigation, focus, scroll,
// event updates and write counts. No source-string assertions.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");

// Minimal DOM stub for behavioral tests.

class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this._doc = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this._class = "";
    this.dataset = {};
    this._text = "";
    this._html = "";
    this.listeners = {};
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.value = "";
    this.disabled = false;
    this.title = "";
    this.hidden = false;
    this._connected = undefined;
    this.selectionStart = null;
    this.selectionEnd = null;
    const self = this;
    this.classList = {
      add(...c) {
        const s = new Set(self._class.split(/\s+/).filter(Boolean));
        for (const x of c) s.add(x);
        self._class = [...s].join(" ");
      },
      remove(...c) {
        const s = new Set(self._class.split(/\s+/).filter(Boolean));
        for (const x of c) s.delete(x);
        self._class = [...s].join(" ");
      },
      toggle(c, force) {
        const s = new Set(self._class.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !s.has(c) : !!force;
        if (on) s.add(c);
        else s.delete(c);
        self._class = [...s].join(" ");
        return on;
      },
      contains(c) {
        return self._class.split(/\s+/).includes(c);
      },
    };
    this.style = {
      setProperty(k, v) {
        self.style[k] = String(v);
      },
    };
  }
  get className() {
    return this._class;
  }
  set className(v) {
    this._class = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent ?? "").join("");
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get type() {
    if (this.tagName !== "INPUT") return this.attributes.type ?? "";
    return this.attributes.type ?? "text";
  }
  set type(v) {
    this.setAttribute("type", String(v));
  }
  get isConnected() {
    if (this._connected !== undefined) return this._connected;
    return this.parentNode ? this.parentNode.isConnected : false;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "class") this._class = String(v);
  }
  getAttributeNames() { return Object.keys(this.attributes); }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  append(...kids) {
    for (const kid of kids.flat(9)) {
      if (kid == null || kid === false) continue;
      const node = typeof kid === "string" ? this._doc.createTextNode(kid) : kid;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(kid) {
    this.append(kid);
    return kid;
  }
  removeChild(kid) {
    const at = this.children.indexOf(kid);
    if (at >= 0) this.children.splice(at, 1);
    kid.parentNode = null;
    return kid;
  }
  replaceChild(newKid, oldKid) {
    const at = this.children.indexOf(oldKid);
    if (at < 0) throw new Error("replaceChild: not a child");
    if (newKid.parentNode) newKid.parentNode.removeChild(newKid);
    this.children[at] = newKid;
    newKid.parentNode = this;
    oldKid.parentNode = null;
    return oldKid;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(node) {
    let at = node;
    while (at) {
      if (at === this) return true;
      at = at.parentNode;
    }
    return false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    // Own listeners first, then bubble toward the surface like real input
    // and change events do.
    let at = this;
    while (at) {
      const fns = (at.listeners[ev.type] || []).slice();
      for (const fn of fns) fn.call(at, ev);
      if (ev.bubbles === false) break;
      at = at.parentNode;
    }
    return true;
  }
  click() {
    this.dispatchEvent({ type: "click", target: this, preventDefault() {} });
  }
  focus() {
    this._doc.activeElement = this;
  }
  blur() {
    if (this._doc.activeElement === this) this._doc.activeElement = null;
  }
  querySelector(sel) {
    return queryAll(this, sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
}

function parseCompound(sel) {
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error(`unsupported selector: ${sel}`);
  const attrs = [...m[3].matchAll(/\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g)]
    .map((x) => ({ k: x[1], v: x[2] }));
  return {
    tag: m[1] ? m[1].toUpperCase() : null,
    classes: (m[2].match(/\.([A-Za-z0-9_-]+)/g) || []).map((s) => s.slice(1)),
    attrs,
  };
}

function matches(el, c) {
  if (el.tagName.startsWith("#")) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    const v = el.attributes[a.k];
    if (v === undefined) return false;
    if (a.v !== undefined && v !== a.v) return false;
  }
  return true;
}

function queryAll(root, sel) {
  const parts = sel.trim().split(/\s+/).map(parseCompound);
  const out = [];
  const walk = (el, idx) => {
    for (const kid of el.children) {
      if (!kid.tagName.startsWith("#") && matches(kid, parts[idx])) {
        if (idx === parts.length - 1) out.push(kid);
        else walk(kid, idx + 1);
      }
      walk(kid, idx);
    }
  };
  walk(root, 0);
  return out;
}

function createDocument() {
  const listeners = {};
  const doc = {
    activeElement: null,
    hidden: false,
    documentElement: null,
    createElement: (tag) => new El(tag, doc),
    createElementNS: (_ns, tag) => new El(tag, doc),
    createTextNode: (text) => {
      const el = new El("#text", doc);
      el._text = String(text);
      return el;
    },
    getElementById: (id) => (id === "settings-root" ? doc._root || null : null),
    addEventListener: (t, fn) => {
      (listeners[t] ||= []).push(fn);
    },
    removeEventListener: (t, fn) => {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
    _dispatch: (ev) => {
      for (const fn of listeners[ev.type] || []) fn(ev);
    },
    _counts: () => Object.fromEntries(
      Object.entries(listeners).map(([k, v]) => [k, v.length]),
    ),
  };
  doc.documentElement = new El("html", doc);
  return { doc, listeners };
}

// Module loading with real relative import resolution.

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

const tick = (n = 8) => new Promise((resolve) => {
  const step = (i) => (i <= 0 ? resolve() : setImmediate(() => step(i - 1)));
  step(n);
});

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-hub-test-"));
  let passed = 0;
  const pass = (name) => {
    passed += 1;
    assert.ok(true, name);
  };

  // Shared document for the main wiring test.
  const { doc } = createDocument();
  const root = doc.createElement("div");
  root.setAttribute("id", "settings-root");
  doc._root = root;
  const windowHandlers = {};
  const windowStub = {
    location: { search: "" },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (t, fn) => {
      (windowHandlers[t] ||= []).push(fn);
    },
    removeEventListener: (t, fn) => {
      windowHandlers[t] = (windowHandlers[t] || []).filter((f) => f !== fn);
    },
    _dispatch: (ev) => {
      for (const fn of windowHandlers[ev.type] || []) fn(ev);
    },
    _counts: () => Object.fromEntries(
      Object.entries(windowHandlers).map(([k, v]) => [k, v.length]),
    ),
  };

  // Bridge stub with write and listener counters.
  const handlers = {};
  const onEventCalls = {};
  const counts = { saveSettings: 0, secretSet: 0, secretClear: 0, jevClearHistory: 0 };
  let jevHistoryImpl = () => Promise.resolve([]);
  let cleared = false;
  const bridgeStub = {
    Bridge: {
      boot: () => Promise.resolve({ settings: {}, version: "9.9-test" }),
      saveSettings: () => {
        counts.saveSettings += 1;
        return Promise.resolve();
      },
      hooksStatus: () => Promise.resolve({
        installed: false, settingsPath: "", hookPath: "", hookReady: false,
      }),
      codexStatus: () => Promise.resolve({
        installed: false, settingsPath: "", hookPath: "", hookReady: false,
      }),
      secretPresent: () => Promise.resolve(false),
      secretSet: () => {
        counts.secretSet += 1;
        return Promise.resolve();
      },
      secretClear: () => {
        counts.secretClear += 1;
        return Promise.resolve();
      },
      jevHistory: (...a) => jevHistoryImpl(...a),
      jevClearHistory: () => {
        counts.jevClearHistory += 1;
        cleared = true;
        return Promise.resolve();
      },
    },
    IS_TAURI: false,
    onEvent: (name, fn) => {
      handlers[name] = fn;
      onEventCalls[name] = (onEventCalls[name] || 0) + 1;
      return () => {};
    },
  };
  const stateStub = { DEFAULT_SETTINGS: { activeIntegrations: [], tools: {} } };

  const calls = {};
  function sectionStub(name, extra) {
    return () => {
      calls[name] = (calls[name] || 0) + 1;
      const el = doc.createElement("section");
      el.setAttribute("data-stub", name);
      const b = doc.createElement("b");
      b.textContent = name;
      el.append(b);
      if (extra) extra(el);
      return el;
    };
  }
  const holder = { text: "hello", sel: "local-sel", range: 20, check: false, on: false, extra: false };
  const stubs = {
    chat: sectionStub("chat", (el) => {
      const inp = doc.createElement("input");
      inp.value = holder.text;
      el.append(inp);
      const range = doc.createElement("input");
      range.setAttribute("type", "range");
      range.value = holder.range;
      el.append(range);
      const box = doc.createElement("input");
      box.setAttribute("type", "checkbox");
      box.checked = holder.check;
      el.append(box);
      if (holder.extra) {
        const more = doc.createElement("div");
        more.textContent = "extra row";
        el.append(more);
      }
    }),
    voice: sectionStub("voice"),
    music: sectionStub("music"),
    wake: sectionStub("wake"),
    quick: sectionStub("quick"),
    opencode: sectionStub("opencode"),
    jev: sectionStub("jev", (el) => {
      const sel = doc.createElement("select");
      sel.value = holder.sel;
      el.append(sel);
      const sw = doc.createElement("button");
      sw.setAttribute("aria-pressed", holder.on ? "true" : "false");
      sw.textContent = "switch";
      el.append(sw);
    }),
  };

  class MiniEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.target = init.target ?? null;
      Object.assign(this, init);
    }
    preventDefault() {}
  }

  const ctx = vm.createContext({
    document: doc,
    window: windowStub,
    console,
    URLSearchParams,
    Date,
    Promise,
    Set,
    Map,
    HTMLElement: El,
    SVGElement: El,
    Node: El,
    Event: MiniEvent,
  });

  // Real relative import resolution: compiled TS keeps require("./hub") and
  // require("../views/dom") forms, so resolve from the requiring file.
  function resolveRel(fromRel, spec) {
    const fromDir = fromRel.split("/").slice(0, -1);
    const parts = [];
    for (const seg of [...fromDir, ...spec.split("/")]) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return parts.join("/").replace(/\.ts$/, "");
  }

  const moduleCache = {};
  function loadReal(relNoExt) {
    if (moduleCache[relNoExt]) return moduleCache[relNoExt];
    const rel = `${relNoExt}.ts`;
    const file = compile(rel, tmp);
    const code = fs.readFileSync(file, "utf8");
    const mod = { exports: {} };
    const requireFn = (spec) => {
      if (spec.endsWith(".css")) return {};
      const resolved = resolveRel(relNoExt, spec);
      if (resolved === "src/views/dom") return loadReal("src/views/dom");
      if (resolved === "src/settings/hub") return loadReal("src/settings/hub");
      if (resolved === "src/settings/historySection") {
        return loadReal("src/settings/historySection");
      }
      if (resolved === "src/settings/privacySection") {
        return loadReal("src/settings/privacySection");
      }
      if (resolved === "src/choom/jev") return loadReal("src/choom/jev");
      if (resolved === "src/core/bridge") return bridgeStub;
      if (resolved === "src/core/state") return stateStub;
      if (resolved === "src/choom/chatSection") return { chatSection: stubs.chat };
      if (resolved === "src/choom/voiceSection") {
        return { voiceSettingsSection: stubs.voice, jevSettingsSection: stubs.jev };
      }
      if (resolved === "src/choom/musicSection") return { musicSection: stubs.music };
      if (resolved === "src/choom/wakeSection") return { wakeSection: stubs.wake };
      if (resolved === "src/choom/quickAdditionsSection") {
        return { quickAdditionsSettingsSection: stubs.quick };
      }
      if (resolved === "src/choom/opencodeSection") {
        return { opencodeSection: stubs.opencode };
      }
      throw new Error(`unexpected require: ${spec} (from ${relNoExt})`);
    };
    const runner = new vm.Script(
      `(function(exports, module, require){${code}})`,
      { filename: rel },
    );
    runner.runInContext(ctx)(mod.exports, mod, requireFn);
    moduleCache[relNoExt] = mod.exports;
    return mod.exports;
  }

  const registry = {
    dom: loadReal("src/views/dom"),
    jev: loadReal("src/choom/jev"),
    hub: loadReal("src/settings/hub"),
    history: loadReal("src/settings/historySection"),
    privacy: loadReal("src/settings/privacySection"),
  };
  loadReal("src/settings/main");
  await tick();

  const surface = root.children[1];
  assert.ok(surface && surface.classList.contains("hub-surface"), "hub surface mounts");
  // Simulate the mounted Settings window: layout metrics are real from here.
  surface._connected = true;
  pass("surface");

  // 1. Registry: nine categories, priority plus rail partition.
  const Hub = registry.hub;
  assert.equal(Hub.HUB_CATEGORIES.length, 9, "nine categories");
  const ids = Hub.HUB_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, 9, "ids unique");
  assert.deepEqual([...Hub.HUB_PRIORITY], ["voice", "brain", "history"]);
  assert.deepEqual(
    [...Hub.HUB_RAIL],
    ["appearance", "music", "tools", "wake", "connections", "privacy"],
  );
  assert.deepEqual(
    [...Hub.HUB_PRIORITY, ...Hub.HUB_RAIL].sort(),
    [...ids].sort(),
    "priority plus rail cover every category",
  );
  for (const c of Hub.HUB_CATEGORIES) {
    assert.ok(c.title && c.blurb && c.icon, `${c.id} has label copy`);
  }
  assert.equal(
    new Set(Hub.HUB_CATEGORIES.map((c) => c.title)).size, 9,
    "titles unique",
  );
  pass("registry");

  // 2. Home: nine equal tiles with accessible names and artwork.
  const tiles = surface.querySelectorAll(".hub-tile");
  assert.equal(tiles.length, 9, "nine home tiles");
  for (const t of tiles) {
    assert.equal(t.tagName, "BUTTON", "tiles are buttons");
    assert.ok((t.getAttribute("aria-label") || "").length > 3, "tile named");
    assert.ok(t.querySelector(".tile-art"), "tile carries artwork");
    assert.ok(t.querySelector(".sculpture"), "tile carries a sculpture");
  }
  assert.ok(surface.querySelector(".hub-lead"), "heading leads the first column");
  assert.ok(surface.querySelector(".hub-more"), "scrolling row present");
  const edgeBtn = surface.querySelector(".hub-edge button");
  assert.ok(edgeBtn, "edge chevron present");
  pass("home");

  // Nothing builds before its category opens.
  assert.deepEqual(calls, {}, "lazy: no detail built on home");
  pass("lazy");

  // 3. Detail, capsules, back and focus restoration.
  const findVoiceTile = () => surface.querySelectorAll(".hub-tile")
    .find((t) => (t.getAttribute("aria-label") || "").startsWith("Voice:"));
  findVoiceTile().click();
  assert.equal(calls.voice, 1, "voice detail builds on open");
  let heading = surface.querySelector(".hub-focus-head h2");
  assert.equal(heading.textContent, "Voice", "detail heading names the category");
  assert.equal(surface.querySelector(".hub-priority"), null, "grid replaced in place");
  const capsules = surface.querySelectorAll(".hub-capsule");
  assert.equal(capsules.length, 9, "capsules cover every category");
  assert.equal(doc.activeElement.tagName, "H2", "focus moves to the detail heading");
  surface.querySelector(".hub-back").click();
  assert.equal(surface.querySelectorAll(".hub-tile").length, 9, "back returns home");
  assert.equal(doc.activeElement, findVoiceTile(), "focus returns to the invoking tile");
  pass("detail-back-focus");

  // 4. Category switching without a home roundtrip.
  findVoiceTile().click();
  const brainCap = surface.querySelectorAll(".hub-capsule")[1];
  brainCap.click();
  heading = surface.querySelector(".hub-focus-head h2");
  assert.equal(heading.textContent, "Brain", "capsule switches detail");
  assert.equal(calls.chat, 1, "brain chat builds once");
  assert.equal(calls.jev, 1, "brain jev builds once");
  assert.equal(calls.music || 0, 0, "unopened categories stay unbuilt");
  pass("switching");

  // 5. Every category reachable exactly once per first open.
  const order = ["appearance", "music", "tools", "wake", "connections", "privacy", "history"];
  const capIndex = { appearance: 3, music: 4, tools: 5, wake: 6, connections: 7, privacy: 8, history: 2 };
  for (const id of order) {
    surface.querySelectorAll(".hub-capsule")[capIndex[id]].click();
    assert.equal(
      surface.querySelector(".hub-focus-head h2").textContent,
      Hub.HUB_CATEGORIES.find((c) => c.id === id).title,
      `${id} detail opens`,
    );
  }
  assert.equal(calls.music, 1, "music built once");
  assert.equal(calls.wake, 1, "wake built once");
  assert.equal(calls.quick, 1, "tools built once");
  assert.equal(calls.opencode, 1, "connections opencode built once");
  surface.querySelector(".hub-back").click();
  findVoiceTile().click();
  assert.equal(calls.voice, 1, "reopen reuses the cached detail");
  pass("reachability");

  // 6. Rail scroll survives detail and back navigation.
  surface.querySelector(".hub-back").click();
  let rail = surface.querySelector(".hub-more");
  rail.scrollWidth = 600;
  rail.clientWidth = 200;
  rail.scrollLeft = 120;
  surface.querySelectorAll(".hub-tile")[4].click();
  surface.querySelector(".hub-back").click();
  rail = surface.querySelector(".hub-more");
  assert.equal(rail.scrollLeft, 120, "lower-row position preserved");
  pass("rail-scroll");

  // 7. Edge chevron pages forward and returns to start at the end.
  rail.scrollWidth = 600;
  rail.clientWidth = 200;
  rail.scrollLeft = 0;
  const edge = surface.querySelector(".hub-edge button");
  edge.click();
  assert.equal(rail.scrollLeft, 200, "chevron advances one page");
  edge.click();
  assert.equal(rail.scrollLeft, 400, "chevron reaches the end");
  assert.equal(edge.getAttribute("aria-label"), "Back to first settings", "label flips at end");
  edge.click();
  assert.equal(rail.scrollLeft, 0, "at the end, return to start");
  pass("edge");

  // 8. Navigation never writes.
  assert.equal(counts.saveSettings, 0, "no settings writes while navigating");
  assert.equal(counts.secretSet, 0, "no credential writes while navigating");
  assert.equal(counts.secretClear, 0, "no credential clears while navigating");
  pass("no-writes");

  // 9. Focused credential draft: siblings update in place, input untouched.
  surface.querySelectorAll(".hub-tile")[1].click();
  let input = surface.querySelector(".hub-detail-body input");
  assert.ok(input, "brain stub exposes an input");
  const voiceBefore = calls.voice;
  input.focus();
  input.value = "draft";
  input.dispatchEvent({ type: "input", target: input, preventDefault() {} });
  holder.text = "draft";
  holder.sel = "remote-sel";
  holder.range = 80;
  holder.check = true;
  holder.on = true;
  const chatBefore = calls.chat;
  handlers["settings-changed"]({ voiceEnabled: true });
  const inputAfter = surface.querySelector(".hub-detail-body input");
  assert.equal(inputAfter, input, "focused input keeps its identity");
  assert.equal(inputAfter.value, "draft", "unsaved draft preserved");
  assert.equal(doc.activeElement, input, "focus and caret stay put");
  assert.equal(
    surface.querySelector(".hub-detail-body select").value,
    "remote-sel",
    "unrelated select updates under focus",
  );
  assert.equal(
    surface.querySelectorAll(".hub-detail-body input")[1].value,
    80,
    "unrelated range updates under focus",
  );
  assert.equal(
    surface.querySelectorAll(".hub-detail-body input")[2].checked,
    true,
    "unrelated checkbox updates under focus",
  );
  assert.equal(
    surface.querySelector(".hub-detail-body button").getAttribute("aria-pressed"),
    "true",
    "unrelated switch updates under focus",
  );
  assert.equal(calls.voice, voiceBefore + 1, "cached offscreen detail reconciles");
  assert.equal(onEventCalls["settings-changed"], 1, "single settings listener");
  input.blur();
  surface.dispatchEvent({ type: "focusout", target: input, preventDefault() {} });
  await tick();
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "draft",
    "draft survives blur with nothing deferred",
  );
  surface.querySelector(".hub-back").click();
  surface.querySelectorAll(".hub-tile")[1].click();
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "draft",
    "draft survives navigation away and back",
  );
  pass("events");

  // 10. Committed markers clear: saved controls follow later remotes.
  holder.text = "draft";
  holder.sel = "remote-sel";
  const selCommitted = surface.querySelector(".hub-detail-body select");
  selCommitted.dispatchEvent({ type: "change", target: selCommitted, preventDefault() {} });
  handlers["settings-changed"]({ voiceEnabled: true });
  assert.equal(
    surface.querySelector(".hub-detail-body select").value,
    "remote-sel",
    "saved select is not pinned by its change marker",
  );
  holder.sel = "remote-sel-2";
  handlers["settings-changed"]({ voiceEnabled: false });
  assert.equal(
    surface.querySelector(".hub-detail-body select").value,
    "remote-sel-2",
    "saved select follows later remote updates",
  );
  holder.range = 40;
  const rangeCommitted = surface.querySelectorAll(".hub-detail-body input")[1];
  rangeCommitted.value = 40;
  rangeCommitted.dispatchEvent({ type: "input", target: rangeCommitted, preventDefault() {} });
  rangeCommitted.dispatchEvent({ type: "change", target: rangeCommitted, preventDefault() {} });
  handlers["settings-changed"]({ voiceEnabled: true });
  holder.range = 80;
  handlers["settings-changed"]({ voiceEnabled: false });
  assert.equal(
    surface.querySelectorAll(".hub-detail-body input")[1].value,
    80,
    "committed range shows 80, not the old 40",
  );
  // A committed text draft clears its marker once the factory confirms it.
  const commitInput = surface.querySelector(".hub-detail-body input");
  commitInput.focus();
  commitInput.value = "committed text";
  commitInput.dispatchEvent({ type: "input", target: commitInput, preventDefault() {} });
  holder.text = "committed text";
  commitInput.blur();
  surface.dispatchEvent({ type: "focusout", target: commitInput, preventDefault() {} });
  await tick();
  handlers["settings-changed"]({ voiceEnabled: true });
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "committed text",
    "confirmed value stays put",
  );
  holder.text = "remote text";
  handlers["settings-changed"]({ voiceEnabled: false });
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "remote text",
    "confirmed text draft follows the next remote",
  );
  pass("committed");

  // 11. Structural change under focus defers the rebuild until blur.
  const structInput = surface.querySelector(".hub-detail-body input");
  structInput.focus();
  structInput.value = "structural draft";
  structInput.dispatchEvent({ type: "input", target: structInput, preventDefault() {} });
  holder.extra = true;
  handlers["settings-changed"]({ voiceEnabled: true });
  assert.equal(
    surface.querySelector(".hub-detail-body input"),
    structInput,
    "structural mismatch keeps the focused input",
  );
  assert.equal(
    surface.querySelector(".hub-detail-body").textContent.includes("extra row"),
    false,
    "new row waits for blur",
  );
  structInput.blur();
  surface.dispatchEvent({ type: "focusout", target: structInput, preventDefault() {} });
  await tick();
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "structural draft",
    "draft lands with the deferred rebuild",
  );
  assert.equal(
    surface.querySelector(".hub-detail-body").textContent.includes("extra row"),
    true,
    "new row appears after blur",
  );
  holder.extra = false;
  handlers["settings-changed"]({ voiceEnabled: false });
  surface.querySelector(".hub-back").click();
  pass("structural");

  // 12. Deferred refresh follows navigation and lands offscreen.
  const awayInput = surface.querySelectorAll(".hub-tile")[1];
  awayInput.click();
  const awayField = surface.querySelector(".hub-detail-body input");
  awayField.focus();
  awayField.value = "away draft";
  awayField.dispatchEvent({ type: "input", target: awayField, preventDefault() {} });
  holder.extra = true;
  handlers["settings-changed"]({ voiceEnabled: true });
  surface.querySelectorAll(".hub-capsule")[0].click();
  surface.dispatchEvent({ type: "focusout", target: awayField, preventDefault() {} });
  await tick();
  surface.querySelectorAll(".hub-capsule")[1].click();
  assert.equal(
    surface.querySelector(".hub-detail-body input").value,
    "away draft",
    "draft reaches the offscreen rebuild",
  );
  assert.equal(
    surface.querySelector(".hub-detail-body").textContent.includes("extra row"),
    true,
    "structure lands offscreen too",
  );
  holder.extra = false;
  handlers["settings-changed"]({ voiceEnabled: false });
  surface.querySelector(".hub-back").click();
  pass("away");

  // 13. Keyboard: Escape returns home.
  surface.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(surface.querySelectorAll(".hub-tile").length, 9, "escape returns home");
  pass("escape");

  // 14. History reentry refreshes the cached detail with new receipts.
  const entry = [
    {
      route: "answer", mode: "shadow", confidence: 0.9, latencyMs: 300,
      fallbackReason: null, atMs: 1760092800000,
    },
  ];
  jevHistoryImpl = () => Promise.resolve(entry);
  surface.querySelectorAll(".hub-tile")[0].click();
  surface.querySelector(".hub-back").click();
  surface.querySelectorAll(".hub-tile")[2].click();
  await tick();
  assert.ok(
    surface.textContent.includes(registry.jev.formatJevReceipt(entry[0])),
    "new receipts appear on reentry",
  );
  jevHistoryImpl = () => Promise.resolve([]);
  surface.querySelector(".hub-back").click();
  pass("reentry");

  // 15. Listener and node stability across navigation.
  const docCountsBefore = doc._counts();
  const kidsBefore = root.children.length;
  for (let i = 0; i < 12; i += 1) {
    surface.querySelectorAll(".hub-tile")[i % 9].click();
    surface.querySelector(".hub-back").click();
  }
  assert.deepEqual(doc._counts(), docCountsBefore, "no document listeners accumulate");
  assert.equal(root.children.length, kidsBefore, "no nodes accumulate");
  pass("cleanup");

  // 16. History: loading, empty, null, error with retry, list and clear.
  const Hist = registry.history;
  jevHistoryImpl = () => new Promise(() => {});
  const h1 = Hist.historySection();
  assert.match(h1.textContent, /Loading routing history/, "loading state");
  jevHistoryImpl = () => Promise.resolve([]);
  const h2 = Hist.historySection();
  await tick();
  assert.match(h2.textContent, /No routing decisions yet/, "truthful empty state");
  assert.match(h2.textContent, /no saved conversation list/i, "no invented conversation history");
  assert.equal(counts.jevClearHistory, 0, "nothing cleared by rendering");
  jevHistoryImpl = () => Promise.reject(new Error("boom"));
  const h3 = Hist.historySection();
  await tick();
  assert.match(h3.textContent, /unavailable/, "failure state");
  const retry = h3.querySelectorAll("button").find((b) => b.textContent === "Retry");
  assert.ok(retry, "retry offered");
  jevHistoryImpl = () => Promise.resolve([]);
  retry.click();
  await tick();
  assert.match(h3.textContent, /No routing decisions yet/, "retry recovers");
  const receipts = [
    { route: "answer", mode: "shadow", confidence: 0.91, latencyMs: 412, fallbackReason: null, atMs: 1760092800000 },
    { route: "options", mode: "shadow", confidence: 0.83, latencyMs: 388, fallbackReason: null, atMs: 1760089200000 },
  ];
  cleared = false;
  jevHistoryImpl = () => Promise.resolve(cleared ? [] : receipts);
  const h4 = Hist.historySection();
  await tick();
  const J = registry.jev;
  for (const r of receipts) {
    assert.ok(
      h4.textContent.includes(J.formatJevReceipt(r)),
      `receipt renders: ${r.route}`,
    );
  }
  assert.match(h4.textContent, /2 routing decisions/, "bounded count shown");
  const clearBtn = h4.querySelectorAll("button").find((b) => b.textContent === "Clear history");
  assert.ok(clearBtn, "explicit clear control");
  assert.equal(counts.jevClearHistory, 0, "clear needs its click");
  clearBtn.click();
  await tick();
  assert.equal(counts.jevClearHistory, 1, "clear runs once on click");
  assert.match(h4.textContent, /No routing decisions yet/, "list empties after clear");
  jevHistoryImpl = () => Promise.resolve(null);
  const hNull = Hist.historySection();
  await tick();
  assert.match(hNull.textContent, /unavailable right now/, "null reads as unavailable");
  assert.ok(
    hNull.querySelectorAll("button").some((b) => b.textContent === "Retry"),
    "null offers retry",
  );
  pass("history");

  // 14. History guards overlapping refreshes: late results never restore.
  const oldie = {
    route: "answer", mode: "shadow", confidence: 0.9, latencyMs: 300,
    fallbackReason: null, atMs: 1760092800000,
  };
  let resolveFirst = null;
  let resolveSecond = null;
  jevHistoryImpl = () => new Promise((res) => {
    resolveFirst = res;
  });
  const hs = Hist.historySection();
  await tick();
  assert.match(hs.textContent, /Loading routing history/, "second refresh starts loading");
  jevHistoryImpl = () => new Promise((res) => {
    resolveSecond = res;
  });
  hs.onHubShow();
  resolveSecond([]);
  await tick();
  resolveFirst([oldie]);
  await tick();
  assert.match(hs.textContent, /No routing decisions yet/, "late result dropped");
  let resolveSlow = null;
  jevHistoryImpl = () => Promise.resolve([oldie]);
  const hc = Hist.historySection();
  await tick();
  assert.match(hc.textContent, /1 routing decision/, "entry listed");
  jevHistoryImpl = () => new Promise((res) => {
    resolveSlow = res;
  });
  hc.onHubShow();
  jevHistoryImpl = () => Promise.resolve([]);
  hc.onHubShow();
  await tick();
  assert.match(hc.textContent, /No routing decisions yet/, "newer refresh wins");
  resolveSlow([oldie]);
  await tick();
  assert.match(hc.textContent, /No routing decisions yet/, "stale refresh cannot restore");
  jevHistoryImpl = () => Promise.resolve([]);
  pass("history-order");

  // 17. Privacy: information only, no toggles.
  const p = registry.privacy.privacySection();
  assert.equal(p.querySelectorAll("button").length, 0, "no decorative controls");
  assert.match(p.textContent, /No telemetry/, "telemetry statement kept");
  assert.match(p.textContent, /Credential Manager rather than in settings files/, "storage stated plainly");
  pass("privacy");

  // 18. Reconcile preserves drafts, focus and selection; updates the rest.
  const H = registry.hub;
  const f = { text: "remote-text", pw: "remote-pw", sel: "remote-sel", on: false };
  let brainBuilds = 0;
  const builders = {};
  for (const c of H.HUB_CATEGORIES) {
    builders[c.id] = () => {
      const d = doc.createElement("div");
      d.textContent = `stub ${c.id}`;
      return d;
    };
  }
  builders.brain = () => {
    brainBuilds += 1;
    const d = doc.createElement("div");
    const inp = doc.createElement("input");
    inp.setAttribute("type", "text");
    inp.value = f.text;
    const pw = doc.createElement("input");
    pw.setAttribute("type", "password");
    pw.value = f.pw;
    const selEl = doc.createElement("select");
    selEl.value = f.sel;
    const sw = doc.createElement("button");
    sw.setAttribute("aria-pressed", f.on ? "true" : "false");
    sw.textContent = "switch";
    d.append(inp, pw, selEl, sw);
    return d;
  };
  const hub2 = H.buildSettingsHub(builders);
  hub2.el._connected = true;
  hub2.open("brain");
  const body2 = () => hub2.el.querySelector(".hub-detail-body");
  let pair = body2().querySelectorAll("input");
  let inp = pair[0];
  let pw = pair[1];
  let selBox = body2().querySelector("select");
  inp.focus();
  inp.value = "my draft";
  inp.dispatchEvent({ type: "input", target: inp, preventDefault() {} });
  pw.value = "secret draft";
  pw.dispatchEvent({ type: "input", target: pw, preventDefault() {} });
  f.sel = "patched-sel";
  const buildsAtPatch = brainBuilds;
  hub2.syncExternal();
  assert.equal(brainBuilds, buildsAtPatch + 1, "fresh values built for the patch");
  pair = body2().querySelectorAll("input");
  assert.equal(pair[0], inp, "focused input keeps its identity");
  assert.equal(pair[0].value, "my draft", "text draft survives the patch");
  assert.equal(pair[1].value, "secret draft", "password draft survives the patch");
  assert.equal(doc.activeElement, inp, "focus stays on the draft");
  assert.equal(body2().querySelector("select").value, "patched-sel", "select updates in place");
  inp.blur();
  hub2.el.dispatchEvent({ type: "focusout", target: inp, preventDefault() {} });
  await tick();
  assert.equal(brainBuilds, buildsAtPatch + 1, "nothing was deferred");
  pair = body2().querySelectorAll("input");
  inp = pair[0];
  pw = pair[1];
  selBox = body2().querySelector("select");
  assert.equal(inp.value, "my draft", "text draft survives");
  assert.equal(pw.value, "secret draft", "password draft survives");
  assert.ok(doc.activeElement !== inp, "no focus stolen after blur");

  // Focus on a switch: rebuild happens and focus follows the new control.
  let sw = body2().querySelector("button");
  sw.focus();
  f.on = true;
  f.sel = "remote-sel-2";
  hub2.syncExternal();
  assert.equal(brainBuilds, 3, "switch focus does not defer");
  sw = body2().querySelector("button");
  assert.equal(doc.activeElement, sw, "focus returns to the rebuilt switch");
  assert.equal(sw.getAttribute("aria-pressed"), "true", "switch shows remote state");
  assert.equal(body2().querySelector("select").value, "remote-sel-2", "select updates");

  // Caret and selection travel with the draft.
  pair = body2().querySelectorAll("input");
  inp = pair[0];
  inp.value = "selection draft";
  inp.dispatchEvent({ type: "input", target: inp, preventDefault() {} });
  inp.selectionStart = 3;
  inp.selectionEnd = 7;
  sw.focus();
  hub2.syncExternal();
  assert.equal(brainBuilds, 4, "rebuild with selection marked");
  pair = body2().querySelectorAll("input");
  assert.equal(pair[0].value, "selection draft", "draft kept");
  assert.equal(pair[0].selectionStart, 3, "caret start kept");
  assert.equal(pair[0].selectionEnd, 7, "caret end kept");
  assert.equal(doc.activeElement, body2().querySelector("button"), "switch keeps focus");

  // Repeated events rebuild once each without listener growth.
  const docCounts = doc._counts();
  body2().querySelector("button").focus();
  hub2.syncExternal();
  hub2.syncExternal();
  hub2.syncExternal();
  assert.equal(brainBuilds, 7, "one rebuild per event");
  assert.deepEqual(doc._counts(), docCounts, "no listeners accumulate");

  // Draft plus navigate away and back: the patch already preserved it, so no
  // extra build happens and nothing is deferred.
  pair = body2().querySelectorAll("input");
  inp = pair[0];
  inp.focus();
  inp.value = "away draft";
  inp.dispatchEvent({ type: "input", target: inp, preventDefault() {} });
  hub2.syncExternal();
  assert.equal(brainBuilds, 8, "patch runs under focus");
  hub2.open("voice");
  hub2.el.dispatchEvent({ type: "focusout", target: inp, preventDefault() {} });
  await tick();
  assert.equal(brainBuilds, 8, "nothing deferred across navigation");
  hub2.open("brain");
  pair = body2().querySelectorAll("input");
  assert.equal(pair[0].value, "away draft", "draft survives away and back");
  hub2.dispose();
  pass("reconcile");

  // 19. Mount sync, resize observation and disposal.
  const visBefore = doc._counts().visibilitychange || 0;
  const plainBuilders = {};
  for (const c of H.HUB_CATEGORIES) {
    plainBuilders[c.id] = () => {
      const d = doc.createElement("div");
      d.textContent = `plain ${c.id}`;
      return d;
    };
  }
  const hd = H.buildSettingsHub(plainBuilders);
  const edge0 = hd.el.querySelector(".hub-edge button");
  assert.equal(
    edge0.getAttribute("aria-label"), "More settings", "unmounted chevron stays neutral",
  );
  doc.hidden = true;
  const hdHidden = H.buildSettingsHub(plainBuilders);
  assert.ok(
    doc.documentElement.classList.contains("sculptures-paused"), "hidden start pauses",
  );
  doc.hidden = false;
  doc._dispatch({ type: "visibilitychange" });
  assert.ok(
    !doc.documentElement.classList.contains("sculptures-paused"), "visible resumes",
  );
  hdHidden.dispose();
  assert.equal(
    doc._counts().visibilitychange || 0, visBefore + 1, "one listener per mounted hub",
  );
  const roInstances = [];
  let roDisconnected = 0;
  ctx.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      roInstances.push(this);
    }
    observe() {}
    disconnect() {
      roDisconnected += 1;
    }
  };
  const rafQueue = [];
  ctx.requestAnimationFrame = (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  };
  ctx.cancelAnimationFrame = (id) => {
    rafQueue[id - 1] = null;
  };
  const hd3 = H.buildSettingsHub(plainBuilders);
  assert.ok(roInstances.length >= 1, "rail observed for resize");
  hd3.el._connected = true;
  const rail3 = hd3.el.querySelector(".hub-more");
  rail3.scrollWidth = 600;
  rail3.clientWidth = 200;
  roInstances[roInstances.length - 1].cb();
  assert.equal(
    hd3.el.querySelector(".hub-edge button").getAttribute("aria-label"),
    "More settings",
    "resize syncs the chevron",
  );
  rail3.scrollLeft = 400;
  roInstances[roInstances.length - 1].cb();
  assert.equal(
    hd3.el.querySelector(".hub-edge button").getAttribute("aria-label"),
    "Back to first settings",
    "resize detects the end",
  );
  const roAtOpen = roDisconnected;
  hd3.open("voice");
  assert.ok(rafQueue.length >= 1, "scroll restore waits for layout");
  assert.ok(roDisconnected > roAtOpen, "detail tears down rail observation");
  const hd4 = H.buildSettingsHub(plainBuilders);
  const roAtDispose = roDisconnected;
  hd4.dispose();
  assert.ok(roDisconnected > roAtDispose, "observer disconnected on dispose");
  hd3.dispose();
  assert.equal(rafQueue.filter(Boolean).length, 0, "pending layout work cancelled");
  assert.equal(
    doc._counts().visibilitychange || 0, visBefore + 1, "dispose removes its listener",
  );
  hd3.open("voice");
  hd3.syncExternal();
  assert.equal(
    doc._counts().visibilitychange || 0, visBefore + 1, "post-dispose calls are inert",
  );
  delete ctx.ResizeObserver;
  delete ctx.requestAnimationFrame;
  delete ctx.cancelAnimationFrame;
  hd.dispose();
  pass("dispose");

  async function bootFixtureHarness(search) {
    const { doc: fdoc } = createDocument();
    const froot = fdoc.createElement("div");
    froot.setAttribute("id", "settings-root");
    fdoc._root = froot;
    const fhandlers = {};
    const fcounts = { saveSettings: 0, secretSet: 0, secretClear: 0 };
    const fbridge = {
      Bridge: {
        boot: () => Promise.resolve(null),
        saveSettings: () => {
          fcounts.saveSettings += 1;
          return Promise.resolve();
        },
        hooksStatus: () => Promise.resolve({
          installed: false, settingsPath: "", hookPath: "", hookReady: false,
        }),
        codexStatus: () => Promise.resolve({
          installed: false, settingsPath: "", hookPath: "", hookReady: false,
        }),
        secretPresent: () => Promise.resolve(false),
        secretSet: () => {
          fcounts.secretSet += 1;
          return Promise.resolve();
        },
        secretClear: () => {
          fcounts.secretClear += 1;
          return Promise.resolve();
        },
        jevHistory: () => Promise.resolve([]),
        jevClearHistory: () => Promise.resolve(),
      },
      IS_TAURI: false,
      onEvent: (name, fn) => {
        fhandlers[name] = fn;
        return () => {};
      },
    };
    const fwindow = {
      location: { search },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const fcalls = {};
    const fstub = (name) => () => {
      fcalls[name] = (fcalls[name] || 0) + 1;
      const el = fdoc.createElement("section");
      el.setAttribute("data-stub", name);
      return el;
    };
    const fctx = vm.createContext({
      document: fdoc,
      window: fwindow,
      console,
      URLSearchParams,
      Date,
      Promise,
      Set,
      Map,
      HTMLElement: El,
      SVGElement: El,
      Node: El,
      Event: MiniEvent,
    });
    const fcache = {};
    const fload = (relNoExt) => {
      if (fcache[relNoExt]) return fcache[relNoExt];
      const rel = `${relNoExt}.ts`;
      const file = compile(rel, tmp);
      const code = fs.readFileSync(file, "utf8");
      const mod = { exports: {} };
      const req = (spec) => {
        if (spec.endsWith(".css")) return {};
        const resolved = resolveRel(relNoExt, spec);
        if (resolved === "src/views/dom") return fload("src/views/dom");
        if (resolved === "src/settings/hub") return fload("src/settings/hub");
        if (resolved === "src/settings/historySection") {
          return fload("src/settings/historySection");
        }
        if (resolved === "src/settings/privacySection") {
          return fload("src/settings/privacySection");
        }
        if (resolved === "src/choom/jev") return fload("src/choom/jev");
        if (resolved === "src/core/bridge") return fbridge;
        if (resolved === "src/core/state") {
          return { DEFAULT_SETTINGS: { activeIntegrations: [], tools: {} } };
        }
        if (resolved === "src/choom/chatSection") return { chatSection: fstub("chat") };
        if (resolved === "src/choom/voiceSection") {
          return { voiceSettingsSection: fstub("voice"), jevSettingsSection: fstub("jev") };
        }
        if (resolved === "src/choom/musicSection") return { musicSection: fstub("music") };
        if (resolved === "src/choom/wakeSection") return { wakeSection: fstub("wake") };
        if (resolved === "src/choom/quickAdditionsSection") {
          return { quickAdditionsSettingsSection: fstub("quick") };
        }
        if (resolved === "src/choom/opencodeSection") {
          return { opencodeSection: fstub("opencode") };
        }
        throw new Error(`unexpected fixture require: ${spec}`);
      };
      new vm.Script(
        `(function(exports, module, require){${code}})`,
        { filename: rel },
      ).runInContext(fctx)(mod.exports, mod, req);
      fcache[relNoExt] = mod.exports;
      return mod.exports;
    };
    fload("src/settings/main");
    await tick();
    return {
      doc: fdoc, root: froot, handlers: fhandlers,
      counts: fcounts, calls: fcalls, bridge: fbridge,
    };
  }

  // 20. Disposal drops late settings events safely. Last: main hub is gone.
  surface.querySelectorAll(".hub-tile")[1].click();
  const chatAt = calls.chat;
  windowStub._dispatch({ type: "pagehide" });
  await tick();
  handlers["settings-changed"]({ voiceEnabled: true });
  await tick();
  assert.equal(calls.chat, chatAt, "late event after disposal is dropped");
  windowStub._dispatch({ type: "pagehide" });
  await tick();
  pass("pagehide");

  // 21. Fixture event bench drives fictional updates with no native writes.
  const fx = await bootFixtureHarness("?fixture=settings-hub&bench=events");
  assert.equal(fx.bridge.IS_TAURI, false, "bench never runs native");
  const fxHub = fx.root.children[fx.root.children.length - 1];
  assert.ok(fxHub.classList.contains("hub-surface"), "fixture hub mounts");
  assert.match(fx.root.textContent, /Fixture preview with fictional data/, "banner shown");
  const labBtns = fx.root.querySelectorAll("button").filter(
    (b) => (b.textContent || "").startsWith("Simulate"),
  );
  assert.equal(labBtns.length, 3, "three fictional event buttons");
  fxHub.querySelectorAll(".hub-tile")[0].click();
  const fxVoiceBefore = fx.calls.voice;
  labBtns[0].click();
  await tick();
  assert.equal(fx.calls.voice, fxVoiceBefore + 1, "fictional event reconciles");
  assert.equal(fx.counts.saveSettings, 0, "no settings writes");
  assert.equal(fx.counts.secretSet, 0, "no credential writes");
  assert.equal(fx.counts.secretClear, 0, "no credential clears");
  assert.match(fx.root.textContent, /Applied fictional voice off/, "bench confirms");
  fx.root.querySelectorAll("button").find(
    (b) => b.textContent === "Record fictional receipt",
  ).click();
  fxHub.querySelector(".hub-back").click();
  fxHub.querySelectorAll(".hub-tile")[2].click();
  await tick();
  assert.match(fxHub.textContent, /4 routing decisions/, "fictional receipt listed");
  pass("bench");

  // 22. Plain fixture has no bench; reduced view is labelled and classed.
  const fxPlain = await bootFixtureHarness("?fixture=settings-hub");
  assert.equal(
    fxPlain.root.querySelectorAll("button").filter(
      (b) => (b.textContent || "").startsWith("Simulate"),
    ).length,
    0,
    "no bench on the normal fixture URL",
  );
  const fxMotion = await bootFixtureHarness("?fixture=settings-hub&motion=reduced");
  assert.ok(
    fxMotion.root.classList.contains("fixture-reduced"), "reduced class applied",
  );
  assert.match(fxMotion.root.textContent, /Reduced motion preview/, "reduced labelled");
  pass("fixture-views");

  // Save callbacks must retain the live draft after a remote refresh.
  let savedDraft = null;
  builders.brain = () => {
    const panel = doc.createElement("div");
    const key = doc.createElement("input");
    key.setAttribute("type", "password");
    key.value = "";
    const save = doc.createElement("button");
    save.textContent = "Save key";
    save.addEventListener("click", () => { savedDraft = key.value; });
    panel.append(key, save);
    return panel;
  };
  const hub3 = H.buildSettingsHub(builders);
  hub3.el._connected = true;
  hub3.open("brain");
  const draft = hub3.el.querySelector("input");
  draft.focus();
  draft.value = "fixture-draft";
  draft.dispatchEvent({ type: "input", target: draft, preventDefault() {} });
  hub3.syncExternal();
  hub3.el.querySelector(".hub-detail-body").querySelector("button").click();
  assert.equal(savedDraft, "fixture-draft", "Save reads the preserved live draft");
  hub3.dispose();
  pass("live-save-binding");

  console.log(`PASS: ${passed} settings-hub regression groups`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
