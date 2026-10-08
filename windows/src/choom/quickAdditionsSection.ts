// System card and settings section. The card reuses the integration card
// classes, so it reads like every other card. One Jobs, PC and Battery
// selector lives inside the single card instead of three rail entries. No
// nested scrolling: rows are capped by the radar limit of four.
//
// The card is built once and updated in place, so live readings never steal
// keyboard focus from the tabs, rows or refresh buttons.

import { h, dot } from "../views/dom";
import { State, type Settings } from "../core/state";
import {
  UTILITY_COLOR,
  batteryViewState,
  formatBatteryTime,
  formatBytes,
  formatPct1,
  getUtilityTab,
  jobRadarRows,
  refreshBatteryNow,
  refreshVitalsNow,
  setUtilityTab,
  type BatteryReading,
  type JobRow,
  type UtilityTab,
  type VitalsReading,
} from "./quickAdditions";

const TABS: { id: UtilityTab; label: string }[] = [
  { id: "jobs", label: "Jobs" },
  { id: "pc", label: "PC" },
  { id: "battery", label: "Battery" },
];

const STATUS_LABELS: Record<string, string> = {
  approval: "Needs approval",
  working: "Working",
  thinking: "Thinking",
  searching: "Searching",
  error: "Error",
  finished: "Finished",
  idle: "Idle",
};

const TRACKING_COPY =
  "Live sessions seen through hooks: Claude Code, Codex and OpenCode. Tasks without hooks never appear here.";
const RADAR_OFF_COPY = "Job radar is off. Turn it on in Settings to see live sessions here.";

export interface UtilityCardOpts {
  openSession: (id: string) => void;
}

const updaters = new WeakMap<HTMLElement, (opts: UtilityCardOpts) => void>();

function hint(text: string): HTMLElement {
  return h("div", { class: "qa-hint", text });
}

function readVitals(): VitalsReading | null {
  const data = State.integrations.utility_system?.data as
    | { vitals?: VitalsReading }
    | undefined;
  return data?.vitals ?? null;
}

function readBattery(): BatteryReading | null {
  const data = State.integrations.utility_system?.data as
    | { battery?: BatteryReading }
    | undefined;
  return data?.battery ?? null;
}

function jobButton(row: JobRow, openSession: (id: string) => void): HTMLElement {
  const label = STATUS_LABELS[row.status] ?? row.status;
  const accent = row.status === "error" ? "#F4505E" : row.color;
  const btn = h(
    "button",
    {
      class: "int-row qa-row",
      title: row.detail ? `${row.name}: ${row.detail}` : `${row.name}: ${label}`,
      onclick: () => openSession(row.id),
    },
    dot(accent, 5),
    h("span", { class: "int-name", text: row.name }),
    h("span", { class: "int-ago", text: label }),
  );
  return btn;
}

interface JobsPanel {
  el: HTMLElement;
  update: (opts: UtilityCardOpts) => void;
}

function buildJobsPanel(): JobsPanel {
  const el = h("div", { class: "qa-body", role: "tabpanel", id: "qa-panel-jobs" });
  const hintEl = hint(TRACKING_COPY);
  hintEl.id = "qa-hint-jobs";
  const list = h("div", { class: "int-rows tight" });
  const empty = h("div", { class: "int-status" }, h("span", { text: "No tracked jobs right now." }));
  el.append(hintEl, list, empty);
  const buttons = new Map<string, HTMLElement>();
  let lastSig = "";
  const update = (opts: UtilityCardOpts) => {
    const off = State.settings.jobRadar === false;
    hintEl.textContent = off ? RADAR_OFF_COPY : TRACKING_COPY;
    const entries = off ? [] : jobRadarRows(State.tasks).slice(0, 4);
    const sig = entries.map((r) => `${r.id}|${r.status}|${r.detail}`).join("~");
    empty.style.display = entries.length === 0 ? "" : "none";
    if (sig === lastSig) return;
    lastSig = sig;
    const wanted = new Set(entries.map((r) => r.id));
    for (const [id, btn] of buttons) {
      if (!wanted.has(id)) {
        btn.remove();
        buttons.delete(id);
      }
    }
    for (const row of entries) {
      let btn = buttons.get(row.id);
      if (!btn) {
        btn = jobButton(row, opts.openSession);
        buttons.set(row.id, btn);
      } else {
        const label = STATUS_LABELS[row.status] ?? row.status;
        const statusEl = btn.querySelector(".int-ago");
        if (statusEl) statusEl.textContent = label;
        btn.title = row.detail ? `${row.name}: ${row.detail}` : `${row.name}: ${label}`;
      }
      list.append(btn);
    }
  };
  return { el, update };
}

