// OpenCode sessions section: installs one plugin file that reports every
// OpenCode session (terminal TUI, OpenChamber) to the island, so it gets the
// same "opencode" pill as Claude Code sessions.

import { Bridge } from "../core/bridge";
import { clear, h } from "../views/dom";

export function opencodeSection(): HTMLElement {
  const dot = h("i", { class: "dot", style: "background:#f4505e" });
  const state = h("div", { class: "hint", text: "Checking..." });
  const path = h("span", { class: "path" });
  const actions = h("div", { class: "row" });
  const feedback = h("div", {});

  async function refresh() {
    const status = await Bridge.opencodePluginStatus();
    const installed = status?.installed ?? false;
    const outdated = status?.outdated ?? false;
    dot.style.background = outdated ? "#f5a524" : installed ? "#22c55e" : "#f4505e";
    state.textContent = outdated ? "Update available" : installed ? "Installed" : "Not installed";
    path.textContent = status?.path ?? "";
    clear(actions);
    if (!installed || outdated) {
      actions.append(h("button", {
        class: "primary",
        text: installed ? "Update plugin" : "Install plugin",
        onclick: () => void apply(true),
      }));
    }
    if (installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Remove",
        onclick: () => void apply(false),
      }));
    }
  }

  async function apply(install: boolean) {
    clear(feedback);
    try {
      if (install) await Bridge.opencodePluginInstall();
      else await Bridge.opencodePluginRemove();
      feedback.append(h("div", {
        class: "notice ok",
        text: install ? "Installed. Restart OpenCode or OpenChamber to load it." : "Removed.",
      }));
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
    }
    await refresh();
  }

  void refresh();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "OpenCode sessions" })),
    state,
    h("div", { class: "row" }, h("label", { text: "Plugin file" }), path),
    actions,
    h("div", {
      class: "hint",
      text: "Reports OpenCode sessions in your terminal or OpenChamber to the island. Restart OpenCode or OpenChamber to load it.",
    }),
    feedback,
  );
}
