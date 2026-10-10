// Notifications fixture: the real production notificationsPanel, the real
// settings section, the real NotificationsController and the real
// FocusEngine, driven by synthetic labeled fixture data only. No Windows API
// access, no model calls, no live data. Served by `npm run dev` at
// /dev/notifications-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import settingsCss from "../src/settings/settings.css?inline";
import { State } from "../src/core/state";
import { FocusEngine } from "../src/choom/focus";
import {
  NotificationsController,
  NOTIFICATIONS_ID,
  syncNotificationsPill,
} from "../src/choom/notifications";
import {
  notificationsPanel,
  notificationsSettingsSection,
  NOTIFICATIONS_PANEL_H,
} from "../src/choom/notificationsSection";
import { Voice } from "../src/choom/voice";
import { Bridge } from "../src/core/bridge";

const readout = document.getElementById("readout")!;
const logEl = document.getElementById("log")!;
const stage = document.getElementById("stage")!;
const buttons = document.getElementById("buttons")!;
const settingsEl = document.getElementById("settings")!;
const settingsRoot = settingsEl.attachShadow({ mode: "open" });

function say(line: string) {
  logEl.textContent += line + "\n";
}

// ── Synthetic labeled adapters only ─────────────────────────────────────────

let n = 0;
let clock = 1_000_000;
function fixture(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    key: `fixture:key:${n}`,
    id: n,
    app: "Fixture App",
    appId: "FixtureApp_abc123",
    title: `Fixture title ${n}`,
    body: `Fixture body ${n}`,
    kind: "message",
    createdMs: clock,
    ...over,
  };
}
function quietFixture(over: Record<string, unknown> = {}) {
  return fixture({ app: "Fixture Quiet", appId: "QuietApp_xyz789", ...over });
}

// ── Production state wiring ─────────────────────────────────────────────────

State.tasks = [
  { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  { id: "integration_music", name: "Music", color: "#0f0", state: "working", stepIndex: 0, steps: [], source: "n8n", isIntegration: true },
  { id: NOTIFICATIONS_ID, name: "Notifications", color: "#80AFE5", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: true },
];
State.focusId = "integration_music";
State.mode = "compact";
State.paused = false;
State.pendingApproval = null;
State.isPinned = false;
State.droppedFile = null;
State.settings.notificationsEnabled = true;
State.settings.notificationsVipApps = ["FixtureApp_abc123"];
State.settings.notificationsPrivate = false;
Voice.state.runtime = "standby";

const engine = new FocusEngine({
  readWorld: () => ({
    taskIds: State.tasks.map((t) => t.id),
    approvalTaskId: State.pendingApproval?.taskId ?? null,
    workingIds: State.tasks.filter((t) => t.state === "working").map((t) => t.id),
    musicId: "integration_music",
    idleId: "integration_claude",
  }),
  applyFocus: (id) => State.setFocus(id),
  readFocusId: () => State.focusId,
  isExpanded: () => State.mode === "expanded",
  now: () => clock,
});
engine.start((fn) => State.subscribe(fn));

let panelStatus = "allowed";
const ctl = new NotificationsController({
  isEnabled: () => State.settings.notificationsEnabled === true,
  vipApps: () => State.settings.notificationsVipApps ?? [],
  isPrivate: () => State.settings.notificationsPrivate === true,
  present: (m) => engine.moment(m),
  isPresenting: () => engine.hasMoment(NOTIFICATIONS_ID),
  withdraw: (taskId, key) => engine.withdraw(taskId, key),
  onUnread: (unread) => {
    State.notificationsUnread = unread;
  },
  now: () => clock,
});
syncNotificationsPill();

// Only this development page replaces adapters. Production bridge is untouched.
Bridge.notificationsStatus = async () => ({ state: panelStatus as never, listening: panelStatus === "allowed", detail: null });
Bridge.notificationsRecent = async () => ctl.view().recent;
Bridge.notificationsEnable = async () => {
  panelStatus = "allowed";
  State.settings.notificationsEnabled = true;
  ctl.applyStatus({ state: "allowed", listening: true, detail: null });
  syncNotificationsPill();
  render();
  return { state: "allowed", listening: true, detail: null };
};
Bridge.notificationsDisable = async () => {
  State.settings.notificationsEnabled = false;
  panelStatus = "disabled";
  ctl.onSettingsChanged();
  syncNotificationsPill();
  render();
  return { state: "disabled", listening: false, detail: null };
};
Bridge.notificationsDismiss = async (key) => { ctl.removed(key); render(); };
Bridge.notificationsClear = async () => { ctl.cleared(); render(); };
Bridge.notificationsMarkRead = async () => { ctl.markRead(); render(); };
function renderSettings() {
  const css = document.createElement("style");
  css.textContent = settingsCss.replaceAll(":root", ":host") +
    ":host { display:block; font:400 13px/1.45 var(--font); color:var(--ink); }";
  settingsRoot.replaceChildren(css, notificationsSettingsSection({
    getSettings: () => State.settings,
    save: async () => { ctl.onSettingsChanged(); render(); },
  }));
}

function render() {
  while (stage.firstChild) stage.removeChild(stage.firstChild);
  const view = ctl.view();
  stage.append(notificationsPanel({
    recent: view.recent,
    unread: view.unread,
    enabled: State.settings.notificationsEnabled === true,
    status: panelStatus,
    priv: State.settings.notificationsPrivate === true,
  }));
  const owner = engine.owner;
  readout.textContent =
    `recent=${view.recent.length} unread=${view.unread} ` +
    `status=${(view.status?.state ?? panelStatus)} enabled=${State.settings.notificationsEnabled} priv=${State.settings.notificationsPrivate}\n` +
    `owner=${owner.taskId} moment=${owner.moment ? `${owner.moment.kind}:${owner.moment.sourceKey}` : "none"}\n` +
    `mode=${State.mode} paused=${State.paused} approval=${State.pendingApproval ? State.pendingApproval.taskId : "none"} ` +
    `pinned=${State.isPinned} voice=${Voice.state.runtime} panelH=${NOTIFICATIONS_PANEL_H} ` +
    `overflow=${stage.scrollHeight > stage.clientHeight ? "OVERFLOW" : "fits"}`;
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
    clock += 1;
    render();
    renderSettings();
  });
  buttons.append(btn);
}

