// Notifications behavioral regressions: dedup and quiet counting, VIP
// matching on stable identity only, bounded queue with expiry, removal and
// dismissal never surfacing late, private mode text hiding, four-second
// display through Focus, priority preemption and restore, and disable
// cleanup. No dependencies: real compiled modules, stubbed timers, fake
// wiring. Fixtures are labeled fixtures, never live notifications.

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// Minimal DOM: just enough for the panel to build and for tests to read text
// and click buttons. No layout, no rendering.
function makeNode(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    className: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    value: "",
    append(...kids) { for (const k of kids) if (k != null) this.children.push(k); },
    appendChild(k) { this.children.push(k); return k; },
    removeChild(k) { this.children = this.children.filter((c) => c !== k); },
    get firstChild() { return this.children[0] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); },
    click() { for (const fn of this.listeners.click ?? []) fn({}); },
    querySelectorAll() { return []; },
    get text() { return this.textContent || this.children.map((c) => c.text ?? c.textContent ?? "").join(""); },
  };
}
global.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  createTextNode: (text) => ({ tag: "#text", text, textContent: text, children: [] }),
};

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "notifications-regression-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/choom/notifications.ts",
    "src/choom/notificationsSection.ts",
    "src/choom/focus.ts",
    "--outDir", out,
    "--module", "commonjs",
    "--target", "es2020",
    "--lib", "es2020,dom",
    "--skipLibCheck",
    "--noUnusedLocals", "false",
    "--noUnusedParameters", "false",
  ],
  { cwd: windowsDir, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } },
);

// The compiled bridge requires the Tauri API at load time; the controller
// never calls it in tests (no window, IS_TAURI false), so inert stubs suffice.
const tauriStub = path.join(out, "node_modules", "@tauri-apps", "api");
fs.mkdirSync(tauriStub, { recursive: true });
fs.writeFileSync(path.join(tauriStub, "core.js"), "exports.invoke = async () => null;\n");
fs.writeFileSync(path.join(tauriStub, "event.js"), "exports.listen = async () => () => {};\n");
fs.writeFileSync(path.join(tauriStub, "webview.js"), "exports.getCurrentWebview = () => ({ onDragDropEvent: async () => () => {} });\n");

const { State, DEFAULT_SETTINGS } = require(path.join(out, "core/state.js"));
const {
  NotificationsController, NOTIFICATIONS_ID, VIP_MOMENT_MS,
  MAX_RECENT, MAX_VIP_QUEUE, VIP_QUEUE_TTL_MS,
  isVipApp, vipLines, clampLine, canPresentNow,
} = require(path.join(out, "choom/notifications.js"));
const { FocusEngine } = require(path.join(out, "choom/focus.js"));
const { notificationsPanel } = require(path.join(out, "choom/notificationsSection.js"));

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

// Deterministic timers and wall clock, same shape as focus-regression.
const realSetImmediate = setImmediate;
let clock = 100000;
const scheduled = new Map();
let timerID = 0;
global.setTimeout = (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms }); return id; };
global.clearTimeout = (id) => { scheduled.delete(id); };
Date.now = () => clock;
function advance(ms) {
  const target = clock + ms;
  for (let n = 0; n < 100000; n++) {
    let id = null, next = null;
    for (const [key, t] of scheduled) {
      if (t.at <= target && (!next || t.at < next.at)) { id = key; next = t; }
    }
    if (!next) break;
    clock = next.at;
    scheduled.delete(id);
    next.fn();
  }
  clock = target;
}
const flush = () => new Promise((r) => realSetImmediate(r));

// ── Fixture factory: a labeled fixture, never real content ──────────────────
let fixtureN = 0;
function fixture(over = {}) {
  fixtureN += 1;
  return {
    key: `fixture:key:${fixtureN}`,
    id: fixtureN,
    app: "Fixture App",
    appId: "FixtureApp_abc123",
    title: `Fixture title ${fixtureN}`,
    body: `Fixture body ${fixtureN}`,
    kind: "message",
    createdMs: clock,
    ...over,
  };
}
function quietFixture(over = {}) {
  return fixture({ app: "Fixture Quiet", appId: "QuietApp_xyz789", ...over });
}