interface LivePanel {
  el: HTMLElement;
  update: () => void;
}

function buildPcPanel(): LivePanel {
  const el = h("div", { class: "qa-body", role: "tabpanel", id: "qa-panel-pc" });
  const offHint = hint("PC monitoring is off. Turn it on in Settings.");
  const live = h("div", { class: "int-rows tight" });
  const cpuValue = h("span", { class: "int-amount", text: "Starting..." });
  const memValue = h("span", { class: "int-amount", text: "Starting..." });
  live.append(
    h("div", { class: "int-row" }, dot("#60A5FA", 5),
      h("span", { class: "int-name", text: "CPU" }), cpuValue),
    h("div", { class: "int-row" }, dot("#22C55E", 5),
      h("span", { class: "int-name", text: "Memory" }), memValue),
  );
  const note = hint("Totals for the whole PC. A high total does not say which app causes it.");
  const unavailable = hint("");
  const actions = h("div", { class: "int-actions" },
    h("button", { class: "link-btn", text: "Refresh", onclick: () => refreshVitalsNow() }));
  el.append(offHint, live, note, unavailable, actions);
  const update = () => {
    const off = State.settings.pcVitals === false;
    offHint.style.display = off ? "" : "none";
    live.style.display = off ? "none" : "";
    note.style.display = off ? "none" : "";
    actions.style.display = off ? "none" : "";
    unavailable.style.display = "none";
    if (off) return;
    const vitals = readVitals();
    if (!vitals) {
      cpuValue.textContent = "Starting...";
      memValue.textContent = "Starting...";
      return;
    }
    cpuValue.textContent = vitals.cpuPercent == null
      ? (vitals.unavailable ? "Unavailable" : "Starting...")
      : formatPct1(vitals.cpuPercent);
    memValue.textContent = vitals.memPercent == null
      ? (vitals.unavailable ? "Unavailable" : "Starting...")
      : `${formatBytes(vitals.memUsedBytes)} of ${formatBytes(vitals.memTotalBytes)} (${formatPct1(vitals.memPercent)})`;
    if (vitals.unavailable) {
      unavailable.textContent = vitals.unavailable;
      unavailable.style.display = "";
    }
  };
  return { el, update };
}

function buildBatteryPanel(): LivePanel {
  const el = h("div", { class: "qa-body", role: "tabpanel", id: "qa-panel-battery" });
  const offHint = hint("Battery monitoring is off. Turn it on in Settings.");
  const stateLine = h("div", { class: "int-status" }, h("span", { text: "Starting..." }));
  const live = h("div", { class: "int-rows tight" });
  const pctValue = h("span", { class: "int-amount", text: "Unknown" });
  const powerName = h("span", { class: "int-name", text: "Power state unknown" });
  const timeValue = h("span", { class: "int-ago", text: "Time remaining unknown" });
  live.append(
    h("div", { class: "int-row" }, dot("#EAB308", 5),
      h("span", { class: "int-name", text: "Charge" }), pctValue),
    h("div", { class: "int-row" }, dot("#8E939C", 5), powerName, timeValue),
  );
  const actions = h("div", { class: "int-actions" },
    h("button", { class: "link-btn", text: "Refresh", onclick: () => refreshBatteryNow() }));
  el.append(offHint, stateLine, live, actions);
  const setStateLine = (text: string) => {
    const span = stateLine.querySelector("span");
    if (span) span.textContent = text;
  };
  const update = () => {
    const view = batteryViewState(readBattery(), State.settings.batteryMonitor !== false);
    offHint.style.display = view === "off" ? "" : "none";
    stateLine.style.display = view === "live" ? "none" : "";
    live.style.display = view === "live" ? "" : "none";
    actions.style.display = view === "live" ? "" : "none";
    if (view === "live") {
      const battery = readBattery();
      if (!battery) return;
      pctValue.textContent = battery.percent == null ? "Unknown" : `${battery.percent}%`;
      powerName.textContent = battery.charging === true
        ? "Charging"
        : battery.acOnline === true
          ? "Plugged in"
          : battery.acOnline === false
            ? "On battery"
            : "Power state unknown";
      timeValue.textContent = formatBatteryTime(battery.timeSecs) ?? "Time remaining unknown";
      return;
    }
    if (view === "off") setStateLine("");
    else if (view === "starting") setStateLine("Starting...");
    else if (view === "error") setStateLine("Battery status is unavailable right now.");
    else if (view === "unavailable") setStateLine("Battery status is not available on this system.");
    else if (view === "unknown") setStateLine("Battery status is unknown.");
    else setStateLine("No battery in this machine.");
  };
  return { el, update };
}