button("quiet list", () => {
  ctl.added(quietFixture());
  ctl.added(quietFixture());
  ctl.added(quietFixture());
  say("added 3 quiet fixture items");
});
button("VIP moment", () => {
  const v = fixture();
  ctl.added(v);
  say(`VIP added ${v.key}`);
});
button("VIP restore", () => {
  State.pendingApproval = null;
  engine.recompute();
  ctl.pump();
  say("approval cleared, queue pumped for restore");
});
button("approval blocks VIP", () => {
  State.pendingApproval = { requestId: "r", sessionId: "s", tool: "t", command: "c", taskId: "integration_claude" };
  engine.recompute();
  const v = fixture();
  ctl.added(v);
  say(`approval set, VIP ${v.key} must queue, owner=${engine.owner.taskId}`);
});
button("long content", () => {
  ctl.added(fixture({ title: "L".repeat(300), body: "B".repeat(900) }));
  say("added long fixture content, panel must wrap and clamp");
});
button("privacy on", () => {
  State.settings.notificationsPrivate = true;
  ctl.onSettingsChanged();
  say("privacy on: panel hides text");
});
button("privacy off", () => {
  State.settings.notificationsPrivate = false;
  ctl.onSettingsChanged();
  say("privacy off");
});
button("off", () => {
  State.settings.notificationsEnabled = false;
  ctl.onSettingsChanged();
  syncNotificationsPill();
  say("notifications off: content cleared, VIPs withdrawn");
});
button("on", () => {
  State.settings.notificationsEnabled = true;
  syncNotificationsPill();
  say("notifications on");
});
button("denied", () => {
  panelStatus = "denied";
  ctl.applyStatus({ state: "denied", listening: false, detail: "Windows denied notification access." });
  say("status denied: panel shows status, not Nothing yet");
});
button("missing identity", () => {
  panelStatus = "missingIdentity";
  ctl.applyStatus({ state: "missingIdentity", listening: false, detail: "Missing package identity." });
  say("status missingIdentity: panel shows setup hint");
});
button("allowed", () => {
  panelStatus = "allowed";
  ctl.applyStatus({ state: "allowed", listening: true, detail: null });
  say("status allowed");
});
button("clear", () => {
  ctl.cleared();
  say("cleared local list");
});
button("dismiss first", () => {
  const first = ctl.view().recent[0];
  if (first) {
    ctl.removed(first.key);
    say(`dismissed ${first.key}`);
  } else {
    say("nothing to dismiss");
  }
});
button("mark read", () => {
  ctl.markRead();
  say("marked read");
});
button("seed silence", () => {
  const items = [quietFixture(), quietFixture(), fixture()];
  ctl.seed(items);
  say("seeded 3 history items silently: no banner, no count");
});
button("reduced motion", () => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  say(`prefers-reduced-motion=${mq}; panel uses no motion of its own`);
});
button("hidden", () => {
  State.mode = "hidden";
  say("mode hidden: VIP must queue, never reveal");
});
button("compact", () => {
  State.mode = "compact";
  ctl.pump();
  say("mode compact");
});
button("voice busy", () => {
  Voice.state.runtime = "listening";
  say("voice listening: VIP must queue");
});
button("voice idle", () => {
  Voice.state.runtime = "standby";
  ctl.pump();
  say("voice standby");
});

render();
renderSettings();
engine.subscribe(() => { ctl.pump(); render(); });
say("Fixture ready. Buttons drive the real controller and FocusEngine with fixture data.");