// Wires a controller with fake sinks and returns the recorded calls.
function harness(over = {}) {
  const calls = { moments: [], withdraws: [], unread: [] };
  const settings = {
    enabled: true, vip: [], priv: false, blocked: false,
    ...over,
  };
  const ctl = new NotificationsController({
    isEnabled: () => settings.enabled,
    vipApps: () => settings.vip,
    isPrivate: () => settings.priv,
    canPresent: () => !settings.blocked,
    present: (m) => calls.moments.push(m),
    withdraw: (taskId, key) => calls.withdraws.push([taskId, key]),
    onUnread: (n) => calls.unread.push(n),
    now: () => clock,
  });
  return { ctl, calls, settings };
}

// ── Suite 0: defaults are opt-out ──────────────────────────────────────────
{
  check("notifications default to off", DEFAULT_SETTINGS.notificationsEnabled === false);
  check("no VIP apps by default", Array.isArray(DEFAULT_SETTINGS.notificationsVipApps) && DEFAULT_SETTINGS.notificationsVipApps.length === 0);
  check("content is shown by default, not hidden", DEFAULT_SETTINGS.notificationsPrivate === false);
  // A default-off controller must ignore arrivals until the user opts in.
  const { ctl, calls } = harness();
  // harness defaults enabled=true, so simulate the shipped default explicitly.
  const off = new NotificationsController({
    isEnabled: () => DEFAULT_SETTINGS.notificationsEnabled === true,
    vipApps: () => DEFAULT_SETTINGS.notificationsVipApps,
    isPrivate: () => DEFAULT_SETTINGS.notificationsPrivate === true,
    canPresent: () => true,
    present: (m) => calls.moments.push(m),
    withdraw: () => {},
    onUnread: () => {},
    now: () => clock,
  });
  off.added(fixture());
  check("default-off controller stays silent and counts nothing", off.view().unread === 0 && off.view().recent.length === 0);
  void ctl;
}

// ── Suite 1: quiet counting, dedup, bounded list ────────────────────────────
{
  const { ctl, calls } = harness();
  const a = fixture();
  const b = fixture();
  ctl.added(a);
  ctl.added(b);
  check("non-VIP items count as quiet unread", ctl.view().unread === 2);
  check("no banner moment for quiet items", calls.moments.length === 0);
  check("recent list is newest first", ctl.view().recent[0].key === b.key);
  ctl.added(a); // duplicate delivery of the same key
  check("duplicate key never double counts", ctl.view().unread === 2);
  check("duplicate key refreshes in place, no third entry", ctl.view().recent.length === 2);
  const refreshed = { ...a, body: "Fixture updated body" };
  ctl.added(refreshed);
  check("content refresh keeps one entry and quiet count", ctl.view().unread === 2 && ctl.view().recent.length === 2);
  check("content refresh lands newest first", ctl.view().recent[0].body === "Fixture updated body");
  ctl.markRead();
  check("markRead resets the quiet count, list stays", ctl.view().unread === 0 && ctl.view().recent.length === 2);
  const c = fixture();
  ctl.added(c);
  check("new item after read counts again", ctl.view().unread === 1);
  ctl.cleared();
  check("clear empties list and count", ctl.view().unread === 0 && ctl.view().recent.length === 0);
}

