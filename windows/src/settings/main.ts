// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import "./hub.css";
import { Bridge, IS_TAURI, onEvent, type JevReceipt } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { chatSection } from "../choom/chatSection";
import { jevSettingsSection, voiceSettingsSection } from "../choom/voiceSection";
import { musicSection } from "../choom/musicSection";
import { wakeSection } from "../choom/wakeSection";
import { quickAdditionsSettingsSection } from "../choom/quickAdditionsSection";
import { notificationsSettingsSection } from "../choom/notificationsSection";
import { opencodeSection } from "../choom/opencodeSection";
import { buildSettingsHub, type HubBuilders } from "./hub";
import { historySection } from "./historySection";
import { privacySection } from "./privacySection";
import {
  apiSection,
  claudeSection,
  codexSection,
  generalSection,
  integrationsSection,
} from "./sharedSections";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let settled = false;

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Fixture preview for browser audit: `settings.html?fixture=settings-hub`.
// Opt-in only, active outside Choom alone, and backed by fictional data so
// no live value is read and no native call is ever made. `history=` picks
// the History state: empty, error or full.
function fixtureMode(): boolean {
  try {
    return !IS_TAURI && new URLSearchParams(window.location.search).get("fixture") === "settings-hub";
  } catch {
    return false;
  }
}

function installFixture(): {
  history: "empty" | "error" | "full";
  motion: "reduced" | "full";
  bench: boolean;
  pushReceipt: (receipt: JevReceipt) => void;
} | null {
  if (!fixtureMode()) return null;
  let history: "empty" | "error" | "full" = "full";
  let motion: "reduced" | "full" = "full";
  let bench = false;
  try {
    const params = new URLSearchParams(window.location.search);
    const asked = params.get("history");
    if (asked === "empty" || asked === "error" || asked === "full") history = asked;
    if (params.get("motion") === "reduced") motion = "reduced";
    bench = params.get("bench") === "events";
  } catch {
    history = "full";
  }
  const bridge = Bridge as unknown as Record<string, (...args: never[]) => unknown>;
  const fixtureSettings: Settings = {
    ...DEFAULT_SETTINGS,
    voiceEnabled: true,
    voiceWakeEnabled: false,
    chatProvider: "opencode-agent",
    jevEnabled: true,
    jevMode: "shadow",
  };
  // Native history is oldest first, so the fixture matches that order and the
  // newest-first preview reads accurately.
  let receipts: JevReceipt[] = [
    { route: "unknown", mode: "shadow", confidence: 0, latencyMs: 2500, fallbackReason: "deadline", atMs: 1760085600000 },
    { route: "options", mode: "shadow", confidence: 0.83, latencyMs: 388, fallbackReason: null, atMs: 1760089200000 },
    { route: "answer", mode: "shadow", confidence: 0.91, latencyMs: 412, fallbackReason: null, atMs: 1760092800000 },
  ];
  const noWrite = () => Promise.resolve();
  bridge.boot = () => Promise.resolve({
    settings: fixtureSettings,
    screen: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    version: "0.0.0-fixture",
    hookPath: "C:\\fixture\\coucou-hook.exe",
    cursorPoll: true,
  });
  bridge.saveSettings = () => Promise.resolve();
  bridge.hooksStatus = () => Promise.resolve({
    installed: false, settingsPath: "C:\\fixture\\settings.json",
    hookPath: "C:\\fixture\\coucou-hook.exe", hookReady: false,
  });
  bridge.codexStatus = () => Promise.resolve({
    installed: false, settingsPath: "C:\\fixture\\hooks.json",
    hookPath: "C:\\fixture\\coucou-hook.exe", hookReady: false,
  });
  bridge.secretPresent = () => Promise.resolve(false);
  bridge.secretSet = () => Promise.resolve();
  bridge.secretClear = () => Promise.resolve();
  bridge.hooksPreview = () => Promise.reject(new Error("fixture has no hook files"));
  bridge.codexPreview = () => Promise.reject(new Error("fixture has no hook files"));
  bridge.opencodeAgentStatus = () => Promise.resolve({ reachable: false, version: null, error: null });
  bridge.opencodeAgentModels = () => Promise.resolve([]);
  bridge.opencodePluginStatus = () => Promise.resolve({ installed: false, outdated: false, path: "" });
  bridge.opencodePluginInstall = () => Promise.reject(new Error("fixture cannot write files"));
  bridge.opencodePluginRemove = () => Promise.reject(new Error("fixture cannot write files"));
  bridge.voiceCapability = () => Promise.resolve({
    supported: true, recognizers: ["Fixture recognizer"], voices: ["Fixture voice"],
    microphone: true, error: null,
  });
  bridge.voiceMemoryList = () => Promise.resolve([]);
  bridge.voiceWakeSet = noWrite;
  bridge.voiceMute = noWrite;
  bridge.jevStatus = () => Promise.resolve({
    enabled: true, mode: "shadow", configured: false,
    model: "jev-1.13-free", endpoint: "https://opencode.ai/zen/v1/systemone",
    threshold: 0.75, deadlineMs: 2500,
  });
  bridge.jevHistory = () => {
    if (history === "error") return Promise.reject(new Error("fixture history failure"));
    if (history === "empty") return Promise.resolve([]);
    return Promise.resolve([...receipts]);
  };
  bridge.jevClearHistory = () => {
    receipts = [];
    return Promise.resolve();
  };
  return {
    history,
    motion,
    bench,
    pushReceipt: (receipt: JevReceipt) => {
      receipts = [...receipts, receipt].slice(-20);
    },
  };
}

