// System card: the selected Choom 0.1.4 design. One Jobs lead with up to three
// rectangular task pills, plus CPU, memory and battery mesh rectangles with an
// animated water surface. Real hook, vitals and battery data only, with honest
// empty states and no simulated values.
//
// The card is built once and updated in place, so live readings never steal
// keyboard focus from the tabs, the lead or the pills. Tapping the lead opens
// the existing session card through openSession. Tapping a pill only pins the
// lead; nothing here ever approves anything on its own.
//
// Motion uses the sys tokens in choom.css and stays on transform and opacity.
// Water, pulses and aura floats pause while the island is hidden and rest
// under reduced motion.

import { h, dot } from "../views/dom";
import { State, type Settings } from "../core/state";
import {
  UTILITY_COLOR,
  batteryViewState,
  currentSystemMood,
  formatBatteryTime,
  formatBytes,
  formatPct1,
  getPinnedJobId,
  getUtilityTab,
  jobIsLive,
  jobRadarRows,
  jobSignalColor,
  resolveLeadJob,
  setPinnedJobId,
  setUtilityTab,
  type BatteryReading,
  type JobRow,
  type SystemMood,
  type UtilityTab,
  type VitalsReading,
} from "./quickAdditions";

const TABS: { id: UtilityTab; label: string }[] = [
  { id: "jobs", label: "Jobs" },
  { id: "pc", label: "PC" },
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

const RADAR_OFF_COPY = "Job radar is off. Turn it on in Settings to see live sessions here.";
const NO_JOBS_COPY = "No tracked jobs right now.";
const VITALS_OFF_COPY = "PC monitoring is off. Turn it on in Settings.";
const BATTERY_OFF_COPY = "Battery monitoring is off. Turn it on in Settings.";

export interface UtilityCardOpts {
  openSession: (id: string) => void;
}

const updaters = new WeakMap<HTMLElement, (opts: UtilityCardOpts) => void>();

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

function leadGlyph(status: string): string {
  if (status === "approval") return "!";
  if (status === "finished" || status === "idle") return "\u2713";
  return "\u2197";
}

function leadLabel(row: JobRow): string {
  if (row.detail) return row.detail;
  return STATUS_LABELS[row.status] ?? row.status;
}

const WAVE_PATH =
  "M0 5 Q17.5 0 35 5 T70 5 T105 5 T140 5 T175 5 T210 5 T245 5 T280 5 V12 H0Z";

function waveSvg(back: boolean): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", back ? "water back" : "water");
  svg.setAttribute("viewBox", "0 0 280 12");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", WAVE_PATH);
  svg.append(path);
  return svg;
}

interface MeshTile {
  root: HTMLElement;
  mesh: HTMLElement;
  value: HTMLElement;
  detail: HTMLElement;
}

function buildTile(name: string): MeshTile {
  const mesh = h("div", { class: "sys-mesh" }, waveSvg(true), waveSvg(false));
  const value = h("b", { class: "vl", text: "" });
  const detail = h("small", { class: "dt", text: "" });
  const root = h(
    "div",
    { class: "sys-tile" },
    mesh,
    h("div", { class: "tx" }, h("span", { class: "nm", text: name }), detail),
    value,
  );
  return { root, mesh, value, detail };
}

const CPU_COLORS = ["#123D62", "#397DBA", "#8CCEE9"];
const MEM_COLORS = ["#3D245B", "#8461B0", "#BA9BDA"];
const BATTERY_COLORS = ["#144A3B", "#43A17C", "#9CD8AB"];
const BATTERY_LOW_COLORS = ["#71352E", "#BF6851", "#E9B787"];

function paintMesh(mesh: HTMLElement, level: number | null, colors: readonly string[]): void {
  if (level == null) {
    mesh.style.display = "none";
    return;
  }
  mesh.style.display = "";
  mesh.style.setProperty("--level", `${Math.max(0, Math.min(100, level))}%`);
  mesh.style.setProperty("--deep", colors[0]);
  mesh.style.setProperty("--accent", colors[1]);
  mesh.style.setProperty("--light", colors[2]);
}

