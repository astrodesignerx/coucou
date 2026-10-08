// System card and settings section. The card reuses the integration card
// classes, so it reads like every other card. One Jobs, PC and Battery
// selector lives inside the single card instead of three rail entries. No
// nested scrolling: rows are capped by the radar limit of four.

import { h, dot } from "../views/dom";
import { State, type Settings } from "../core/state";
import {
  UTILITY_COLOR,
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

function jobRows(openSession: (id: string) => void): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  const entries = jobRadarRows(State.tasks);
  if (entries.length === 0) {
    rows.append(h("div", { class: "int-status" }, h("span", { text: "No tracked jobs right now." })));
  }
  for (const row of entries.slice(0, 4)) {
    rows.append(jobButton(row, openSession));
  }
  return rows;
}

function jobButton(row: JobRow, openSession: (id: string) => void): HTMLElement {
  const label = STATUS_LABELS[row.status] ?? row.status;
  const accent = row.status === "error" ? "#F4505E" : row.color;
  const btn = h(
    "button",
    {
      class: "int-row qa-row",
      title: `${row.name}: ${label}`,
      onclick: () => openSession(row.id),
    },
    dot(accent, 5),
    h("span", { class: "int-name", text: row.name }),
    h("span", { class: "int-ago", text: label }),
  );
  if (row.detail) btn.title = `${row.name}: ${row.detail}`;
  return btn;
}

function jobsTab(openSession: (id: string) => void): HTMLElement {
  const body = h("div", {});
  if (State.settings.jobRadar === false) {
    body.append(hint("Job radar is off. Turn it on in Settings to see live sessions here."));
    return body;
  }
  body.append(
    hint("Live sessions seen through hooks: Claude Code, Codex and OpenCode. Tasks without hooks never appear here."),
    jobRows(openSession),
  );
  return body;
}

function pcTab(): HTMLElement {
  const body = h("div", {});
  if (State.settings.pcVitals === false) {
    body.append(hint("PC monitoring is off. Turn it on in Settings."));
    return body;
  }
  const vitals = readVitals();
  if (!vitals) {
    body.append(h("div", { class: "int-status" }, h("span", { text: "Starting..." })));
    return body;
  }
  const cpuLine = vitals.cpuPercent == null
    ? (vitals.unavailable ? "Unavailable" : "Starting...")
    : formatPct1(vitals.cpuPercent);
  const memLine = vitals.memPercent == null
    ? (vitals.unavailable ? "Unavailable" : "Starting...")
    : `${formatBytes(vitals.memUsedBytes)} of ${formatBytes(vitals.memTotalBytes)} (${formatPct1(vitals.memPercent)})`;
  const rows = h("div", { class: "int-rows tight" });
  rows.append(
    h("div", { class: "int-row" }, dot("#60A5FA", 5),
      h("span", { class: "int-name", text: "CPU" }),
      h("span", { class: "int-amount", text: cpuLine })),
    h("div", { class: "int-row" }, dot("#22C55E", 5),
      h("span", { class: "int-name", text: "Memory" }),
      h("span", { class: "int-amount", text: memLine })),
  );
  body.append(rows);
  body.append(hint("Totals for the whole PC. A high total does not say which app causes it."));
  if (vitals.unavailable) body.append(hint(vitals.unavailable));
  body.append(
    h("div", { class: "int-actions" },
      h("button", { class: "link-btn", text: "Refresh", onclick: () => refreshVitalsNow() })),
  );
  return body;
}

function batteryTab(): HTMLElement {
  const body = h("div", {});
  if (State.settings.batteryMonitor === false) {
    body.append(hint("Battery monitoring is off. Turn it on in Settings."));
    return body;
  }
  const battery = readBattery();
  if (!battery) {
    body.append(h("div", { class: "int-status" }, h("span", { text: "Starting..." })));
    return body;
  }
  if (battery.error != null) {
    body.append(h("div", { class: "int-status" }, h("span", { text: "Battery status is unavailable right now." })));
    return body;
  }
  if (battery.state === "unavailable") {
    body.append(h("div", { class: "int-status" }, h("span", { text: "Battery status is not available on this system." })));
    return body;
  }
  if (!battery.hasBattery) {
    body.append(h("div", { class: "int-status" }, h("span", { text: "No battery in this machine." })));
    return body;
  }
  const pctLine = battery.percent == null ? "Unknown" : `${battery.percent}%`;
  const powerLine = battery.charging === true
    ? "Charging"
    : battery.acOnline === true
      ? "Plugged in"
      : battery.acOnline === false
        ? "On battery"
        : "Power state unknown";
  const timeLine = formatBatteryTime(battery.timeSecs) ?? "Time remaining unknown";
  const rows = h("div", { class: "int-rows tight" });
  rows.append(
    h("div", { class: "int-row" }, dot("#EAB308", 5),
      h("span", { class: "int-name", text: "Charge" }),
      h("span", { class: "int-amount", text: pctLine })),
    h("div", { class: "int-row" }, dot("#8E939C", 5),
      h("span", { class: "int-name", text: powerLine }),
      h("span", { class: "int-ago", text: timeLine })),
  );
  body.append(rows);
  body.append(
    h("div", { class: "int-actions" },
      h("button", { class: "link-btn", text: "Refresh", onclick: () => refreshBatteryNow() })),
  );
  return body;
}

/** The System card: header, tab selector, then the selected tab. Selectable
 * on demand from the rail; sampling never moves focus here on its own. */
export function utilityCard(opts: { openSession: (id: string) => void }): HTMLElement {
  const selected = getUtilityTab();
  const tabs = h("div", { class: "qa-tabs" });
  for (const tab of TABS) {
    tabs.append(h("button", {
      class: tab.id === selected ? "qa-tab on" : "qa-tab",
      text: tab.label,
      onclick: () => {
        if (getUtilityTab() !== tab.id) {
          setUtilityTab(tab.id);
          State.notify();
        }
      },
    }));
  }
  const body = h("div", { class: "qa-body" });
  if (selected === "pc") body.append(pcTab());
  else if (selected === "battery") body.append(batteryTab());
  else body.append(jobsTab(opts.openSession));
  return h(
    "div",
    { class: "int-card" },
    h("div", { class: "int-head" }, dot(UTILITY_COLOR, 7), h("b", { text: "System" }), h("span", { text: "Utilities" })),
    tabs,
    body,
  );
}

// -- Settings section ------------------------------------------------------------

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