async function main() {
  const fixture = installFixture();
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const codex = (await Bridge.codexStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const hasOpencodeKey = (await Bridge.secretPresent("opencode-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  const opts = { getSettings: () => settings, save };
  const stack = (...nodes: HTMLElement[]) =>
    h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...nodes);

  // Every existing section stays reachable exactly once, under one category.
  const builders: HubBuilders = {
    voice: () => voiceSettingsSection(opts),
    brain: () => stack(chatSection({ getSettings: () => settings, save, hasKey: hasOpencodeKey }), jevSettingsSection(opts)),
    history: () => historySection(),
    appearance: () => generalSection(opts),
    music: () => musicSection(opts),
    tools: () => quickAdditionsSettingsSection(opts),
    wake: () => stack(wakeSection(opts), notificationsSettingsSection(opts)),
    connections: () => stack(
      claudeSection(status),
      codexSection(codex),
      apiSection(hasKey, opts),
      opencodeSection(),
      integrationsSection(present, opts),
    ),
    privacy: () => privacySection(),
  };
  const hub = buildSettingsHub(builders);

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Choom" }), h("span", { class: "version", text: version })),
  );
  if (fixture) {
    root.append(h("div", {
      class: "notice warn",
      text: "Fixture preview with fictional data. Nothing here reads or writes your real settings.",
    }));
    if (fixture.motion === "reduced") {
      root.classList.add("fixture-reduced");
      root.append(h("div", {
        class: "notice warn",
        text: "Reduced motion preview. Animations are off; layout and artwork are unchanged.",
      }));
    }
    installEventBench(root, fixture);
  }
  root.append(hub.el);

  function applyExternal(patch: Partial<Settings>): void {
    settings = { ...settings, ...patch };
    hub.syncExternal();
  }

  // Bench-only fictional events for browser audit. Real buttons driving the
  // same merge path as settings-changed, with no native calls anywhere.
  function installEventBench(host: HTMLElement, fx: {
    bench: boolean;
    pushReceipt: (receipt: JevReceipt) => void;
  }): void {
    if (!fx.bench) return;
    const labStatus = h("div", {
      class: "hint",
      role: "status",
      text: "Event bench ready. Buttons apply fictional settings events only.",
    });
    const eventButton = (label: string, patch: Partial<Settings>, done: string) => {
      const btn = h("button", { text: label });
      btn.addEventListener("mousedown", (event) => event.preventDefault());
      btn.addEventListener("click", () => {
        applyExternal(patch);
        labStatus.textContent = done;
      });
      return btn;
    };
    const receiptButton = h("button", { text: "Record fictional receipt" });
    receiptButton.addEventListener("click", () => {
      fx.pushReceipt({
        route: "answer", mode: "shadow", confidence: 0.88, latencyMs: 350,
        fallbackReason: null, atMs: 1760096400000,
      });
      labStatus.textContent = "Recorded a fictional receipt. Open History to see it.";
    });
    host.append(
      h("div", { class: "row" },
        h("label", { text: "Event bench" }),
        eventButton("Simulate voice off", { voiceEnabled: false }, "Applied fictional voice off."),
        eventButton("Simulate voice on", { voiceEnabled: true }, "Applied fictional voice on."),
        eventButton("Simulate remote model", { opencodeModel: "qwen3.8-max" }, "Applied fictional model change."),
        receiptButton,
      ),
      labStatus,
    );
  }

  const stopSettings = onEvent<Settings>("settings-changed", (s) => {
    if (settled) return;
    applyExternal(s);
  });

  // Late arrivals after disposal are dropped, and teardown runs once.
  window.addEventListener("pagehide", () => {
    if (settled) return;
    settled = true;
    hub.dispose();
    void Promise.resolve(stopSettings).then((off) => {
      try {
        off?.();
      } catch {
        // The window is going away: nothing left to unsubscribe.
      }
    });
  });
}

void main();
