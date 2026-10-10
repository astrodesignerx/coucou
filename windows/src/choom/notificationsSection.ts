// Notifications settings section and the island panel. The section is the
// only place that may ask Windows for access: one explicit Enable click runs
// the native request, Disable tears everything down, and the six access
// states each read differently. VIP apps are chosen by stable package
// identity - observed straight from the local cache or typed as a package
// family name - never by display name. The panel lists the bounded recent
// items with local dismiss and clear; it never touches the Windows copy and
// never offers actions the source did not provide.

import type { Settings } from "../core/state";
import type { NotificationItem, NotificationsStatus } from "../core/bridge";
import { Bridge, onEvent } from "../core/bridge";
import { h, clear, dot } from "../views/dom";
import { clampLine } from "./notifications";

interface SectionOpts {
  getSettings: () => Settings;
  save: () => Promise<void>;
}

/** Same switch as the settings window's, kept here so this file stays whole. */
function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on ? "true" : "false" });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", next ? "true" : "false");
    onChange(next);
  });
  return el;
}

const STATE_TEXT: Record<NotificationsStatus["state"], string> = {
  unsupported: "Notification access exists on Windows only.",
  missingIdentity: "Choom needs a one-time Windows setup before notification access can be turned on.",
  disabled: "Off. Turn notifications on to ask Windows for access.",
  unspecified: "Windows has not decided yet. Turn notifications on to ask.",
  denied: "Windows denied access. Only Windows Settings can grant it again.",
  allowed: "Access granted.",
};

/** Observed apps from the local cache: stable id plus display name, bounded. */
function observedApps(items: NotificationItem[]): { appId: string; app: string }[] {
  const seen = new Map<string, { appId: string; app: string }>();
  for (const item of items) {
    const id = item.appId.trim();
    if (id === "" || seen.has(id.toLowerCase())) continue;
    seen.set(id.toLowerCase(), { appId: id, app: item.app });
    if (seen.size >= 12) break;
  }
  return [...seen.values()];
}

/**
 * The Notifications section: status first, then the one Enable click that may
 * prompt, the VIP list by stable identity, and the privacy switch. The
 * settings object is read fresh through the getter on every handler.
 */