function tileTitle(name: string, value: string, detail: string): string {
  return detail ? `${name}: ${value}, ${detail}` : `${name}: ${value}`;
}

interface JobsPanel {
  el: HTMLElement;
  update: (opts: UtilityCardOpts) => void;
}

function buildJobsPanel(): JobsPanel {
  const el = h("div", { class: "sys-panel", role: "tabpanel", id: "sys-panel-jobs" });
  const pinnedNote = h("div", { class: "sys-pinned", text: "Pinned by you" });
  const mark = h("span", { class: "sys-mark", text: "" });
  const name = h("b", { text: "" });
  const detail = h("span", { class: "sys-detail", text: "" });
  const lead = h(
    "button",
    { class: "sys-lead", type: "button" },
    mark,
    h("div", { class: "sys-copy" }, name, detail),
  );
  const pills = h("div", { class: "sys-pills" });
  const empty = h("div", { class: "sys-empty" }, h("span", { text: NO_JOBS_COPY }));
  el.append(pinnedNote, lead, pills, empty);

  const pillBtns = new Map<string, HTMLElement>();
  let leadId = "";

  const update = (opts: UtilityCardOpts) => {
    const off = State.settings.jobRadar === false;
    const entries = off ? [] : jobRadarRows(State.tasks);
    const sel = resolveLeadJob(entries);
    empty.style.display = entries.length === 0 ? "" : "none";
    empty.querySelector("span")!.textContent = off ? RADAR_OFF_COPY : NO_JOBS_COPY;
    pinnedNote.style.display = sel.pinned ? "" : "none";
    lead.style.display = sel.lead ? "" : "none";
    pills.style.display = sel.rest.length === 0 ? "none" : "";
    if (!sel.lead) {
      leadId = "";
      for (const [, btn] of pillBtns) btn.remove();
      pillBtns.clear();
      return;
    }
    const row = sel.lead;
    const signal = jobSignalColor(row.status);
    const live = jobIsLive(row.status);
    leadId = row.id;
    lead.dataset.live = live ? "true" : "false";
    lead.title = `${row.name}: ${leadLabel(row)}`;
    lead.setAttribute("aria-label", `Open ${row.name}, ${leadLabel(row)}`);
    mark.textContent = leadGlyph(row.status);
    mark.style.color = signal;
    mark.style.background = `${signal}20`;
    name.textContent = row.name;
    detail.textContent = leadLabel(row);
    lead.onclick = () => opts.openSession(leadId);

    const wanted = new Set(sel.rest.map((r) => r.id));
    for (const [id, btn] of pillBtns) {
      if (!wanted.has(id)) {
        btn.remove();
        pillBtns.delete(id);
      }
    }
    for (const item of sel.rest) {
      const itemLive = jobIsLive(item.status);
      const itemSignal = jobSignalColor(item.status);
      let btn = pillBtns.get(item.id);
      if (!btn) {
        const label = h("span", { class: "nm", text: item.name });
        btn = h("button", { class: "sys-pill", type: "button" }, label);
        pillBtns.set(item.id, btn);
        pills.append(btn);
      }
      btn.dataset.live = itemLive ? "true" : "false";
      btn.style.setProperty("--signal", itemSignal);
      btn.title = `${item.name}: ${leadLabel(item)}`;
      btn.setAttribute("aria-label", `Pin ${item.name} as lead`);
      const label = btn.querySelector(".nm");
      if (label) label.textContent = item.name;
      btn.onclick = () => {
        setPinnedJobId(item.id);
        State.notify();
      };
    }
  };
  return { el, update };
}

interface PcPanel {
  el: HTMLElement;
  update: () => void;
}

