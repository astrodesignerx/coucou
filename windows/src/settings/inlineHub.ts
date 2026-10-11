// Inline Settings hub: the same production builders the standalone window
// mounts, hosted inside the expanded island instead of a second native window.
// No iframe, no duplicated controls, no version heading: just the hub surface.
// Drafts survive remote refreshes through the hub's reconcile path, and every
// write still goes through the existing explicit-click safeguards (hook diff
// fingerprints, credential-manager secrets).

import "../choom/choom.css";
import "./hub.css";
import "./inlineHub.css";
import { Bridge, onEvent } from "../core/bridge";
import { State } from "../core/state";
import { chatSection } from "../choom/chatSection";
import { jevSettingsSection, voiceSettingsSection } from "../choom/voiceSection";
import { musicSection } from "../choom/musicSection";
import { wakeSection } from "../choom/wakeSection";
import { quickAdditionsSettingsSection } from "../choom/quickAdditionsSection";
import { notificationsSettingsSection } from "../choom/notificationsSection";
import { opencodeSection } from "../choom/opencodeSection";
import { buildSettingsHub, type HubBuilders, type HubCategoryId, type HubHandle } from "./hub";
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

export type { HubCategoryId };

export interface InlineHubHandle extends HubHandle {
  /** True once the live statuses landed and the hub reconciled. */
  ready: () => boolean;
}

const SECRET_KEYS = [
  "stripe-api-key", "github-token", "vercel-token",
  "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
];

/** Mounts the production hub into host. Caller owns height + view routing. */
export function buildInlineHub(host: HTMLElement): InlineHubHandle {
  const hookStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false };
  const codexStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false };
  let hasKey = false;
  let hasOpencodeKey = false;
  const present: Record<string, boolean> = {};
  let live = false;
  let disposed = false;
  let hub: HubHandle | null = null;

  const save = () => Bridge.saveSettings(State.settings).then(() => undefined);
  const opts = { getSettings: () => State.settings, save };
  const stack = (...nodes: HTMLElement[]) =>
    h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...nodes);

  // Builders read the mutable boxes above, so a remote refresh reconciles
  // through the hub instead of rebuilding the caller's tree.
  const builders: HubBuilders = {
    voice: () => voiceSettingsSection(opts),
    brain: () => stack(
      chatSection({ getSettings: () => State.settings, save, hasKey: hasOpencodeKey }),
      jevSettingsSection(opts),
    ),
    history: () => historySection(),
    appearance: () => generalSection(opts),
    music: () => musicSection(opts),
    tools: () => quickAdditionsSettingsSection(opts),
    wake: () => stack(wakeSection(opts), notificationsSettingsSection(opts)),
    connections: () => stack(
      claudeSection(hookStatus),
      codexSection(codexStatus),
      apiSection(hasKey, opts),
      opencodeSection(),
      integrationsSection(present, opts),
    ),
    privacy: () => privacySection(),
  };

  hub = buildSettingsHub(builders);
  host.append(hub.el);

  async function loadLive(): Promise<void> {
    const [hooks, codex, key, opencodeKey] = await Promise.all([
      Bridge.hooksStatus(),
      Bridge.codexStatus(),
      Bridge.secretPresent("anthropic-api-key"),
      Bridge.secretPresent("opencode-api-key"),
    ]);
    if (disposed) return;
    if (hooks) Object.assign(hookStatus, hooks);
    if (codex) Object.assign(codexStatus, codex);
    hasKey = key ?? false;
    hasOpencodeKey = opencodeKey ?? false;
    const flags = await Promise.all(SECRET_KEYS.map((k) => Bridge.secretPresent(k)));
    if (disposed) return;
    SECRET_KEYS.forEach((k, i) => { present[k] = flags[i] ?? false; });
    live = true;
    hub?.syncExternal();
  }

  void loadLive().catch(() => {
    // Offline or plain browser: the hub still works with empty statuses.
    live = true;
  });

  // Remote writes from the standalone window or Rust reconcile in place,
  // preserving focused drafts and caret through the hub's keep-set.
  let stopSettings: (() => void) | null = null;
  void onEvent<Partial<typeof State.settings>>("settings-changed", (patch) => {
    if (disposed) return;
    State.settings = { ...State.settings, ...patch };
    hub?.syncExternal();
  }).then((off) => {
    if (disposed) {
      try { off?.(); } catch { /* already torn down */ }
      return;
    }
    stopSettings = off ?? null;
  }).catch(() => { /* plain browser: no events */ });

  return {
    el: hub.el,
    open: (id: HubCategoryId) => hub?.open(id),
    home: () => hub?.home(),
    syncExternal: () => hub?.syncExternal(),
    current: () => hub?.current() ?? null,
    ready: () => live,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try { stopSettings?.(); } catch { /* teardown only */ }
      stopSettings = null;
      hub?.dispose();
      hub = null;
      clear(host);
    },
  };
}