export function notificationsSettingsSection(opts: SectionOpts): HTMLElement {
  let status: NotificationsStatus | null = null;
  let recentItems: NotificationItem[] = [];
  let actionError: string | null = null;
  let busy = false;

  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: "Notifications" })), body);

  const refresh = async () => {
    const [s, items] = await Promise.all([
      Bridge.notificationsStatus(),
      Bridge.notificationsRecent(),
    ]);
    if (s) status = s;
    if (items) recentItems = items;
    draw();
  };

  // Keep the section in step with the native probe and the island's events.
  void onEvent<NotificationsStatus>("notifications-status", (s) => {
    status = s;
    draw();
  });
  void onEvent<NotificationItem>("notification-added", () => void refresh());
  void onEvent<{ key: string }>("notification-removed", () => void refresh());

  function draw() {
    clear(body);
    const state = status?.state ?? "unspecified";
    const enabled = opts.getSettings().notificationsEnabled === true;
    body.append(
      h("div", {
        class: "hint",
        text: "Windows lets Choom read your notifications with your permission. VIP apps borrow the pill for four seconds; everything else counts quietly. Choom keeps the list in session memory only: nothing is written to disk, Clear and Dismiss forget the local copy, and turning off or quitting forgets it all. Windows keeps its own copy.",
      }),
      h("div", { class: "row" },
        h("span", { text: STATE_TEXT[state] }),
        status?.detail && state !== "missingIdentity"
          ? h("span", { class: "path", text: status.detail })
          : h("span"),
      ),
    );
    if (actionError) {
      body.append(h("div", { class: "notice err", text: actionError }));
    }

    const actions = h("div", { class: "row" });
    if (!enabled) {
      const enable = h("button", { class: "primary", text: "Turn on notifications…" });
      if (busy || state === "missingIdentity" || state === "unsupported") enable.disabled = true;
      enable.addEventListener("click", () => {
        if (busy) return;
        busy = true;
        actionError = null;
        enable.disabled = true;
        void Bridge.notificationsEnable().then((s) => {
          busy = false;
          if (s) {
            status = s;
            opts.getSettings().notificationsEnabled = s.state === "allowed";
            if (s.state !== "allowed") {
              actionError = s.detail ?? "Windows did not grant access. Try again, or check Windows Settings.";
            }
            void opts.save().catch(() => {
              actionError = "Settings could not be saved. Your choice is on screen only.";
            }).finally(draw);
            return;
          }
          actionError = "Choom could not reach Windows. Try again.";
          draw();
        }).catch(() => {
          busy = false;
          actionError = "Choom could not reach Windows. Try again.";
          draw();
        });
      });
      actions.append(enable);
    } else {
      const disable = h("button", { class: "danger", text: "Turn off notifications" });
      if (busy) disable.disabled = true;
      disable.addEventListener("click", () => {
        if (busy) return;
        busy = true;
        actionError = null;
        disable.disabled = true;
        void Bridge.notificationsDisable().then((s) => {
          busy = false;
          if (s) status = s;
          opts.getSettings().notificationsEnabled = false;
          void opts.save().catch(() => {
            actionError = "Settings could not be saved. Your choice is on screen only.";
          }).finally(draw);
        }).catch(() => {
          busy = false;
          opts.getSettings().notificationsEnabled = false;
          actionError = "The local list was cleared, but Windows did not confirm. Restart Choom if it returns.";
          draw();
        });
      });
      actions.append(disable);
    }
    body.append(actions);
    if (!enabled) return;

    // VIP apps: stable identity only, observed or typed as a package family
    // name. Display names are labels, never match keys.
    const vip = opts.getSettings().notificationsVipApps ?? [];
    const vipList = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
    const renderVip = () => {
      clear(vipList);
      if (vip.length === 0) {
        vipList.append(h("div", { class: "hint", text: "No VIP apps yet. Everything collects as a quiet count." }));
      }
      for (const id of vip) {
        const label = recentItems.find((r) => r.appId.trim().toLowerCase() === id.toLowerCase())?.app ?? id;
        const remove = h("button", { class: "danger", text: "Remove", "aria-label": `Remove VIP ${label}` });
        remove.addEventListener("click", () => {
          opts.getSettings().notificationsVipApps = vip.filter((v) => v !== id);
          void opts.save().then(draw);
        });
        vipList.append(h("div", { class: "row" },
          dot("#80AFE5", 7),
          h("span", { text: label }),
          h("span", { class: "path", text: id }),
          remove,
        ));
      }
      for (const app of observedApps(recentItems)) {
        if (vip.some((v) => v.trim().toLowerCase() === app.appId.toLowerCase())) continue;
        const add = h("button", { text: "Make VIP", "aria-label": `Make ${app.app} a VIP` });
        add.addEventListener("click", () => {
          opts.getSettings().notificationsVipApps = [...vip, app.appId];
          void opts.save().then(draw);
        });
        vipList.append(h("div", { class: "row" },
          h("span", { text: app.app }),
          h("span", { class: "path", text: app.appId }),
          add,
        ));
      }
      const input = h("input", { type: "text", placeholder: "Package family name, e.g. Microsoft.WindowsTerminal_8wekyb3d8bbwe", "aria-label": "Package family name" }) as HTMLInputElement;
      const addTyped = h("button", { text: "Add" });
      addTyped.addEventListener("click", () => {
        const id = input.value.trim();
        if (id === "" || /\s/.test(id)) return;
        if (vip.some((v) => v.trim().toLowerCase() === id.toLowerCase())) return;
        opts.getSettings().notificationsVipApps = [...vip, id];
        void opts.save().then(draw);
      });
      vipList.append(h("div", { class: "row" }, input, addTyped));
    };
    renderVip();
    body.append(h("div", { class: "row" }, h("label", { text: "VIP apps" })), vipList);

    const priv = toggle(opts.getSettings().notificationsPrivate === true, (value) => {
      opts.getSettings().notificationsPrivate = value;
      void opts.save();
    });
    body.append(h("div", { class: "row" },
      h("label", { text: "Hide notification text in the island" }), priv));
  }

  void refresh().then(draw);
  draw();
  return section;
}

