// Music section: whether the island shows a pill for whatever is playing on
// the Windows media controls. The setting is read through the getter on every
// handler, like chatSection.

import type { Settings } from "../core/state";
import { h } from "../views/dom";

interface MusicSectionOpts {
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

export function musicSection(opts: MusicSectionOpts): HTMLElement {
  const show = toggle(opts.getSettings().nowPlaying, (value) => {
    opts.getSettings().nowPlaying = value;
    void opts.save();
  });
  const peek = toggle(opts.getSettings().songPeek !== false, (value) => {
    opts.getSettings().songPeek = value;
    void opts.save();
  });
  const moods = toggle(opts.getSettings().musicMoods !== false, (value) => {
    opts.getSettings().musicMoods = value;
    void opts.save();
  });

  return h(
    "section",
    {},
    h(
      "h2",
      {},
      h("i", { class: "dot", style: "background:#1ED760" }),
      h("span", { text: "Music" }),
    ),
    h("div", {
      class: "hint",
      text: "A Music pill shows what any app is playing through the Windows media controls - Spotify, a browser, anything. No account needed, and controls work from the card.",
    }),
    h("div", { class: "row" }, h("label", { text: "Show what's playing" }), show),
    h("div", { class: "row" }, h("label", { text: "Show the song when a track starts" }), peek),
    h("div", { class: "row" }, h("label", { text: "Music moods" }), moods),
  );
}