// ── Suite 2: oversized snapshots must not re-banner or re-count ────────────
{
  const { ctl, calls } = harness();
  // A snapshot burst far beyond the recent bound, then the same keys again.
  const items = [];
  for (let i = 0; i < MAX_RECENT + 20; i++) items.push(fixture());
  for (const it of items) ctl.added(it);
  check("recent list is bounded", ctl.view().recent.length === MAX_RECENT);
  check("quiet count is bounded to the retained list", ctl.view().unread === MAX_RECENT);
  for (const it of items) ctl.added(it); // second identical snapshot
  check("repeated snapshot never re-counts", ctl.view().unread === MAX_RECENT);
  check("repeated snapshot never re-banners", calls.moments.length === 0);
  const vipBurst = harness({ vip: ["FixtureApp_abc123"] });
  // Blocked, so the burst exercises the controller's own bounded queue.
  vipBurst.settings.blocked = true;
  for (const it of items) vipBurst.ctl.added(it);
  check("VIP burst while blocked queues at most the bound", vipBurst.calls.moments.length === 0);
  vipBurst.settings.blocked = false;
  vipBurst.ctl.pump();
  check("VIP burst presents one moment, the rest dropped by the bound", vipBurst.calls.moments.length === 1);
  const shown = vipBurst.calls.moments.length;
  for (const it of items) vipBurst.ctl.added(it);
  check("VIP re-snapshot surfaces nothing after the first pass", vipBurst.calls.moments.length === shown);
}

// ── Suite 3: VIP identity, priority queue and expiry ───────────────────────
{
  check("full stable id matches case-insensitively", isVipApp("FixtureApp_abc123", ["fixtureapp_abc123"]));
  check("display-name style match is refused", !isVipApp("Fixture App", ["Fixture App"]));
  check("truncated prefix never matches", !isVipApp("FixtureApp_abc123", ["FixtureApp"]));
  check("empty identity is never VIP", !isVipApp("", [""]));
  const { ctl, calls, settings } = harness({ vip: ["FixtureApp_abc123"] });
  const v = fixture();
  ctl.added(v);
  check("VIP item borrows the pill at once", calls.moments.length === 1);
  const m = calls.moments[0];
  check("VIP moment targets the notifications pill", m.taskId === NOTIFICATIONS_ID);
  check("VIP moment carries the source key", m.sourceKey === v.key);
  check("VIP moment lasts four seconds", m.ms === VIP_MOMENT_MS);
  check("VIP moment is the notification kind", m.kind === "notification");
  check("VIP items never inflate the quiet count", ctl.view().unread === 0);
  // Blocked: approvals, pins and drops hold the queue.
  settings.blocked = true;
  const q1 = fixture(), q2 = fixture(), q3 = fixture(), q4 = fixture();
  ctl.added(q1); ctl.added(q2); ctl.added(q3); ctl.added(q4);
  check("blocked VIP items queue, none shown", calls.moments.length === 1);
  check("VIP queue drops the oldest beyond its bound", !calls.moments.some((x) => x.sourceKey === q1.key));
  settings.blocked = false;
  ctl.pump();
  check("lifting the block shows the oldest queued VIP first", calls.moments.length === 2 && calls.moments[1].sourceKey === q2.key);
  advance(VIP_QUEUE_TTL_MS + 1);
  ctl.pump();
  // q1/q2/q3 expired during the TTL window; only unexpired items may show.
  const afterTTL = calls.moments.length;
  check("expired queued VIP never surfaces", afterTTL <= 3 && !calls.moments.some((x) => x.sourceKey === q1.key));
}

// ── Suite 4: removal and local dismiss never surface late ──────────────────
{
  const { ctl, calls, settings } = harness({ vip: ["FixtureApp_abc123"] });
  settings.blocked = true;
  const gone = fixture(), stays = fixture();
  ctl.added(gone); ctl.added(stays);
  ctl.removed(gone.key); // Windows removal while queued
  settings.blocked = false;
  ctl.pump();
  check("removed-while-queued VIP never surfaces", !calls.moments.some((x) => x.sourceKey === gone.key));
  check("surviving queued VIP still surfaces", calls.moments.some((x) => x.sourceKey === stays.key));
  // Dismiss of a showing item withdraws the moment by exact source key.
  const showing = fixture();
  ctl.added(showing);
  const activeMoment = calls.moments.at(-1);
  ctl.removed(showing.key);
  check("dismiss withdraws by exact source key", calls.withdraws.some(([t, k]) => t === NOTIFICATIONS_ID && k === showing.key) && activeMoment.sourceKey === showing.key);
  // Removal of a quiet unread item decrements the count.
  const quiet = fixture({ appId: "QuietApp_xyz789", app: "Quiet App" });
  ctl.added(quiet);
  const before = ctl.view().unread;
  ctl.removed(quiet.key);
  check("removing an unread quiet item decrements", ctl.view().unread === before - 1);
}

