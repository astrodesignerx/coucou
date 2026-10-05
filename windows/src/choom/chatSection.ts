// Chat section: picks the provider (OpenCode Go or the Claude API), stores the
// OpenCode key and picks the OpenCode model.

import { Bridge } from "../core/bridge";
import type { Settings } from "../core/state";
import { clear, h } from "../views/dom";

const OPENCODE_MODELS: [string, string][] = [
  ["qwen3.8-flash", "Qwen3.8 Flash"],
  ["qwen3.8-max", "Qwen3.8 Max"],
  ["qwen3.7-plus", "Qwen3.7 Plus"],
  ["minimax-m3", "MiniMax M3"],
  ["minimax-m2.7", "MiniMax M2.7"],
];

interface ChatSectionOpts {
  getSettings: () => Settings;
  save: () => Promise<void>;
  /** Whether an OpenCode key is stored, so the first paint needs no round trip. */
  hasKey: boolean;
}

export function chatSection(opts: ChatSectionOpts): HTMLElement {
  const dot = h("i", { class: "dot", style: `background:${opts.hasKey ? "#22c55e" : "#f4505e"}` });

  const provider = h("select", {}) as HTMLSelectElement;
  provider.append(
    h("option", { value: "opencode-go", text: "OpenCode Go" }),
    h("option", { value: "anthropic", text: "Claude API" }),
  );
  provider.value = opts.getSettings().chatProvider;

  const field = h("input", {
    type: "password",
    placeholder: opts.hasKey ? "Key stored" : "Paste your key",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  const keyRow = h(
    "div",
    { class: "row" },
    h("label", { text: "OpenCode key" }),
    field,
    saveBtn,
    clearBtn,
  );

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of OPENCODE_MODELS) model.append(h("option", { value: id, text: label }));
  const currentModel = opts.getSettings().opencodeModel;
  if (!OPENCODE_MODELS.some(([id]) => id === currentModel)) {
    model.append(h("option", { value: currentModel, text: currentModel }));
  }
  model.value = currentModel;
  model.addEventListener("change", () => {
    opts.getSettings().opencodeModel = model.value;
    void opts.save();
  });

  const modelRow = h("div", { class: "row" }, h("label", { text: "Model" }), model);

  const hint = h("div", {
    class: "hint",
    text: "Use the API key from your OpenCode Go plan (opencode.ai). Stored in the Windows Credential Manager, never on disk.",
  });

  async function refresh() {
    const present = (await Bridge.secretPresent("opencode-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    field.placeholder = present ? "Key stored" : "Paste your key";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("opencode-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("opencode-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  function updateVisibility() {
    const opencode = opts.getSettings().chatProvider === "opencode-go";
    keyRow.style.display = opencode ? "" : "none";
    modelRow.style.display = opencode ? "" : "none";
    hint.style.display = opencode ? "" : "none";
  }

  provider.addEventListener("change", () => {
    opts.getSettings().chatProvider = provider.value as Settings["chatProvider"];
    updateVisibility();
    void opts.save();
  });

  clearBtn.style.display = opts.hasKey ? "" : "none";
  updateVisibility();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Chat" })),
    h("div", { class: "row" }, h("label", { text: "Provider" }), provider),
    hint,
    keyRow,
    modelRow,
    feedback,
  );
}