/** The System card: header, tab selector, then the selected panel. Built once
 * and updated in place, so live readings never move keyboard focus. */
export function utilityCard(opts: UtilityCardOpts): HTMLElement {
  const tabsEl = h("div", { class: "qa-tabs", role: "tablist" });
  const tabBtns = new Map<UtilityTab, HTMLElement>();
  for (const tab of TABS) {
    const btn = h("button", {
      class: "qa-tab",
      role: "tab",
      id: `qa-tab-${tab.id}`,
      text: tab.label,
      onclick: () => {
        if (getUtilityTab() !== tab.id) {
          setUtilityTab(tab.id);
          State.notify();
        }
      },
    });
    btn.setAttribute("aria-controls", `qa-panel-${tab.id}`);
    tabBtns.set(tab.id, btn);
    tabsEl.append(btn);
  }
  const jobs = buildJobsPanel();
  const pc = buildPcPanel();
  const battery = buildBatteryPanel();
  jobs.el.setAttribute("aria-labelledby", "qa-tab-jobs");
  pc.el.setAttribute("aria-labelledby", "qa-tab-pc");
  battery.el.setAttribute("aria-labelledby", "qa-tab-battery");

  const update = (opts: UtilityCardOpts) => {
    const selected = getUtilityTab();
    for (const tab of TABS) {
      const btn = tabBtns.get(tab.id);
      if (!btn) continue;
      const on = tab.id === selected;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    jobs.el.hidden = selected !== "jobs";
    pc.el.hidden = selected !== "pc";
    battery.el.hidden = selected !== "battery";
    if (selected === "pc") pc.update();
    else if (selected === "battery") battery.update();
    else jobs.update(opts);
  };

  const root = h(
    "div",
    { class: "int-card" },
    h("div", { class: "int-head" }, dot(UTILITY_COLOR, 7), h("b", { text: "System" }), h("span", { text: "Utilities" })),
    tabsEl,
    jobs.el,
    pc.el,
    battery.el,
  );
  updaters.set(root, update);
  update(opts);
  return root;
}

/**
 * Refreshes the mounted System card in place. Same shape as the player card
 * updater: data changes flow through, focused tabs, rows and buttons stay put.
 */
export function updateUtilityCard(el: HTMLElement | null, opts: UtilityCardOpts): void {
  if (!el) return;
  updaters.get(el)?.(opts);
}

// Settings section

interface QuickSettingsOpts {
  getSettings: () => Settings;
  save: () => Promise<void>;
}

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

export function quickAdditionsSettingsSection(opts: QuickSettingsOpts): HTMLElement {
  const settings = () => opts.getSettings();
  const radar = toggle(settings().jobRadar !== false, (v) => {
    settings().jobRadar = v;
    void opts.save();
  });
  const vitals = toggle(settings().pcVitals !== false, (v) => {
    settings().pcVitals = v;
    void opts.save();
  });
  const vitalsWarn = toggle(settings().vitalsWarnings !== false, (v) => {
    settings().vitalsWarnings = v;
    void opts.save();
  });
  const battery = toggle(settings().batteryMonitor !== false, (v) => {
    settings().batteryMonitor = v;
    void opts.save();
  });
  const batteryWarn = toggle(settings().batteryWarnings !== false, (v) => {
    settings().batteryWarnings = v;
    void opts.save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("i", { class: "dot", style: "background:#8E939C" }), h("span", { text: "System" })),
    h("div", {
      class: "hint",
      text: "A quiet System entry lists live code sessions, total PC load and battery state. Warnings are calm and rare, and sampling only runs while the island is visible.",
    }),
    h("div", { class: "row" }, h("label", { text: "Job radar" }), radar),
    h("div", { class: "row" }, h("label", { text: "PC monitoring" }), vitals),
    h("div", { class: "row" }, h("label", { text: "Warn on sustained high load" }), vitalsWarn),
    h("div", { class: "row" }, h("label", { text: "Battery monitoring" }), battery),
    h("div", { class: "row" }, h("label", { text: "Warn on low battery" }), batteryWarn),
  );
}
