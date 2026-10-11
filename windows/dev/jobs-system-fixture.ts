// Jobs/System fixture: the real production jobsCard, systemCard, rail and
// pill sync, driven by synthetic labeled fixture data only. No Windows API
// access, no model calls, no live data. Served by `npm run dev` at
// /dev/jobs-system-fixture.html, never bundled.

import "../src/style.css";
import "../src/choom/choom.css";
import { State } from "../src/core/state";
import {
  JOBS_ID,
  UTILITY_ID,
  currentSystemMood,
  jobsLiveHeight,
  setPinnedJobId,
  syncUtilityPill,
  systemLiveHeight,
} from "../src/choom/quickAdditions";
import {
  jobsCard,
  systemCard,
  updateJobsCard,
  updateSystemCard,
} from "../src/choom/quickAdditionsSection";
import { buildRail } from "../src/choom/rail";
import { Focus } from "../src/choom/focus";

const wrap = document.getElementById("wrap")!;
const sidebar = document.getElementById("sidebar")!;
const header = document.getElementById("header")!;
const card = document.getElementById("card")!;
const buttons = document.getElementById("buttons")!;
const readout = document.getElementById("readout")!;
const logEl = document.getElementById("log")!;

function say(line: string) {
  logEl.textContent += line + "\n";
}

let n = 0;
function fixtureJob(state: "working" | "thinking" | "idle" | "finished" = "working") {
  n += 1;
  return {
    id: `agent_fixture_${n}`,
    name: `Fixture job ${n}`,
    color: "#7BA7D9",
    state,
    stepIndex: 0,
    steps: [`Fixture step ${n}`],
    source: "agent" as const,
    isIntegration: false,
    pillBadge: null as null,
  };
}

// Production state wiring with fixture jobs only.
State.tasks = [
  { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  fixtureJob("working"),
  fixtureJob("thinking"),
  fixtureJob("finished"),
];
State.focusId = JOBS_ID;
State.mode = "expanded";
State.view = "overview";
State.paused = false;
State.settings.jobRadar = true;
State.settings.pcVitals = true;
State.settings.batteryMonitor = true;
State.integrations[UTILITY_ID] = {
  data: {
    vitals: { cpuPercent: 12, memUsedBytes: 8_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 50, unavailable: null },
    battery: { hasBattery: true, percent: 82, charging: false, acOnline: false, timeSecs: 3600, state: "discharging", error: null },
  },
  error: null,
  loaded: true,
  configured: true,
};
syncUtilityPill();
State.setFocus(JOBS_ID);

const rail = buildRail({ setFocus: (id) => State.setFocus(id) });
sidebar.append(rail.el);

let cardKey = "";
function render() {
  rail.sync();
  const task = State.focusTask;
  const name = task?.name ?? "Choom";
  header.textContent = `Header: ${name} (Fixture)`;
  const key = task?.id ?? "none";
  if (key !== cardKey) {
    cardKey = key;
    while (card.firstChild) card.removeChild(card.firstChild);
    if (key === JOBS_ID) card.append(jobsCard({ openSession: (id) => State.setFocus(id) }));
    else if (key === UTILITY_ID) card.append(systemCard());
    else card.textContent = "Fixture: select Jobs or System in the sidebar.";
  } else {
    if (key === JOBS_ID) updateJobsCard(card.firstElementChild as HTMLElement | null, { openSession: (id) => State.setFocus(id) });
    else if (key === UTILITY_ID) updateSystemCard(card.firstElementChild as HTMLElement | null);
  }
  const tabs = card.querySelector(".sys-tabs, .sys-tab");
  const auto = card.querySelector(".sys-auto");
  readout.textContent =
    `focus=${State.focusId} header=${name} jobsH=${jobsLiveHeight()} systemH=${systemLiveHeight()} mood=${currentSystemMood()}\n` +
    `innerTabs=${tabs ? "PRESENT (bad)" : "absent (good)"} auto=${auto ? auto.textContent : "absent"}\n` +
    `overflow=${card.scrollHeight > card.clientHeight ? "OVERFLOW" : "fits"} width=${wrap.classList.contains("narrow") ? "narrow 360" : "normal 640"}`;
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

button("Select Jobs", () => State.setFocus(JOBS_ID));
button("Select System", () => State.setFocus(UTILITY_ID));
button("Add fixture job", () => {
  State.tasks.push(fixtureJob("working"));
  State.notify();
  say("added Fixture job");
});
button("Pin first pill", () => {
  const next = State.tasks.find((t) => t.id.startsWith("agent_fixture_"));
  if (next) {
    setPinnedJobId(next.id);
    State.notify();
    say(`pinned ${next.id}: pin must survive updates`);
  }
});
button("Resume Auto", () => {
  setPinnedJobId(null);
  State.notify();
  say("Auto resumed");
});
button("High load", () => {
  State.integrations[UTILITY_ID] = {
    ...State.integrations[UTILITY_ID],
    data: {
      ...(State.integrations[UTILITY_ID]?.data ?? {}),
      vitals: { cpuPercent: 95, memUsedBytes: 15_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 94, unavailable: null },
    },
  };
  State.notify();
  say("Fixture high load stored under System only");
});
button("Efficient load", () => {
  State.integrations[UTILITY_ID] = {
    ...State.integrations[UTILITY_ID],
    data: {
      ...(State.integrations[UTILITY_ID]?.data ?? {}),
      vitals: { cpuPercent: 10, memUsedBytes: 4_000_000_000, memTotalBytes: 16_000_000_000, memPercent: 25, unavailable: null },
    },
  };
  State.notify();
  say("Fixture efficient load stored");
});
button("Battery low warning", () => {
  Focus.moment({ taskId: UTILITY_ID, kind: "warning", line1: "Battery at 19% (Fixture)", line2: "Running on battery", ms: 5000 });
  say("System warning moment queued");
});
button("Narrow 360", () => {
  wrap.classList.add("narrow");
  say("narrow width: sidebar mascots, hover names, no clipping");
});
button("Normal 640", () => {
  wrap.classList.remove("narrow");
  say("normal width");
});
button("Reduced motion", () => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  say(`prefers-reduced-motion=${mq}; card motion rests under reduced motion`);
});
button("Hidden", () => {
  State.mode = "hidden";
  say("mode hidden: animations pause, no continuous work");
});
button("Expanded", () => {
  State.mode = "expanded";
  State.notify();
  say("mode expanded");
});

State.subscribe(render);
render();
say("Fixture ready. Real Jobs/System cards with fixture data. Open via npm run dev.");
