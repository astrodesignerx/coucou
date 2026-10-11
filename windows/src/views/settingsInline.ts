// Island Settings view: the inline hub mounted inside the ordinary expanded
// island card. The mascot keeps its size and left padding, the content drives
// the island height, and leaving the view restores the ordinary island content
// untouched. One hub instance per view: repeated open/close never leaks
// listeners, drafts survive remote refreshes, and Escape returns home.

import { buildInlineHub, type HubCategoryId, type InlineHubHandle } from "../settings/inlineHub";
import { h, clear } from "./dom";
import type { ViewHost } from "./views";

export interface SettingsInlineHost extends ViewHost {
  showHome(): void;
  openCategory(id: HubCategoryId): void;
  disposeInline(): void;
}

let mountedHub: InlineHubHandle | null = null;
let mountedBody: HTMLElement | null = null;

const HOME_H = 248;
const DETAIL_H = 320;
const MIN_H = 232;

/** Island height follows the hub content, clamped to the panel. Measured from
 * the live surface when mounted, with a bounded fallback per state. */
export function settingsInlineHeight(): number {
  const hub = mountedHub;
  const body = mountedBody;
  if (hub && body?.isConnected) {
    const current = hub.current();
    // Detail scrolls internally past this point; home sizes to its tiles.
    const inner = body.querySelector(".hub-surface") as HTMLElement | null;
    const demand = (inner?.scrollHeight ?? 0) + 76;
    if (Number.isFinite(demand) && demand > 0) {
      return Math.min(DETAIL_H, Math.max(MIN_H, Math.ceil(demand)));
    }
    return current ? DETAIL_H : HOME_H;
  }
  return HOME_H;
}

export function buildSettingsInline(onHeightChange: () => void): SettingsInlineHost {
  const mount = h("div", { class: "island-settings" });
  // Mascot column stays clear: same left padding as the other stacked cards.
  const stack = h(
    "div",
    { class: "stack", style: "padding:14px 16px 14px 112px" },
    mount,
  );
  const card = h("div", { class: "card settings-inline-card" }, stack);
  const el = h("div", { class: "view" }, card);

  mountedBody = mount;

  let hub: InlineHubHandle | null = null;
  let notified = false;
  const notifyHeight = () => {
    if (notified) return;
    notified = true;
    requestAnimationFrame(() => {
      notified = false;
      onHeightChange();
    });
  };

  function ensureHub(): InlineHubHandle {
    if (hub) return hub;
    hub = buildInlineHub(mount);
    mountedHub = hub;
    // Category switches change the content height: settle, then measure.
    const surface = hub.el;
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => notifyHeight());
      ro.observe(surface);
      (hub as unknown as { __ro?: ResizeObserver }).__ro = ro;
    }
    // First paint plus the async live-status reconcile both resize.
    notifyHeight();
    window.setTimeout(() => notifyHeight(), 0);
    return hub;
  }

  // Escape steps back to the hub home first; the island's own Escape still
  // collapses from there. Focus-shift policy is untouched.
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && hub?.current()) {
      e.stopPropagation();
      hub.home();
      notifyHeight();
    }
  });

  let lastOn = false;

  return {
    el,
    sync() {
      const on = el.classList.contains("on");
      if (on && !lastOn) {
        ensureHub();
        notifyHeight();
      }
      lastOn = on;
      if (on) ensureHub();
    },
    focus() {
      const h = ensureHub();
      const head = h.el.querySelector(".hub-focus-head h2") as HTMLElement | null;
      (head ?? h.el.querySelector(".hub-tile") as HTMLElement | null)?.focus();
    },
    showHome() {
      ensureHub().home();
      notifyHeight();
    },
    openCategory(id: HubCategoryId) {
      ensureHub().open(id);
      notifyHeight();
    },
    disposeInline() {
      const ro = (hub as unknown as { __ro?: ResizeObserver } | null)?.__ro;
      try { ro?.disconnect(); } catch { /* teardown only */ }
      hub?.dispose();
      hub = null;
      mountedHub = null;
      clear(mount);
    },
  };
}

/** Test hook: forget module mounts without touching the live view. */
export function __resetSettingsInlineForTests(): void {
  mountedHub = null;
  mountedBody = null;
}