function buildPcPanel(): PcPanel {
  const el = h("div", { class: "sys-panel", role: "tabpanel", id: "sys-panel-pc" });
  const cpu = buildTile("CPU");
  const mem = buildTile("Memory");
  const battery = buildTile("Battery");
  const tiles = h("div", { class: "sys-tiles" }, cpu.root, mem.root, battery.root);
  el.append(tiles);

  const update = () => {
    const vitalsOff = State.settings.pcVitals === false;
    const batteryOff = State.settings.batteryMonitor === false;
    const vitals = vitalsOff ? null : readVitals();
    const cell = batteryOff ? null : readBattery();

    if (!vitals) {
      const reason = vitalsOff ? VITALS_OFF_COPY : "Starting...";
      const missing = vitalsOff ? "Off" : "Starting...";
      const tiles: Array<{ tile: MeshTile; name: string }> = [
        { tile: cpu, name: "CPU" },
        { tile: mem, name: "Memory" },
      ];
      for (const { tile, name } of tiles) {
        tile.root.classList.add("is-flat");
        paintMesh(tile.mesh, null, CPU_COLORS);
        tile.value.textContent = missing;
        tile.detail.textContent = reason;
        tile.root.title = tileTitle(name, missing, reason);
      }
    } else {
      if (vitals.cpuPercent == null) {
        cpu.root.classList.add("is-flat");
        paintMesh(cpu.mesh, null, CPU_COLORS);
        cpu.value.textContent = vitals.unavailable ? "Unavailable" : "Starting...";
        cpu.detail.textContent = vitals.unavailable ?? "First sample calibrates the total.";
      } else {
        cpu.root.classList.remove("is-flat");
        paintMesh(cpu.mesh, vitals.cpuPercent, CPU_COLORS);
        cpu.value.textContent = formatPct1(vitals.cpuPercent);
        cpu.detail.textContent = "Total usage";
      }
      cpu.root.title = tileTitle("CPU", cpu.value.textContent, cpu.detail.textContent);

      if (vitals.memPercent == null) {
        mem.root.classList.add("is-flat");
        paintMesh(mem.mesh, null, MEM_COLORS);
        mem.value.textContent = vitals.unavailable ? "Unavailable" : "Starting...";
        mem.detail.textContent = vitals.unavailable ?? "First sample calibrates the total.";
      } else {
        mem.root.classList.remove("is-flat");
        paintMesh(mem.mesh, vitals.memPercent, MEM_COLORS);
        mem.value.textContent = formatPct1(vitals.memPercent);
        mem.detail.textContent =
          `${formatBytes(vitals.memUsedBytes)} of ${formatBytes(vitals.memTotalBytes)}`;
      }
      mem.root.title = tileTitle("Memory", mem.value.textContent, mem.detail.textContent);
    }

    if (!cell) {
      battery.root.classList.add("is-flat");
      paintMesh(battery.mesh, null, BATTERY_COLORS);
      battery.value.textContent = batteryOff ? "Off" : "Starting...";
      battery.detail.textContent = batteryOff ? BATTERY_OFF_COPY : "Waiting for the first reading.";
      battery.root.title = tileTitle("Battery", battery.value.textContent, battery.detail.textContent);
      return;
    }
    const view = batteryViewState(cell, true);
    if (view !== "live") {
      battery.root.classList.add("is-flat");
      paintMesh(battery.mesh, null, BATTERY_COLORS);
      if (view === "no_battery") {
        battery.value.textContent = "No battery";
        battery.detail.textContent = "This machine reports no battery.";
      } else if (view === "error" || view === "unavailable") {
        battery.value.textContent = "Unavailable";
        battery.detail.textContent = "Battery status is not available right now.";
      } else {
        battery.value.textContent = "Unknown";
        battery.detail.textContent = "Battery status is unknown.";
      }
      battery.root.title = tileTitle("Battery", battery.value.textContent, battery.detail.textContent);
      return;
    }
    const low = (cell.percent ?? 100) <= 20 && cell.charging !== true && cell.acOnline !== true;
    battery.root.classList.remove("is-flat");
    paintMesh(battery.mesh, cell.percent, low ? BATTERY_LOW_COLORS : BATTERY_COLORS);
    battery.value.textContent = cell.percent == null ? "Unknown" : `${cell.percent}%`;
    const state = cell.charging === true
      ? "Charging"
      : cell.acOnline === true
        ? "Plugged in"
        : cell.acOnline === false
          ? "On battery"
          : "Power state unknown";
    const time = formatBatteryTime(cell.timeSecs);
    battery.detail.textContent = time ? `${state}, ${time}` : state;
    battery.root.title = tileTitle("Battery", battery.value.textContent, battery.detail.textContent);
  };
  return { el, update };
}