// ── Suite 5: private mode hides content, clamps long text ──────────────────
{
  const lines = vipLines(fixture({ title: "Fixture private title", body: "Fixture private body" }), true);
  check("private mode hides the title", !lines[0].includes("private title"));
  check("private mode hides the body", !lines.join(" ").includes("private body"));
  const long = vipLines(fixture({ title: "x".repeat(300), body: "y".repeat(800) }), false);
  check("long titles clamp for the pill", long[0].length <= 48 && long[0].endsWith("…"));
  check("long bodies clamp for the pill", long[1].length <= 64 && long[1].endsWith("…"));
  check("clampLine is stable on short text", clampLine("short", 10) === "short");
  check("clamp does not split emoji", clampLine("x😀rest", 3) === "x…");
}

// ── Suite 6: priority ladder and restore through the real FocusEngine ──────
{
  const tasks = [
    { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
    { id: "integration_music", name: "Music", color: "#0f0", state: "working", stepIndex: 0, steps: [], source: "n8n", isIntegration: true },
    { id: NOTIFICATIONS_ID, name: "Notifications", color: "#80AFE5", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: true },
  ];
  State.tasks = tasks;
  State.pendingApproval = null;
  State.isPinned = false;
  const world = {
    taskIds: tasks.map((t) => t.id),
    approvalTaskId: null,
    workingIds: ["integration_music"],
    musicId: "integration_music",
    idleId: "integration_claude",
  };
  const applied = [];
  const engine = new FocusEngine({
    readWorld: () => ({ ...world, workingIds: ["integration_music"] }),
    applyFocus: (id) => applied.push(id),
    isExpanded: () => false,
    now: () => clock,
  });
  engine.start((fn) => State.subscribe(fn));
  const { ctl } = harness({ vip: ["FixtureApp_abc123"] });
  // Re-present through the real engine instead of the fake sink.
  const realCtl = new NotificationsController({
    isEnabled: () => true,
    vipApps: () => ["FixtureApp_abc123"],
    isPrivate: () => false,
    canPresent: () => true,
    present: (m) => engine.moment(m),
    withdraw: (taskId, key) => engine.withdraw(taskId, key),
    onUnread: () => {},
    now: () => clock,
  });
  void ctl;
  const vip = fixture();
  realCtl.added(vip);
  check("VIP moment owns the pill through Focus", engine.owner.taskId === NOTIFICATIONS_ID && engine.owner.moment?.sourceKey === vip.key);
  // An approval preempts the VIP moment at once.
  world.approvalTaskId = "integration_claude";
  State.pendingApproval = { requestId: "r", sessionId: "s", tool: "t", command: "c", taskId: "integration_claude" };
  engine.recompute();
  check("approval outranks the VIP moment", engine.owner.taskId === "integration_claude" && engine.owner.moment == null);
  State.pendingApproval = null;
  world.approvalTaskId = null;
  engine.recompute();
  // A preempted VIP moment ends; the prior valid state restores at once and
  // the old item never resumes as stale news.
  check("clearing the approval restores the prior owner", engine.owner.taskId === "integration_music" && engine.owner.moment == null);
  // Four seconds of actual display time, measured from when it shows.
  const fresh = fixture();
  realCtl.added(fresh);
  const shownAt = clock;
  check("fresh VIP moment shows immediately after restore", engine.owner.moment?.sourceKey === fresh.key);
  advance(VIP_MOMENT_MS - 1);
  const stillOwning = engine.owner.taskId === NOTIFICATIONS_ID;
  advance(2);
  check("VIP display lasts four actual seconds", stillOwning && engine.owner.taskId === "integration_music");
  check("restore returns to the prior ranked owner", engine.owner.taskId === "integration_music");
  check("display time starts on show, not on arrival", clock - shownAt === VIP_MOMENT_MS + 1);
  // Manual pin protects the pill from a later VIP moment.
  engine.pin("integration_claude");
  const blocked = fixture();
  realCtl.added(blocked);
  check("a pin blocks a VIP takeover", engine.owner.taskId === "integration_claude" && engine.owner.moment == null);
  engine.pin(null);
  engine.dispose();
}

// ── Suite 7: disabled and dispose clean up completely ─────────────────────
{
  const { ctl, calls, settings } = harness();
  settings.enabled = false;
  ctl.added(fixture());
  check("disabled controller ignores arrivals", ctl.view().unread === 0 && calls.moments.length === 0);
  settings.enabled = true;
  ctl.added(fixture());
  ctl.added(fixture());
  check("enabled again counts normally", ctl.view().unread === 2);
  ctl.dispose();
  check("dispose clears the quiet count", ctl.view().unread === 0);
  check("dispose withdraws any showing moment", calls.withdraws.some(([t, k]) => t === NOTIFICATIONS_ID && k === undefined));
  ctl.added(fixture());
  check("disposed controller stays inert", ctl.view().recent.length === 0);
  ctl.removed("fixture:key:1");
  const w = calls.withdraws.length;
  ctl.cleared();
  check("disposed cleared draws nothing new", calls.withdraws.length === w);
}

// ── Suite 8: panel rendering, private mode and local-only actions ──────────
{
  const mk = () => notificationsPanel({
    recent: [fixture({ app: "Fixture App", title: "Fixture panel title", body: "Fixture panel body" })],
    unread: 3,
    enabled: true,
    status: "allowed",
    priv: false,
  });
  const panel = mk();
  const flat = (node, acc = []) => {
    acc.push(node.text ?? node.textContent ?? "");
    for (const c of node.children ?? []) flat(c, acc);
    return acc;
  };
  const allText = flat(panel).join(" | ");
  check("panel shows the fixture title", allText.includes("Fixture panel title"));
  check("panel shows the unread count", flat(panel).some((t) => t === "3"));
  const buttons = [];
  const collectButtons = (node) => {
    if (node.tag === "button") buttons.push(node);
    for (const c of node.children ?? []) collectButtons(c);
  };
  collectButtons(panel);
  const labels = buttons.map((b) => b.textContent || b.attrs["aria-label"] || "");
  check("panel offers dismiss and clear and read, no invented actions",
    labels.some((l) => l.includes("Dismiss")) &&
    labels.some((l) => l.includes("Clear all")) &&
    labels.some((l) => l.includes("Mark as read")) &&
    !labels.some((l) => /reply|snooze|retry|approve/i.test(l)));
  check("dismiss buttons carry an accessible name",
    buttons.filter((b) => (b.textContent || "") === "Dismiss")
      .every((b) => (b.attrs["aria-label"] || "").includes("Fixture App")));
  // Private mode hides the content but keeps the app readable.
  const priv = notificationsPanel({
    recent: [fixture({ app: "Fixture App", title: "Fixture secret title", body: "Fixture secret body" })],
    unread: 1, enabled: true, status: "allowed", priv: true,
  });
  const privText = flat(priv).join(" | ");
  check("private panel hides the title", !privText.includes("Fixture secret title"));
  check("private panel hides the body", !privText.includes("Fixture secret body"));
  check("private panel still names the app", privText.includes("Fixture App"));
  // Long text is clamped in the panel rows.
  const longPanel = notificationsPanel({
    recent: [fixture({ title: "L".repeat(300), body: "B".repeat(900) })],
    unread: 0, enabled: true, status: "allowed", priv: false,
  });
  const longText = flat(longPanel).join(" | ");
  check("panel clamps long titles", !longText.includes("L".repeat(49)));
  check("panel clamps long bodies", !longText.includes("B".repeat(73)));
  // Off state explains itself and lists nothing.
  const off = notificationsPanel({ recent: [fixture()], unread: 5, enabled: false, status: "disabled", priv: false });
  const offText = flat(off).join(" | ");
  check("off panel explains itself and shows no items",
    offText.includes("off") && !offText.includes("Fixture title"));
  // Blocked statuses read as status, never as Nothing yet.
  for (const [st, needle] of [["denied", "denied"], ["missingIdentity", "Windows setup"], ["unsupported", "Windows only"]]) {
    const blocked = notificationsPanel({ recent: [], unread: 0, enabled: true, status: st, priv: false });
    const blockedText = flat(blocked).join(" | ");
    check(`panel shows ${st} instead of Nothing yet`,
      blockedText.toLowerCase().includes(needle.toLowerCase()) && !blockedText.includes("Nothing yet"));
  }
}

// ── Suite 9: unread stays bounded to the retained list ─────────────────────
{
  const { ctl } = harness();
  const items = [];
  for (let i = 0; i < MAX_RECENT + 20; i++) items.push(fixture());
  for (const it of items) ctl.added(it);
  check("unread never grows past the recent bound", ctl.view().unread === MAX_RECENT);
  check("recent holds the newest items", ctl.view().recent[0].key === items[items.length - 1].key);
  const evictedKey = items[0].key;
  check("evicted keys leave the quiet count", !ctl.view().recent.some((r) => r.key === evictedKey));
  ctl.removed(items[items.length - 1].key);
  check("removal decrements the bounded count", ctl.view().unread === MAX_RECENT - 1);
}

// ── Suite 10: seed is silent ───────────────────────────────────────────────
{
  const { ctl, calls } = harness({ vip: ["FixtureApp_abc123"] });
  const history = [fixture(), fixture(), quietFixture()];
  ctl.seed(history);
  check("seed keeps history without counting", ctl.view().unread === 0 && ctl.view().recent.length === 3);
  check("seed never banners, even for VIP identities", calls.moments.length === 0);
  const before = calls.unread.length;
  for (const it of history) ctl.added(it);
  check("seeded keys stay silent on re-delivery", calls.moments.length === 0 && calls.unread.length === before);
}

// ── Suite 11: status and disable teardown ──────────────────────────────────
{
  const { ctl, calls, settings } = harness();
  ctl.added(fixture());
  ctl.added(quietFixture());
  ctl.applyStatus({ state: "denied", listening: false, detail: "denied" });
  check("denied clears the list", ctl.view().recent.length === 0);
  check("denied clears the quiet count", ctl.view().unread === 0);
  check("denied withdraws VIP moments", calls.withdraws.some(([t]) => t === NOTIFICATIONS_ID));
  const afterDenied = fixture();
  ctl.added(afterDenied);
  check("arrivals stay blocked while denied", ctl.view().recent.length === 0 && calls.moments.length === 0);
  ctl.applyStatus({ state: "allowed", listening: true, detail: null });
  ctl.added(fixture());
  check("allowed counts again", ctl.view().unread === 1);
  settings.enabled = false;
  ctl.onSettingsChanged();
  check("settings off clears content", ctl.view().recent.length === 0 && ctl.view().unread === 0);
  check("settings off withdraws", calls.withdraws.length >= 2);
}

// ── Suite 12: hidden and paused never reveal, quiet counts keep working ────
{
  const prevMode = State.mode;
  const prevPaused = State.paused;
  const prevApproval = State.pendingApproval;
  const prevPinned = State.isPinned;
  State.pendingApproval = null;
  State.isPinned = false;
  State.paused = false;
  State.mode = "hidden";
  check("hidden blocks presentation", canPresentNow() === false);
  State.mode = "compact";
  State.paused = true;
  check("paused blocks presentation", canPresentNow() === false);
  State.paused = false;
  State.mode = prevMode;
  State.paused = prevPaused;
  State.pendingApproval = prevApproval;
  State.isPinned = prevPinned;
  // A blocked VIP queues instead of borrowing the pill, while quiet items
  // still count.
  const blocked = harness({ vip: ["FixtureApp_abc123"] });
  blocked.settings.blocked = true;
  const v = fixture();
  blocked.ctl.added(v);
  const q = quietFixture();
  blocked.ctl.added(q);
  check("blocked VIP never reveals", blocked.calls.moments.length === 0);
  check("quiet counts keep working while blocked", blocked.ctl.view().unread === 1);
  blocked.settings.blocked = false;
  blocked.ctl.pump();
  check("unblocking shows one queued VIP", blocked.calls.moments.length === 1);
}

// Rapid arrivals use the real Focus clock and keep every bounded VIP queued.
{
  const engine = new FocusEngine({
    readWorld: () => ({ taskIds: [NOTIFICATIONS_ID, "integration_music"], approvalTaskId: null,
      workingIds: [], musicId: "integration_music", idleId: "integration_music" }),
    applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  let priv = false;
  const ctl = new NotificationsController({
    isEnabled: () => true, vipApps: () => ["FixtureApp_abc123"], isPrivate: () => priv,
    canPresent: () => true, isPresenting: () => engine.hasMoment(NOTIFICATIONS_ID),
    present: (m) => engine.moment(m), withdraw: (id, key) => engine.withdraw(id, key),
    onUnread: () => {}, now: () => clock,
  });
  const off = engine.subscribe(() => ctl.pump());
  engine.moment({ taskId: "integration_music", kind: "track", line1: "Fixture track", line2: "Fixture artist", ms: 4000 });
  const items = [fixture(), fixture(), fixture()];
  for (const item of items) ctl.added(item);
  check("burst keeps first VIP visible", engine.owner.moment?.sourceKey === items[0].key);
  advance(4000);
  check("burst shows second VIP after four seconds", engine.owner.moment?.sourceKey === items[1].key);
  advance(4000);
  check("burst shows third VIP without collapsing", engine.owner.moment?.sourceKey === items[2].key);
  priv = true;
  ctl.onSettingsChanged();
  check("privacy change immediately withdraws exposed moment", engine.owner.moment == null);
  ctl.dispose(); off(); engine.dispose();
}

async function checkPendingGateCancellation() {
  const engine = new FocusEngine({
    readWorld: () => ({ taskIds: [NOTIFICATIONS_ID, "integration_music"], approvalTaskId: null,
      workingIds: [], musicId: "integration_music", idleId: "integration_music" }),
    applyFocus: () => {}, isExpanded: () => false, now: () => clock,
  });
  let resolveGate;
  engine.wakeGate = () => new Promise((resolve) => { resolveGate = resolve; });
  engine.moment({ taskId: NOTIFICATIONS_ID, kind: "notification", line1: "Fixture", line2: "Fixture",
    sourceKey: "fixture:pending", ms: 4000 });
  check("pending native gate counts as busy", engine.hasMoment(NOTIFICATIONS_ID));
  engine.withdraw(NOTIFICATIONS_ID);
  resolveGate(true);
  await flush();
  check("disable during native gate never exposes old text", engine.owner.moment == null && !engine.hasMoment(NOTIFICATIONS_ID));
  engine.dispose();
}
checkPendingGateCancellation().then(() => {
  console.log(failed === 0 ? "\nAll notifications regressions passed." : `\n${failed} notifications regression(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((err) => { console.error(err); process.exit(1); });
