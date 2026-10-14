// Inline Settings hub regression: the production hub mounted inside the
// actual island fixture (settingsInline host + inlineHub), not standalone
// settings.html alone. Run from windows/:
// node scripts/inline-settings-regression.cjs
//
// Behavioral tests through a minimal DOM stub: island routing (home/category),
// real save paths, draft preservation across remote refresh, back/paging,
// repeated open/close listener cleanup, narrow 400px and normal 560px widths,
// bounded island height, scoped CSS and no second native window.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
// Any other source module loads for real (upstream's i18n, pills, wardrobe...);
// the explicit stubs above it in each loader still win.
const isPureUpstream = (rel) => fs.existsSync(path.join(ROOT, `${rel}.ts`));

// ── Minimal DOM stub (same shape as settings-hub-regression) ────────────────

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
    this.scrollHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.title = "";
    this.placeholder = "";
    this.hidden = false;
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
  get firstElementChild() {
    return this.children.find((c) => !c.tagName.startsWith("#")) ?? null;
  }
  get type() {
    if (this.tagName !== "INPUT") return this.attributes.type ?? "";
    return this.attributes.type ?? "text";
  }
  set type(v) {
    this.setAttribute("type", String(v));
  }
  get isConnected() {
    let at = this;
    while (at) {
      if (at._rootFlag) return true;
      at = at.parentNode;
    }
    return false;
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

const tick = (n = 10) => new Promise((resolve) => {
  const step = (i) => (i <= 0 ? resolve() : setImmediate(() => step(i - 1)));
  step(n);
});

class MiniEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = init.target ?? null;
    Object.assign(this, init);
  }
  preventDefault() {}
  stopPropagation() {
    this.bubbles = false;
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-inline-test-"));
  let passed = 0;
  const pass = (name) => {
    passed += 1;
    console.log(`PASS: ${name}`);
  };

  // Shared island-fixture document: the host mounts like a real island view.
  const docListeners = {};
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
    addEventListener: (t, fn) => {
      (docListeners[t] ||= []).push(fn);
    },
    removeEventListener: (t, fn) => {
      docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn);
    },
  };
  doc.documentElement = new El("html", doc);
  const docCounts = () => Object.fromEntries(
    Object.entries(docListeners).map(([k, v]) => [k, v.length]),
  );

  const rafQueue = [];
  const windowStub = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    dispatchEvent: () => true,
  };

  // Bridge stub with write and listener accounting.
  const handlers = {};
  let subCount = 0;
  let unsubCount = 0;
  const counts = { saveSettings: 0, secretSet: 0, secretClear: 0 };
  const bridgeStub = {
    Bridge: {
      boot: () => Promise.resolve({ settings: {}, version: "9.9-test" }),
      saveSettings: () => {
        counts.saveSettings += 1;
        return Promise.resolve();
      },
      hooksStatus: () => Promise.resolve({
        installed: false, settingsPath: "C:\\test\\settings.json",
        hookPath: "C:\\test\\coucou-hook.exe", hookReady: false,
      }),
      codexStatus: () => Promise.resolve({
        installed: false, settingsPath: "C:\\test\\hooks.json",
        hookPath: "C:\\test\\coucou-hook.exe", hookReady: false,
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
      hooksPreview: () => Promise.reject(new Error("stub has no hook files")),
      codexPreview: () => Promise.reject(new Error("stub has no hook files")),
      opencodeAgentStatus: () => Promise.resolve({ reachable: false, version: null, error: null }),
      opencodeAgentModels: () => Promise.resolve([]),
      opencodePluginStatus: () => Promise.resolve({ installed: false, outdated: false, path: "" }),
      opencodePluginInstall: () => Promise.reject(new Error("stub cannot write files")),
      opencodePluginRemove: () => Promise.reject(new Error("stub cannot write files")),
      voiceCapability: () => Promise.resolve({ supported: true, recognizers: [], voices: [], microphone: true, error: null }),
      voiceWhisperStatus: () => Promise.resolve({ binary: false, base: false, small: false, error: null }),
      voiceMemoryList: () => Promise.resolve([]),
      voiceWakeSet: () => Promise.resolve(),
      voiceMute: () => Promise.resolve(),
      jevStatus: () => Promise.resolve({
        enabled: false, mode: "shadow", configured: false, model: "jev-test",
        endpoint: "https://example.invalid", threshold: 0.75, deadlineMs: 2500,
      }),
      jevHistory: () => Promise.resolve([]),
      jevClearHistory: () => Promise.resolve(),
      notificationsStatus: () => Promise.resolve({ state: "disabled", listening: false, detail: null }),
      notificationsRecent: () => Promise.resolve([]),
    },
    IS_TAURI: false,
    onEvent: (name, fn) => {
      subCount += 1;
      (handlers[name] ||= []).push(fn);
      let off = false;
      return Promise.resolve(() => {
        if (off) return;
        off = true;
        unsubCount += 1;
        handlers[name] = (handlers[name] || []).filter((f) => f !== fn);
      });
    },
  };

  const ctx = vm.createContext({
    document: doc,
    window: windowStub,
    console,
    URLSearchParams,
    Date,
    Promise,
    Set,
    Map,
    performance,
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor(fn) {
        this.fn = fn;
      }
      observe() {}
      disconnect() {}
    },
    HTMLElement: El,
    SVGElement: El,
    Node: El,
    Event: MiniEvent,
  });

  const stubCalls = {};
  function sectionStub(name) {
    return () => {
      stubCalls[name] = (stubCalls[name] || 0) + 1;
      const el = doc.createElement("section");
      el.setAttribute("data-stub", name);
      const b = doc.createElement("b");
      b.textContent = name;
      el.append(b);
      return el;
    };
  }

  const cache = {};
  function load(relNoExt) {
    if (cache[relNoExt]) return cache[relNoExt];
    const rel = `${relNoExt}.ts`;
    const file = compile(rel, tmp);
    const code = fs.readFileSync(file, "utf8");
    const mod = { exports: {} };
    const requireFn = (spec) => {
      if (spec.endsWith(".css")) return {};
      const resolved = resolveRel(relNoExt, spec);
      if (resolved === "src/views/dom") return load("src/views/dom");
      if (resolved === "src/core/layout") return load("src/core/layout");
      if (resolved === "src/core/state") return load("src/core/state");
      if (resolved === "src/core/bridge") return bridgeStub;
      if (resolved === "src/settings/hub") return load("src/settings/hub");
      if (resolved === "src/settings/sharedSections") return load("src/settings/sharedSections");
      if (resolved === "src/settings/historySection") return load("src/settings/historySection");
      if (resolved === "src/settings/privacySection") return load("src/settings/privacySection");
      if (resolved === "src/settings/inlineHub") return load("src/settings/inlineHub");
      if (resolved === "src/island/fsm") return load("src/island/fsm");
      if (resolved === "src/choom/jev") return load("src/choom/jev");
      if (resolved === "src/choom/chatSection") return { chatSection: sectionStub("chat") };
      if (resolved === "src/choom/voiceSection") {
        return { voiceSettingsSection: sectionStub("voice"), jevSettingsSection: sectionStub("jev") };
      }
      if (resolved === "src/choom/musicSection") return { musicSection: sectionStub("music") };
      if (resolved === "src/choom/wakeSection") return { wakeSection: sectionStub("wake") };
      if (resolved === "src/choom/notificationsSection") {
        return { notificationsSettingsSection: sectionStub("notifications") };
      }
      if (resolved === "src/choom/quickAdditionsSection") {
        return { quickAdditionsSettingsSection: sectionStub("quick") };
      }
      if (resolved === "src/choom/opencodeSection") return { opencodeSection: sectionStub("opencode") };
      if (spec.endsWith(".json")) {
        return { __esModule: true, default: JSON.parse(fs.readFileSync(path.join(ROOT, resolved), "utf8")) };
      }
      if (isPureUpstream(resolved)) return load(resolved);
      throw new Error(`unexpected require: ${spec} (from ${relNoExt})`);
    };
    new vm.Script(
      `(function(exports, module, require){${code}})`,
      { filename: rel },
    ).runInContext(ctx)(mod.exports, mod, requireFn);
    cache[relNoExt] = mod.exports;
    return mod.exports;
  }

  const flushRaf = () => {
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn();
  };

  const settingsInline = load("src/views/settingsInline");
  const islandRoot = doc.createElement("div");
  islandRoot._rootFlag = true;

  // The island owns one host; the view toggles .on like the real island sync.
  let host = settingsInline.buildSettingsInline(() => {});
  islandRoot.append(host.el);
  const showView = () => {
    host.el.classList.add("on");
    host.sync();
  };

  // 1. Island home: nine tiles, heading lead, no separate-window chrome.
  showView();
  await tick();
  flushRaf();
  await tick();
  const mount = host.el.querySelector(".island-settings");
  assert.ok(mount, "hub mounts inside the island fixture");
  const surface = mount.querySelector(".hub-surface");
  assert.ok(surface, "production hub surface mounts inline");
  surface._rootFlag = true;
  assert.equal(surface.querySelectorAll(".hub-tile").length, 9, "nine tiles inline");
  assert.ok(surface.querySelector(".hub-lead"), "heading leads beside priority tiles");
  assert.equal(host.el.querySelector("h1"), null, "no duplicate version heading");
  assert.ok(!mount.textContent.includes("0.0.0"), "no version header inline");
  pass("island home mounts without window chrome");

  // 2. Navigation: tile opens its control room in place; capsules switch.
  const voiceTile = surface.querySelectorAll(".hub-tile")
    .find((t) => (t.getAttribute("aria-label") || "").startsWith("Voice:"));
  voiceTile.click();
  await tick();
  assert.equal(surface.querySelector(".hub-focus-head h2").textContent, "Voice", "voice room opens");
  assert.equal(surface.querySelectorAll(".hub-capsule").length, 9, "capsules cover every category");
  const caps = surface.querySelectorAll(".hub-capsule");
  caps[caps.length - 1].click();
  await tick();
  assert.equal(surface.querySelector(".hub-focus-head h2").textContent, "Privacy", "capsule switches rooms");
  assert.equal(doc.activeElement.tagName, "H2", "focus moves to the room heading");
  pass("navigation takes over the content");

  // 3. Back: chevron and one Escape return to the hub home WITHOUT reaching
  // the host collapse handler. A window-level keydown listener stands in for
  // the island's own Escape-to-collapse: a single press must never both go
  // home and collapse the island.
  surface.querySelector(".hub-back").click();
  await tick();
  assert.equal(surface.querySelectorAll(".hub-tile").length, 9, "back chevron returns home");
  let collapsed = 0;
  islandRoot.addEventListener("keydown", (e) => {
    if (e.key === "Escape") collapsed += 1;
  });
  voiceTile.click();
  await tick();
  const escTarget = surface.querySelector(".hub-focus-head h2");
  surface.dispatchEvent(new MiniEvent("keydown", { key: "Escape", target: escTarget, bubbles: true }));
  await tick();
  assert.equal(surface.querySelectorAll(".hub-tile").length, 9, "Escape returns home");
  assert.equal(collapsed, 0, "one Escape never reaches the host collapse handler");
  pass("back and single Escape restore hub home");

  // 4. Real save path: Appearance uses the production General section.
  const appearanceTile = surface.querySelectorAll(".hub-tile")
    .find((t) => (t.getAttribute("aria-label") || "").startsWith("Appearance:"));
  appearanceTile.click();
  await tick();
  const before = counts.saveSettings;
  const sw = surface.querySelector(".hub-detail-body .switch");
  assert.ok(sw, "production sound switch present inline");
  sw.click();
  await tick();
  assert.ok(counts.saveSettings > before, "explicit toggle writes through Bridge");
  sw.click();
  await tick();
  pass("inline save writes through the existing path");

  // 5. Remote refresh preserves typed drafts with caret.
  const connTile = surface.querySelectorAll(".hub-tile")
    .find((t) => (t.getAttribute("aria-label") || "").startsWith("Connections:"));
  (connTile ?? surface.querySelectorAll(".hub-capsule")[7]).click();
  await tick();
  const keyField = surface.querySelectorAll(".hub-detail-body input")
    .find((i) => i.getAttribute("type") === "password");
  assert.ok(keyField, "production credential field present inline");
  keyField.value = "sk-test-draft";
  keyField.focus();
  try {
    keyField.setSelectionRange(4, 4);
  } catch { /* best effort */ }
  keyField.dispatchEvent({ type: "input", target: keyField, bubbles: true });
  for (const fn of handlers["settings-changed"] || []) {
    fn({ soundEnabled: false });
  }
  await tick();
  flushRaf();
  await tick();
  assert.equal(keyField.value, "sk-test-draft", "typed draft survives remote refresh");
  assert.equal(doc.activeElement, keyField, "focus stays in the draft field");
  pass("drafts survive remote refresh with focus");

  // 6. Paging: the rail pages a full screen and wraps at the end.
  host.showHome();
  await tick();
  flushRaf();
  const rail = surface.querySelector(".hub-more");
  const edge = surface.querySelector(".hub-edge button");
  assert.ok(rail && edge, "rail and edge chevron present inline");
  rail.clientWidth = 480;
  rail.scrollWidth = 1200;
  rail.scrollLeft = 0;
  rail.dispatchEvent({ type: "scroll", target: rail, bubbles: false });
  await tick();
  flushRaf();
  assert.equal(edge.getAttribute("aria-label"), "More settings", "chevron offers more");
  edge.click();
  assert.ok(rail.scrollLeft > 0, "chevron pages the rail");
  rail.scrollLeft = 1199;
  rail.dispatchEvent({ type: "scroll", target: rail, bubbles: false });
  await tick();
  assert.equal(edge.getAttribute("aria-label"), "Back to first settings", "chevron mirrors at the end");
  edge.click();
  assert.equal(rail.scrollLeft, 0, "paging wraps back to the start");
  pass("paging pages and wraps");

  // 7. Widths: narrow 400px and normal 560px stay reachable with no clipping.
  for (const w of [400, 560]) {
    rail.clientWidth = w;
    rail.scrollLeft = 0;
    rail.dispatchEvent({ type: "scroll", target: rail, bubbles: false });
    await tick();
    flushRaf();
    assert.equal(surface.querySelectorAll(".hub-tile").length, 9, `nine tiles at ${w}px`);
    edge.click();
    assert.ok(true, `paging runs at ${w}px`);
  }
  pass("narrow and normal widths stay reachable");

  // 8. Bounded island height: content-driven, never oversized or clipped.
  const homeH = settingsInline.settingsInlineHeight();
  assert.ok(homeH >= 232 && homeH <= 320, `home height bounded, got ${homeH}`);
  voiceTile.click();
  await tick();
  flushRaf();
  const detailH = settingsInline.settingsInlineHeight();
  assert.ok(detailH >= 232 && detailH <= 320, `detail height bounded, got ${detailH}`);
  const body = surface.querySelector(".hub-detail-body");
  assert.ok(body, "detail scrolls in a bounded body");
  pass("content-driven bounded height");

  // 9. Repeated open/close: listeners balance, no leaks, hub remounts.
  const subsBefore = subCount;
  const unsubsBefore = unsubCount;
  const visBefore = docCounts().visibilitychange || 0;
  for (let i = 0; i < 3; i += 1) {
    host.disposeInline();
    await tick();
    settingsInline.__resetSettingsInlineForTests();
    host = settingsInline.buildSettingsInline(() => {});
    islandRoot.append(host.el);
    showView();
    await tick();
    flushRaf();
  }
  await tick();
  assert.equal(
    subCount - subsBefore, unsubCount - unsubsBefore,
    "every subscription is released on dispose",
  );
  assert.equal(
    docCounts().visibilitychange || 0, visBefore,
    "one visibility listener for the mounted hub",
  );
  const fresh = host.el.querySelector(".island-settings .hub-surface");
  assert.ok(fresh && fresh.querySelectorAll(".hub-tile").length === 9, "hub remounts clean");
  host.disposeInline();
  await tick();
  assert.equal(docCounts().visibilitychange || 0, visBefore - 1, "dispose releases document listeners");
  settingsInline.__resetSettingsInlineForTests();
  host = settingsInline.buildSettingsInline(() => {});
  islandRoot.append(host.el);
  showView();
  await tick();
  flushRaf();
  pass("repeated open/close cleans listeners");

  // 10. Scoped CSS: every inline rule stays under .island-settings, and every
  // button rule is either a detail control (.hub-detail-body) or hub chrome
  // (.hub-tile/.hub-capsule/.hub-back/.hub-edge), so control styling can never
  // restyle the approved tiles into gray pills again.
  const css = fs.readFileSync(path.join(ROOT, "src/settings/inlineHub.css"), "utf8");
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of noComments.split("\n")) {
    if (!line.includes("{")) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) continue;
    assert.ok(
      trimmed.includes(".island-settings"),
      `scoped rule: ${trimmed.slice(0, 80)}`,
    );
    if (/button/.test(trimmed)) {
      assert.ok(
        trimmed.includes(".hub-detail-body") ||
        trimmed.includes(".hub-tile") ||
        trimmed.includes(".hub-capsule") ||
        trimmed.includes(".hub-back") ||
        trimmed.includes(".hub-edge"),
        `button rule stays off hub chrome: ${trimmed.slice(0, 80)}`,
      );
    }
  }
  for (const bad of ["#settings-root", "body.settings-window", "scrollbar-width: none; } *"]) {
    assert.ok(!noComments.includes(bad) || bad.startsWith("scrollbar"), `no leak: ${bad}`);
  }
  assert.ok(!/(^|\n)\s*\*\s*\{/.test(noComments), "no global reset in inline CSS");
  assert.ok(!/(^|\n)\s*section\s*\{/.test(noComments), "no bare section rule");
  assert.ok(!/(^|\n)\s*button\s*\{/.test(noComments), "no bare button rule");
  pass("CSS stays scoped to the inline hub");

  // 11. No second native window: inline sources never open one.
  for (const rel of ["src/settings/inlineHub.ts", "src/views/settingsInline.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!src.includes("openSettingsWindow"), `${rel} never opens a window`);
    assert.ok(!src.includes("<iframe") && !src.includes('"iframe"'), `${rel} never embeds an iframe`);
    assert.ok(!src.includes("settings.html"), `${rel} never loads the window page`);
  }
  const islandSrc = fs.readFileSync(path.join(ROOT, "src/island/island.ts"), "utf8");
  assert.ok(
    islandSrc.includes("openSettingsWindow: () => this.showSettingsHome()"),
    "island routes the window call inline",
  );
  assert.ok(!islandSrc.includes("Bridge.openSettingsWindow"), "island makes no window call");
  const traySrc = fs.readFileSync(
    path.join(ROOT, "src-tauri/src/tray.rs"), "utf8",
  );
  assert.ok(traySrc.includes('"tray", "settings"'), "tray reaches the inline route");
  const libSrc = fs.readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.ok(
    libSrc.includes('"tray", "settings".to_string()'),
    "native command routes to the island",
  );
  // The voice deep link must survive: no native echo may reset its category.
  const voiceSrc = fs.readFileSync(path.join(ROOT, "src/choom/voiceSection.ts"), "utf8");
  assert.ok(!voiceSrc.includes("Bridge.openSettingsWindow"), "voice path carries no window echo");
  pass("no second native window");

  // 12. Category validation: known rooms pass, anything else falls home.
  const hubMod = load("src/settings/hub");
  assert.equal(hubMod.parseHubCategory("voice"), "voice", "voice resolves");
  assert.equal(hubMod.parseHubCategory("connections"), "connections", "connections resolves");
  for (const c of hubMod.HUB_CATEGORIES) {
    assert.equal(hubMod.parseHubCategory(c.id), c.id, `${c.id} resolves`);
  }
  for (const bad of ["Voice", "VOICE", " voice", "voice ", "", "settingz", null, undefined, 42, {}, []]) {
    assert.equal(hubMod.parseHubCategory(bad), null, `unknown rejected: ${String(bad)}`);
  }
  pass("category ids validate with home fallback");

  // 13. Settings routes reset the FSM: hidden lands home, armed hide and
  // greet timers are cancelled instead of firing under an open Settings view.
  const fsmMod = load("src/island/fsm");
  const route = new fsmMod.IslandStateMachine();
  const seen = [];
  route.onTransition = (from, to) => seen.push([from, to]);
  route.forceHome();
  assert.equal(route.state, "home", "hidden route lands home");
  assert.deepEqual(seen, [["hidden", "home"]], "hidden to home transition fires");
  const armed = new fsmMod.IslandStateMachine();
  armed.petitToHiddenDelay = 0.06;
  armed.homeToPetitDelay = 30;
  armed.mouseEntered();
  assert.equal(armed.state, "petit", "compact before the route");
  armed.mouseLeft();
  armed.forceHome();
  const greeted = new fsmMod.IslandStateMachine();
  greeted.greetAutoCollapseDelay = 0.06;
  greeted.greetHoverCollapseDelay = 30;
  greeted.launch();
  greeted.greetComplete();
  greeted.forceHome();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(armed.state, "home", "armed hide timer cancelled by the route");
  assert.equal(greeted.state, "home", "armed greet timer cancelled by the route");
  pass("settings routes reset stale FSM timers");

  console.log(`PASS: ${passed} inline-settings regression groups`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
