// Voice outlooks regression: ribbon default, task instance, confirm first,
// draft retention, accessible controls, slot timer disposal and view pins
// living in Voice settings.
// Run from windows/: node scripts/voice-outlooks-regression.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");

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

// Minimal DOM shim: just enough for the real buildVoiceView to mount,
// sync, hide and dispose in plain node. No new dependencies.
function installDomShim() {
  function makeClasses(self) {
    return {
      add(...names) { for (const n of names) self._classes.add(n); },
      remove(...names) { for (const n of names) self._classes.delete(n); },
      toggle(n, force) {
        if (force === undefined) {
          if (self._classes.has(n)) { self._classes.delete(n); return false; }
          self._classes.add(n);
          return true;
        }
        if (force) self._classes.add(n);
        else self._classes.delete(n);
        return force;
      },
      contains(n) { return self._classes.has(n); },
    };
  }
  function markConnected(el, on) {
    if (!el || !el.children) return;
    el._connected = on;
    for (const c of el.children) markConnected(c, on);
  }
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this._connected = false;
      this._classes = new Set();
      this.classList = makeClasses(this);
      Object.defineProperty(this, "className", {
        get: () => [...this._classes].join(" "),
        set: (v) => { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
      });
      this.dataset = {};
      this.style = { setProperty: (k, v) => { this.style[k] = v; } };
      this.attributes = {};
      this.listeners = {};
      this.textContent = "";
      this.id = "";
      this.offsetWidth = 0;
    }
    get isConnected() { return this._connected; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) {
      const l = this.listeners[t];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    }
    append(...kids) { for (const k of kids) this.appendChild(k); }
    appendChild(k) {
      if (!k || typeof k.appendChild !== "function") {
        this.children.push(k);
        return k;
      }
      k.parentNode = this;
      this.children.push(k);
      if (this._connected) markConnected(k, true);
      return k;
    }
    removeChild(k) {
      const i = this.children.indexOf(k);
      if (i >= 0) this.children.splice(i, 1);
      if (k && typeof k === "object") { k.parentNode = null; markConnected(k, false); }
      return k;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.children.length > 0 ? this.children[0] : null; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest(sel) {
      if (sel !== "#island") return null;
      let n = this.parentNode;
      while (n) { if (n.id === "island") return n; n = n.parentNode; }
      return null;
    }
    matches() { return false; }
    focus() {}
  }
  const docListeners = {};
  const doc = {
    hidden: false,
    body: new FakeEl("body"),
    createElement: (t) => new FakeEl(t),
    createElementNS: (_ns, t) => new FakeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const l = docListeners[t];
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    },
  };
  doc.body._connected = true;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Map();
  const win = {
    setTimeout: (cb, ms, ...rest) => {
      const id = realSetTimeout(cb, ms, ...rest);
      activeTimers.set(id, cb);
      return id;
    },
    clearTimeout: (id) => { activeTimers.delete(id); return realClearTimeout(id); },
    matchMedia: () => ({ matches: false }),
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = doc;
  globalThis.window = win;
  return {
    doc,
    docListeners,
    activeTimers,
    restore() {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
      if (prevWin === undefined) delete globalThis.window;
      else globalThis.window = prevWin;
    },
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-voice-outlooks-"));
  const origLoad = Module._load;
  let shim = null;
  let patchedVoice = null;
  let patchedState = null;
  try {
    compile("src/choom/voice.ts", tmp);
    const V = require(path.join(tmp, "src/choom/voice.js"));
    const { Voice } = V;

    // Mode changes: manual pin wins, Auto defaults to the ribbon.
    assert.equal(V.resolveDeckMode("b", 0, false, false), "b");
    assert.equal(V.resolveDeckMode("c", 5, false, false), "c");
    assert.equal(V.resolveDeckMode("a", 5, true, true), "a");
    assert.equal(V.resolveDeckMode("auto", 0, false, false), "a");
    // B is manual only: many lines never auto expand.
    assert.equal(V.resolveDeckMode("auto", 8, false, false), "a");
    // C only for context or actionable work.
    assert.equal(V.resolveDeckMode("auto", 0, true, false), "c");
    assert.equal(V.resolveDeckMode("auto", 0, false, true), "c");
    assert.equal(V.validDeckMode("auto"), true);
    assert.equal(V.validDeckMode("b"), true);
    assert.equal(V.validDeckMode("x"), false);

    // Deck follows actual state and returns to A once resolved.
    Voice.state.deckPin = "auto";
    Voice.state.context = null;
    Voice.state.routinePreview = null;
    Voice.state.ambiguity = [];
    Voice.state.approvalNote = null;
    Voice.state.receipt = null;
    Voice.state.stable = [];
    assert.equal(Voice.deckMode(), "a");
    // Receipt alone stays on the ribbon.
    Voice.state.receipt = { target: "Agent", status: "ok", message: "Preview done." };
    Voice.state.stable = [{ id: 1, text: "hello", final: true }];
    assert.equal(Voice.deckMode(), "a");
    // Actual steps open the instance.
    Voice.state.routinePreview = { routineId: "design", name: "Design workspace" };
    assert.equal(Voice.deckMode(), "c");
    Voice.state.routinePreview = null;
    assert.equal(Voice.deckMode(), "a");
    // Pending choices open the instance.
    Voice.state.ambiguity = [{ id: "notes", name: "Notes", kind: "folder", target: "D:\\p" }];
    assert.equal(Voice.deckMode(), "c");
    Voice.state.ambiguity = [];
    assert.equal(Voice.deckMode(), "a");
    // Approvals open the instance.
    Voice.state.approvalNote = "That needs an explicit click.";
    assert.equal(Voice.deckMode(), "c");
    Voice.state.approvalNote = null;
    assert.equal(Voice.deckMode(), "a");
    // Context opens the instance, clearing it returns to the ribbon.
    Voice.state.context = { kind: "file", label: "notes.txt", name: "notes.txt", path: "C:\\p\\n.txt" };
    assert.equal(Voice.deckMode(), "c");
    Voice.clearContext();
    assert.equal(Voice.deckMode(), "a");
    // B stays reachable by pin only.
    Voice.state.stable = [
      { id: 2, text: "one", final: true },
      { id: 3, text: "two", final: true },
    ];
    assert.equal(Voice.deckMode(), "a");
    Voice.state.deckPin = "b";
    assert.equal(Voice.deckMode(), "b");
    Voice.state.deckPin = "auto";

    // Confirm first: finals aggregate and wait, Enter submits once.
    V.resetSubmissionGuard();
    Voice.state.generation = 41;
    Voice.state.runtime = "listening";
    Voice.state.stable = [];
    Voice.state.pendingSegments = [];
    assert.equal(Voice.applyFinal("preview confirm line", 41), "preview confirm line");
    assert.deepEqual(Voice.state.pendingSegments, ["preview confirm line"]);
    const taken = Voice.takeSegments();
    assert.equal(taken.aggregate, "preview confirm line");
    V.noteSubmittedSegments(41, taken.aggregate, taken.segments);
    assert.equal(V.wasSubmitted(41, "preview confirm line"), true);
    assert.equal(Voice.applyFinal("preview confirm line", 41), null);
    // Late results for an older turn never act.
    Voice.cancelTurn(42);
    assert.equal(Voice.applyFinal("preview confirm line", 41), null);

    // Source checks: card keeps Mic and Input only, pins live in settings.
    const sectionSrc = fs.readFileSync(path.join(ROOT, "src/choom/voiceSection.ts"), "utf8");
    assert.ok(sectionSrc.includes("voice-mic"), "mic control present");
    assert.ok(sectionSrc.includes("voice-input"), "input control present");
    assert.ok(sectionSrc.includes("voice-stop"), "transient stop present");
    assert.ok(!sectionSrc.includes("voice-send"), "send removed from card");
    assert.ok(!sectionSrc.includes("voice-autosend"), "auto send removed from card");
    assert.ok(!sectionSrc.includes("voice-mute"), "card mute removed");
    assert.ok(!sectionSrc.includes("voice-mode"), "card mode row removed");
    assert.ok(!sectionSrc.includes("modeRow"), "card mode row gone, not hidden");
    assert.ok(sectionSrc.includes("viewSelect"), "settings view selector present");
    assert.ok(sectionSrc.includes("C action preview"), "settings offers C preview");
    assert.ok(sectionSrc.includes("Voice.state.deckPin = next"), "settings pin saves coherently");
    assert.ok(sectionSrc.includes("voice-slot"), "instance slot present");
    assert.ok(sectionSrc.includes("voice-actions"), "right action group present");
    assert.ok(sectionSrc.includes("voice-editor"), "toggle editor present");
    assert.ok(sectionSrc.includes("aria-expanded"), "input exposes expanded state");
    assert.ok(sectionSrc.includes("aria-label"), "accessible labels present");
    // Editor behavior: Enter submits, Escape keeps the draft.
    assert.ok(sectionSrc.includes("\"Enter\""), "enter submits");
    assert.ok(sectionSrc.includes("\"Escape\""), "escape closes editor");
    assert.ok(sectionSrc.includes("let draft"), "draft retained");
    assert.ok(sectionSrc.includes("setEditor"), "input toggles editor");
    // Slot rotation: shared slot, four second cycle, pause and manual path.
    assert.ok(sectionSrc.includes("4000"), "four second rotation");
    assert.ok(sectionSrc.includes("visibilitychange"), "hidden document pauses");
    assert.ok(sectionSrc.includes(":hover"), "hover pauses");
    assert.ok(sectionSrc.includes(":focus"), "focus pauses");
    assert.ok(sectionSrc.includes("prefers-reduced-motion"), "reduced motion manual cycle");
    assert.ok(sectionSrc.includes("clearTimeout"), "timer disposal present");
    assert.ok(sectionSrc.includes("isConnected"), "disposed card stops timer");
    assert.ok(sectionSrc.includes("export async function toggleMute"), "header can reuse mic mute");
    // Disposal contract: optional host dispose, named listener, owned filler,
    // guarded callbacks and conditional card release.
    assert.ok(sectionSrc.includes("dispose()"), "voice view exposes dispose");
    assert.ok(sectionSrc.includes("onVisibility"), "named visibility listener");
    assert.ok(sectionSrc.includes("removeEventListener(\"visibilitychange\", onVisibility)"), "visibility listener removed");
    assert.ok(sectionSrc.includes("activeJevFiller"), "filler ownership tracked");
    assert.ok(sectionSrc.includes("if (disposed) return"), "queued callbacks stop after dispose");
    assert.ok(sectionSrc.includes("if (mountedVoiceCard === card) mountedVoiceCard = null"), "card released for its own instance only");
    assert.ok(sectionSrc.includes("State.view !== \"voice\""), "view changes clear timers immediately");
    // Confirm first path stays explicit through the editor.
    assert.ok(sectionSrc.includes("manualVoiceSubmit"), "enter uses manual submit");

    // Header: mute sits between New and Settings with mic state, and its
    // Voice subscription is released on dispose.
    const viewsSrc = fs.readFileSync(path.join(ROOT, "src/views/views.ts"), "utf8");
    assert.ok(viewsSrc.includes("dispose?(): void"), "view hosts support disposal");
    const headerActions = viewsSrc.indexOf("header-actions");
    assert.ok(headerActions > 0, "header actions present");
    const muteAt = viewsSrc.indexOf("muteBtn", headerActions - 2000);
    assert.ok(muteAt > 0, "header mute present");
    assert.ok(viewsSrc.includes("void toggleMute"), "header mute reuses mic mute");
    assert.ok(viewsSrc.includes("Mute microphone"), "mic mute label present");
    assert.ok(viewsSrc.includes("Unmute microphone"), "mic unmute label present");
    assert.ok(viewsSrc.includes("aria-pressed"), "mute exposes pressed state");
    assert.ok(viewsSrc.includes("offMute()"), "header disposes its mute listener");
    // Mute is wired before Settings in the same action row.
    const mutePos = viewsSrc.indexOf("muteBtn, gearBtn");
    assert.ok(mutePos > 0, "mute sits before settings");
    for (const s of ["Mute microphone", "Unmute microphone", "Voice actions"]) {
      assert.ok(!s.includes("\u2014") && !s.includes("\u2013") && !s.includes("\u00b7"), "new mute copy uses plain text");
    }

    // Styles: invisible dot rests, centered group, readable live speech,
    // wrapping errors, slot, tokens and motion safety.
    const css = fs.readFileSync(path.join(ROOT, "src/choom/choom.css"), "utf8");
    assert.ok(css.includes("--voice-ease"), "easing token present");
    assert.ok(css.includes("--voice-fast"), "duration token present");
    assert.ok(css.includes("34px"), "34px hit targets present");
    assert.ok(css.includes("border: 1px solid transparent"), "rest has no visible circle");
    assert.ok(css.includes("background: transparent"), "rest has no visible background");
    assert.ok(css.includes(".voice-actions"), "action group present");
    assert.ok(css.includes("align-self: center") || css.includes("justify-content: center"), "group centered");
    assert.ok(css.includes("opacity: 0.92"), "live speech reads in main ink");
    assert.ok(css.includes("overflow-wrap: anywhere"), "long lines wrap instead of clipping");
    assert.ok(!css.includes(".voice-modes"), "mode row style removed");
    assert.ok(css.includes(".voice-stop"), "transient stop stays styled");
    assert.ok(css.includes(".voice-slot"), "slot style present");
    assert.ok(css.includes("(hover: none)"), "touch shows full controls");
    assert.ok(css.includes("prefers-reduced-motion"), "reduced motion present");
    assert.ok(!css.includes(".voice-send"), "send style removed");
    assert.ok(!css.includes(".voice-autosend"), "auto send style removed");
    assert.ok(css.includes("118px"), "left mascot padding preserved");

    // Fixture: production header plus production card in a synthetic island.
    for (const rel of ["dev/voice-outlooks-fixture.html", "dev/voice-outlooks-fixture.ts"]) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} present`);
    }
    const fixTs = fs.readFileSync(path.join(ROOT, "dev/voice-outlooks-fixture.ts"), "utf8");
    assert.ok(fixTs.includes("buildVoiceView"), "fixture uses production view");
    assert.ok(fixTs.includes("buildRealHeader"), "fixture renders production header");
    assert.ok(fixTs.includes("setVoiceDeps"), "fixture injects fake deps");
    assert.ok(fixTs.includes("header order check"), "fixture verifies header order");
    assert.ok(fixTs.includes("hide island"), "fixture verifies hide lifecycle");
    assert.ok(fixTs.includes("show island"), "fixture verifies show lifecycle");
    assert.ok(fixTs.includes("reduced motion"), "fixture previews reduced motion honestly");
    assert.ok(fixTs.includes("long error"), "fixture covers wrapping errors");
    assert.ok(fixTs.includes("long approval"), "fixture covers wrapping approvals");
    assert.ok(fixTs.includes("voiceMode"), "fixture pins through the settings path");
    assert.ok(fixTs.includes("toggleMute"), "fixture exercises header mute");
    assert.ok(fixTs.includes("getElementById(\"island\")"), "fixture mounts inside a structured island");
    for (const label of ["idle", "listening", "working", "choice", "approval", "receipt", "error", "draft", "manual", "auto", "400", "560"]) {
      assert.ok(fixTs.toLowerCase().includes(label), `fixture covers ${label}`);
    }
    assert.ok(!fixTs.includes("C:\\Users"), "fixture has no private paths");
    const fixHtml = fs.readFileSync(path.join(ROOT, "dev/voice-outlooks-fixture.html"), "utf8");
    assert.ok(fixHtml.includes("voice-outlooks-fixture.ts"), "html loads fixture module");
    assert.ok(fixHtml.includes("header-slot"), "html hosts the production header");

    // No banned sentence connectors in new or changed copy. views.ts keeps
    // legacy characters outside this change, so the mute copy is checked
    // directly instead of the whole file.
    for (const rel of [
      "src/choom/voice.ts",
      "src/choom/voiceSection.ts",
      "src/choom/choom.css",
      "dev/voice-outlooks-fixture.ts",
      "dev/voice-outlooks-fixture.html",
      "scripts/voice-outlooks-regression.cjs",
    ]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
      assert.ok(!text.includes("\u00b7"), `${rel} must not contain middle dots`);
    }

    // Mount and dispose the real voice view: listener and timer counts
    // return to baseline, hides clear immediately, shows resume singly,
    // and queued callbacks never restart after disposal.
    for (const rel of [
      "src/core/layout.ts",
      "src/core/state.ts",
      "src/choom/tools.ts",
      "src/choom/jev.ts",
      "src/views/dom.ts",
      "src/views/icons.ts",
      "src/choom/voiceSection.ts",
    ]) compile(rel, tmp);
    shim = installDomShim();
    const bridgeStub = new Proxy({}, {
      get: (_t, p) => {
        if (p === "__esModule") return undefined;
        return (..._args) => Promise.resolve(null);
      },
    });
    const soundStub = {
      Sound: {
        play() {}, resume() {}, idle() {}, setEnabled() {}, setVolume() {},
        preload: async () => {},
      },
    };
    const chatStub = {
      submitChatTurn: async () => ({ text: "stub" }),
      currentChatOwner: () => 0,
      cancelChatTurn: () => {},
    };
    Module._load = function (request, parent, isMain) {
      if (request.includes("core/bridge")) return { Bridge: bridgeStub };
      if (request.includes("core/sound")) return soundStub;
      if (request.includes("views/chat")) return chatStub;
      return origLoad.apply(this, [request, parent, isMain]);
    };
    const VS = require(path.join(tmp, "src/choom/voiceSection.js"));
    const StateMod = require(path.join(tmp, "src/core/state.js"));
    const VoiceObj = Voice;
    const StateObj = StateMod.State;
    assert.ok(typeof VS.buildVoiceView === "function", "real view loads under the shim");
    const origVSub = VoiceObj.subscribe.bind(VoiceObj);
    const origSSub = StateObj.subscribe.bind(StateObj);
    let subCount = 0;
    let unsubCount = 0;
    VoiceObj.subscribe = (fn) => {
      subCount += 1;
      const off = origVSub(fn);
      return () => { unsubCount += 1; off(); };
    };
    StateObj.subscribe = (fn) => {
      subCount += 1;
      const off = origSSub(fn);
      return () => { unsubCount += 1; off(); };
    };
    patchedVoice = { obj: VoiceObj, orig: origVSub };
    patchedState = { obj: StateObj, orig: origSSub };

    const savedPin = VoiceObj.state.deckPin;
    const savedRoutine = VoiceObj.state.routinePreview;
    const savedView = StateObj.view;
    const savedMode = StateObj.mode;
    const savedStable = VoiceObj.state.stable;
    VoiceObj.state.deckPin = "auto";
    VoiceObj.state.routinePreview = { routineId: "preview-missing", name: "Preview" };
    VoiceObj.state.stable = [];
    StateObj.view = "voice";
    StateObj.mode = "expanded";

    const island = shim.doc.createElement("div");
    island.setAttribute("id", "island");
    shim.doc.body.appendChild(island);
    const baseDoc = (shim.docListeners.visibilitychange || []).length;
    const baseSub = subCount;
    const baseUn = unsubCount;

    const host = VS.buildVoiceView(() => {});
    assert.ok(typeof host.dispose === "function", "host exposes dispose");
    island.appendChild(host.el);
    host.el.classList.add("on");
    host.sync();
    const diagnostic = { route: "unknown", mode: "assisted", confidence: 0, latency_ms: 1076, fallback: "invalid-response" };
    VS.setLastJevReceipt(diagnostic);
    host.sync();
    assert.equal(host.el.querySelector(".voice-jev-receipt"), null, "routing diagnostics never occupy the voice card");
    assert.equal(VS.getLastJevReceipt(), diagnostic, "routing diagnostics remain available to settings");
    VS.setLastJevReceipt(null);
    assert.equal(shim.activeTimers.size, 1, "rotation timer runs on visible voice");
    assert.equal((shim.docListeners.visibilitychange || []).length, baseDoc + 1, "one visibility listener per mount");
    assert.equal(subCount - baseSub, 2, "voice plus state subscription per mount");

    StateObj.view = "overview";
    StateObj.notify();
    assert.equal(shim.activeTimers.size, 0, "hide clears the timer immediately");
    StateObj.view = "voice";
    StateObj.notify();
    StateObj.notify();
    assert.equal(shim.activeTimers.size, 1, "show resumes with a single timer");

    const timerId = [...shim.activeTimers.keys()][0];
    const queued = shim.activeTimers.get(timerId);
    host.dispose();
    host.el.remove();
    assert.equal(shim.activeTimers.size, 0, "dispose clears the timer");
    assert.equal((shim.docListeners.visibilitychange || []).length, baseDoc, "dispose removes the visibility listener");
    queued();
    assert.equal(shim.activeTimers.size, 0, "queued callbacks never restart after dispose");

    for (let i = 0; i < 3; i += 1) {
      const h2 = VS.buildVoiceView(() => {});
      island.appendChild(h2.el);
      h2.el.classList.add("on");
      h2.sync();
      h2.dispose();
      h2.el.remove();
    }
    assert.equal(subCount - baseSub, unsubCount - baseUn, "subscriptions return to baseline");
    assert.equal((shim.docListeners.visibilitychange || []).length, baseDoc, "listeners return to baseline");
    assert.equal(shim.activeTimers.size, 0, "timers return to baseline");
    VoiceObj.notify();
    StateObj.notify();

    VoiceObj.state.routinePreview = savedRoutine;
    VoiceObj.state.deckPin = savedPin;
    VoiceObj.state.stable = savedStable;
    StateObj.view = savedView;
    StateObj.mode = savedMode;
    island.remove();

    console.log("voice outlooks regression: all assertions passed");
  } finally {
    if (patchedVoice) patchedVoice.obj.subscribe = patchedVoice.orig;
    if (patchedState) patchedState.obj.subscribe = patchedState.orig;
    Module._load = origLoad;
    if (shim) shim.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
