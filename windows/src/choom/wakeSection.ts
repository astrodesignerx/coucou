// Waking Choom section: how wide the invisible wake strip is, how long the
// cursor must rest on it, and whether full-screen apps keep the island hidden.

import type { Settings } from "../core/state";
import { h } from "../views/dom";

const STRIP_WIDTHS: [number, string][] = [
  [160, "Narrow"],
  [240, "Normal"],
  [360, "Wide"],
  [480, "Extra wide"],
];

const DWELLS: [number, string][] = [
  [0, "Instant"],
  [150, "Short (150 ms)"],
  [300, "Medium (300 ms)"],
  [500, "Long (500 ms)"],
];

interface WakeSectionOpts {
  getSettings: () => Settings;
  save: () => Promise<void>;
}

/** Same switch as the settings window's, kept here so this file stays whole. */
function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** A select whose stored value may be one the list does not offer. */
function valueSelect(options: [number, string][], current: number): HTMLSelectElement {
  const select = h("select", {}) as HTMLSelectElement;
  for (const [value, label] of options) {
    select.append(h("option", { value: String(value), text: label }));
  }
  if (!options.some(([value]) => value === current)) {
    select.append(h("option", { value: String(current), text: String(current) }));
  }
  select.value = String(current);
  return select;
}

export function wakeSection(opts: WakeSectionOpts): HTMLElement {
  const width = valueSelect(STRIP_WIDTHS, opts.getSettings().wakeStripWidth);
  width.addEventListener("change", () => {
    opts.getSettings().wakeStripWidth = Number(width.value);
    void opts.save();
  });

  const dwell = valueSelect(DWELLS, opts.getSettings().wakeDwellMs);
  dwell.addEventListener("change", () => {
    opts.getSettings().wakeDwellMs = Number(dwell.value);
    void opts.save();
  });

  const quiet = toggle(opts.getSettings().wakeQuietFullscreen, (v) => {
    opts.getSettings().wakeQuietFullscreen = v;
    void opts.save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Waking Choom" })),
    h("div", {
      class: "hint",
      text: "An invisible strip at the top of the screen wakes Choom when the cursor rests on it. A held mouse button never wakes it.",
    }),
    h("div", { class: "row" }, h("label", { text: "Strip width" }), width),
    h("div", { class: "row" }, h("label", { text: "Hover delay" }), dwell),
    h("div", { class: "row" }, h("label", { text: "Stay hidden in full-screen apps" }), quiet),
  );
}