// ── Island panel ────────────────────────────────────────────────────────────

/** How many rows the compact panel shows; the rest stay in Windows. */
const PANEL_ROWS = 4;
/** Fixed compact height so the island never jumps between notifications.
 *  Four compact rows, the head and the local actions fit inside it. */
export const NOTIFICATIONS_PANEL_H = 184;

const BLOCKED_PANEL_TEXT: Record<string, string> = {
  unsupported: "Notification access exists on Windows only.",
  missingIdentity: "Choom needs a one-time Windows setup before notification access can be turned on.",
  denied: "Windows denied access. Only Windows Settings can grant it again.",
  disabled: "Notifications are off. Turn them on in Settings.",
  unspecified: "Windows has not decided yet. Turn notifications on in Settings to ask.",
};

export interface NotificationsPanelData {
  recent: NotificationItem[];
  unread: number;
  enabled: boolean;
  status: string;
  priv: boolean;
}

/** Content-only rows: source semantics decide nothing beyond the text we
 *  already clamp. No reply, snooze or retry affordances are offered because
 *  the listener supports none of them. Text wraps inside the 400px compact
 *  panel and clamps to two lines so four rows fit the fixed height. */
export function notificationsPanel(data: NotificationsPanelData): HTMLElement {
  const wrap = h("div", { class: "left-body" });
  if (!data.enabled && (!BLOCKED_PANEL_TEXT[data.status] || data.status === "disabled")) {
    wrap.append(h("div", { class: "int-card n-card" },
      h("div", { class: "int-status n-status" }, h("span", { text: BLOCKED_PANEL_TEXT.disabled })),
    ));
    return wrap;
  }
  const blocked = BLOCKED_PANEL_TEXT[data.status];
  if (blocked && data.status !== "allowed") {
    wrap.append(h("div", { class: "int-card n-card" },
      h("div", { class: "int-head" },
        dot("#80AFE5", 7),
        h("b", { text: "Notifications" }),
      ),
      h("div", { class: "int-status n-status" }, h("span", { text: blocked })),
    ));
    return wrap;
  }
  const head = h("div", { class: "int-head" },
    dot("#80AFE5", 7),
    h("b", { text: "Notifications" }),
    data.unread > 0 ? h("span", { class: "count", text: String(data.unread) }) : h("span"),
  );
  const list = h("div", { class: "n-list", tabindex: 0, "aria-label": "Recent notifications" });
  const items = data.recent.slice(0, PANEL_ROWS);
  if (items.length === 0) {
    list.append(h("div", { class: "n-status" },
      h("span", { text: "Nothing yet. New notifications from your other apps appear here." }),
    ));
  }
  for (const item of items) {
    const title = data.priv ? item.app : clampLine(item.title || item.app, 48);
    const bodyText = data.priv ? "New notification" : clampLine(item.body, 72);
    const row = h("div", { class: "n-row" },
      h("div", { class: "n-text" },
        h("span", { class: "path n-app", text: item.app }),
        h("b", { class: "n-title", text: title }),
        h("span", { class: "n-body", text: bodyText }),
      ),
    );
    const dismiss = h("button", { class: "n-dismiss", text: "Dismiss", "aria-label": `Dismiss notification from ${item.app}` });
    dismiss.addEventListener("click", () => void Bridge.notificationsDismiss(item.key));
    row.append(dismiss);
    list.append(row);
  }
  const actions = h("div", { class: "n-actions" });
  const clearBtn = h("button", { class: "n-mini", text: "Clear all" });
  clearBtn.addEventListener("click", () => void Bridge.notificationsClear());
  actions.append(clearBtn);
  const readBtn = h("button", { class: "n-mini", text: "Mark as read" });
  readBtn.addEventListener("click", () => void Bridge.notificationsMarkRead());
  actions.append(readBtn);
  const card = h("div", { class: "int-card n-card" }, head, list, actions);
  wrap.append(card);
  return wrap;
}