function auraFor(mood: SystemMood): string {
  if (mood === "efficient") {
    return `<span class="sys-cloud"></span><span class="sys-cloud far"></span>`;
  }
  if (mood === "high") {
    return `<span class="sys-heat">∿∿</span>`;
  }
  return "";
}

/** The System card: header, Auto plus Jobs and PC tabs, then the panel. */
export function utilityCard(opts: UtilityCardOpts): HTMLElement {
  const status = h("span", { text: "Ready" });
  const auto = h("button", {
    class: "sys-auto",
    type: "button",
    text: "Auto",
    title: "Automatic lead. Tapping a task pill pins it until Auto resumes.",
    onclick: () => {
      if (getPinnedJobId() != null) {
        setPinnedJobId(null);
        State.notify();
      }
    },
  });
  const tabsEl = h("div", { class: "sys-tabs", role: "tablist" });
  const tabBtns = new Map<UtilityTab, HTMLElement>();
  for (const tab of TABS) {
    const btn = h("button", {
      class: "sys-tab",
      role: "tab",
      id: `sys-tab-${tab.id}`,
      text: tab.label,
      title: tab.label,
      onclick: () => {
        if (getUtilityTab() !== tab.id) {
          setUtilityTab(tab.id);
          State.notify();
        }
      },
    });
    btn.setAttribute("aria-controls", `sys-panel-${tab.id}`);
    tabBtns.set(tab.id, btn);
    tabsEl.append(btn);
  }
  const jobs = buildJobsPanel();
  const pc = buildPcPanel();
  jobs.el.setAttribute("aria-labelledby", "sys-tab-jobs");
  pc.el.setAttribute("aria-labelledby", "sys-tab-pc");
  const aura = h("div", { class: "sys-aura", html: "" });
  aura.setAttribute("aria-hidden", "true");
  let auraMood: SystemMood | "" = "";

  const update = (opts: UtilityCardOpts) => {
    const selected = getUtilityTab() === "pc" ? "pc" : "jobs";
    for (const tab of TABS) {
      const btn = tabBtns.get(tab.id);
      if (!btn) continue;
      const on = tab.id === selected;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    auto.style.visibility = selected === "jobs" ? "" : "hidden";
    const pinned = getPinnedJobId() != null && selected === "jobs";
    auto.textContent = pinned ? "Resume Auto" : "Auto";
    auto.setAttribute("aria-pressed", pinned ? "true" : "false");
    jobs.el.hidden = selected !== "jobs";
    pc.el.hidden = selected !== "pc";
    if (selected === "pc") pc.update();
    else jobs.update(opts);

    const mood = currentSystemMood();
    status.textContent = mood === "high" ? "Under load" : "Ready";
    if (mood !== auraMood) {
      auraMood = mood;
      aura.innerHTML = auraFor(mood);
    }
  };

  const root = h(
    "div",
    { class: "int-card sys-card" },
    h("div", { class: "int-head" }, dot(UTILITY_COLOR, 7), h("b", { text: "System" }), status),
    h("div", { class: "sys-top" }, auto, tabsEl),
    jobs.el,
    pc.el,
    aura,
  );
  const syncHidden = () => {
    root.classList.toggle("is-hidden", State.mode === "hidden");
  };
  const wrapped = (opts: UtilityCardOpts) => {
    syncHidden();
    update(opts);
  };
  updaters.set(root, wrapped);
  wrapped(opts);
  return root;
}

/**
 * Refreshes the mounted System card in place. Same shape as the player card
 * updater: data changes flow through, focused tabs, lead and pills stay put.
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
