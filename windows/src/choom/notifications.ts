// Windows notifications: the controller that turns normalized native events
// into one predictable pill behaviour. VIP apps borrow the pill for four
// seconds through Focus (so approvals, pins, manual choices, pause and
// full-screen quiet all apply unchanged); every other app collects as a
// quiet unread count. Nothing here touches disk, prompts Windows or acts on
// a notification: local dismiss and clear only change what Choom shows.
//
// Identity is the package family name (appId), never the display name and
// never a truncated prefix, so two apps that display the same name cannot
// borrow each other's VIP rank. The controller is dependency-injected and
// unit tested without Tauri, DOM or timers of its own; Focus owns every
// display timer.

import { State } from "../core/state";
import { Bridge, onEvent } from "../core/bridge";
import type { NotificationItem, NotificationsStatus } from "../core/bridge";
import { Focus } from "./focus";
import type { Moment } from "./focus";
import { Voice } from "./voice";

/** The quiet Notifications pill. Stable once created, never renamed. */
export const NOTIFICATIONS_ID = "utility_notifications";
export const NOTIFICATIONS_NAME = "Notifications";
export const NOTIFICATIONS_COLOR = "#80AFE5";

/** VIP display time, measured from the moment Focus actually shows it. */
export const VIP_MOMENT_MS = 4000;

/** Bounded local list; mirrors the native cache so the frontend cannot grow. */
export const MAX_RECENT = 60;
/** Keys remembered for dedup after they left the recent list. */
export const MAX_SEEN = 240;
/** VIP items may queue while an approval or pin blocks the pill. */
export const MAX_VIP_QUEUE = 3;

/** One line of pill text is clamped for readability, with an ellipsis. */
export function clampLine(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  let cut = Math.max(0, max - 1);
  const last = trimmed.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${trimmed.slice(0, cut)}…`;
}

/**
 * VIP match on stable identity only: the full package family name, compared
 * case-insensitively. An item with no readable identity is never VIP, and a
 * configured entry never matches a display name or a truncated prefix.
 */
export function isVipApp(appId: string, vipApps: string[]): boolean {
  const id = appId.trim().toLowerCase();
  if (id === "") return false;
  // A package family name never contains whitespace; a configured display
  // name almost always does, so name-shaped entries never grant VIP rank.
  if (/\s/.test(id)) return false;
  return vipApps.some((v) => v.trim().toLowerCase() === id);
}

/**
 * The two pill lines for a VIP moment. Private mode hides all notification
 * text: the app name still reads, the content never does. Long text is
 * clamped so the pill stays the pill.
 */
export function vipLines(
  item: NotificationItem,
  priv: boolean,
): [string, string] {
  const app = clampLine(item.app || "Notification", 40);
  if (priv) return [app, "New notification"];
  const title = clampLine(item.title, 48);
  const body = clampLine(item.body, 64);
  return [title || app, body || app];
}

/** Gated the same way vitals warnings are, plus the island must be able to
 *  show the full four second moment: nothing borrows the pill while a
 *  permission card, pin, file drop or pause owns the moment slot, never
 *  while the microphone owns a voice turn, and never while hidden, paused
 *  or expanded (an expanded card already shows everything, a hidden island
 *  must not reveal for a notification). Quiet counts keep working while
 *  blocked; only the VIP borrow waits. */
export function canPresentNow(): boolean {
  if (State.paused) return false;
  if (State.mode === "hidden") return false;
  if (State.mode === "expanded") return false;
  if (State.pendingApproval) return false;
  if (State.isPinned) return false;
  if (State.droppedFile) return false;
  const rt = Voice.state.runtime;
  if (rt === "listening" || rt === "processing" || rt === "working" || rt === "speaking") return false;
  return true;
}

/** The bounded session memory the controller keeps in the frontend. */
export interface NotificationViewState {
  /** Newest first, at most MAX_RECENT. */
  recent: NotificationItem[];
  /** Quiet items not yet marked read locally. */
  unread: number;
  /** What the native probe last reported; null before the first answer. */
  status: { state: string; listening: boolean; detail: string | null } | null;
}

/** Injected world, so tests drive the controller without Tauri or the DOM. */
export interface NotificationsWiring {
  /** Settings are read fresh, like the other controllers. */
  isEnabled: () => boolean;
  vipApps: () => string[];
  isPrivate: () => boolean;
  /** The Focus hook: defaults to the shared engine. */
  present?: (m: Moment) => void;
  withdraw?: (taskId: string, sourceKey?: string) => void;
  /** Whether an approval, pin, drop or pause currently blocks the pill. */
  canPresent?: () => boolean;
  isPresenting?: () => boolean;
  /** Pushes the quiet count into State and notifies the island. */
  onUnread?: (unread: number) => void;
  now?: () => number;
}

/**
 * Pure event logic: dedup, quiet counting, VIP queueing and expiry. The one
 * timer is the VIP expiry fallback; Focus owns the real four-second display
 * clock, which starts only when the moment actually shows.
 */
export class NotificationsController {
  private recent: NotificationItem[] = [];
  /** Insertion-ordered dedup memory, oldest evicted first. */
  private seen = new Set<string>();
  /** Quiet items not yet read locally. Keys, so removals can decrement.
   *  Always bounded to the retained recent list, so eviction drops counts. */
  private unreadKeys = new Set<string>();
  /** VIP items waiting for the pill while blocked. */
  private vipQueue: NotificationItem[] = [];
  private status: NotificationViewState["status"] = null;
  private disposed = false;
  /** True while pump is presenting, so a nested State.notify cannot forward
   *  the whole queue at once through Focus per-task replacement. */
  private pumping = false;
  private lastPrivate: boolean;
  private readonly present: (m: Moment) => void;
  private readonly withdraw: (taskId: string, sourceKey?: string) => void;
  private readonly canPresent: () => boolean;
  private readonly onUnread: (unread: number) => void;

  constructor(private readonly w: NotificationsWiring) {
    this.lastPrivate = w.isPrivate();
    this.present = w.present ?? ((m) => Focus.moment(m));
    this.withdraw = w.withdraw ?? ((taskId, key) => Focus.withdraw(taskId, key));
    this.canPresent = w.canPresent ?? canPresentNow;
    this.onUnread = w.onUnread ?? ((n) => {
      State.notificationsUnread = n;
      State.notify();
    });
  }

  view(): NotificationViewState {
    return { recent: [...this.recent], unread: this.unreadKeys.size, status: this.status };
  }

  applyStatus(status: NotificationViewState["status"]): void {
    if (this.disposed) return;
    this.status = status;
    if (status && status.state !== "allowed") this.teardownContent();
  }

  /**
   * Silent seed for the initial Bridge.notificationsRecent history.
   * Old snapshots populate the list and the dedup memory but never banner,
   * never count and never queue a VIP moment.
   */
  seed(items: NotificationItem[]): void {
    if (this.disposed) return;
    if (!this.w.isEnabled()) return;
    if (!items || items.length === 0) return;
    const sorted = [...items]
      .filter((i) => i && i.key !== "")
      .sort((a, b) => b.createdMs - a.createdMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (sorted.length === 0) return;
    const byKey = new Map<string, NotificationItem>();
    for (const r of this.recent) byKey.set(r.key, r);
    for (const it of sorted) {
      if (!byKey.has(it.key)) byKey.set(it.key, it);
    }
    const oldestFirst = [...sorted].reverse();
    for (const it of oldestFirst) this.remember(it.key);
    const merged = [...byKey.values()]
      .sort((a, b) => b.createdMs - a.createdMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, MAX_RECENT);
    const changed = merged.length !== this.recent.length ||
      merged.some((m, i) => m.key !== this.recent[i]?.key);
    this.recent = merged;
    if (this.pruneUnread()) this.onUnread(this.unreadKeys.size);
    if (changed) State.notify();
  }

  /** Settings or a blocking status turned: refresh the teardown state. */
  onSettingsChanged(): void {
    if (this.disposed) return;
    const priv = this.w.isPrivate();
    if (priv !== this.lastPrivate) {
      this.lastPrivate = priv;
      this.withdraw(NOTIFICATIONS_ID);
    }
    if (!this.w.isEnabled()) {
      this.teardownContent();
      return;
    }
    if (this.status && this.status.state !== "allowed") this.teardownContent();
  }

  /**
   * A new notification. A key already seen never re-banners and never moves
   * the quiet count, so oversized re-read snapshots and duplicate events
   * stay silent. VIP items borrow the pill for four seconds; everything
   * else collects as a quiet unread count.
   */
  added(item: NotificationItem): void {
    if (this.disposed || !this.w.isEnabled()) return;
    if (this.status && this.status.state !== "allowed") return;
    const key = item.key;
    if (key === "") return;
    if (this.seen.has(key)) {
      // Already delivered this session: refresh the text in place when still
      // retained, and never re-banner or move the quiet count. Evicted or
      // locally dismissed keys stay out, so oversized re-read snapshots stay
      // silent instead of churning the list.
      const at = this.recent.findIndex((r) => r.key === key);
      if (at < 0) return;
      this.recent = [item, ...this.recent.filter((r) => r.key !== key)].slice(0, MAX_RECENT);
      const qi = this.vipQueue.findIndex((q) => q.key === key);
      if (qi >= 0) this.vipQueue[qi] = item;
      if (this.pruneUnread()) this.onUnread(this.unreadKeys.size);
      State.notify();
      return;
    }
    this.remember(key);
    this.recent = [item, ...this.recent.filter((r) => r.key !== key)].slice(0, MAX_RECENT);
    const pruned = this.pruneUnread();
    if (isVipApp(item.appId, this.w.vipApps())) {
      if (pruned) this.onUnread(this.unreadKeys.size);
      this.queueVip(item);
      State.notify();
      return;
    }
    // Quiet item: count it once, present nothing.
    if (!this.unreadKeys.has(key)) {
      this.unreadKeys.add(key);
      this.pruneUnread();
      this.onUnread(this.unreadKeys.size);
    } else if (pruned) {
      this.onUnread(this.unreadKeys.size);
    }
    State.notify();
  }

  /**
   * The subject left Windows or was dismissed locally: it leaves the list,
   * the quiet count drops if it was unread, and a showing or queued VIP
   * moment for that key ends at once and can never surface late.
   */
  removed(key: string): void {
    if (this.disposed || key === "") return;
    const had = this.recent.some((r) => r.key === key);
    this.recent = this.recent.filter((r) => r.key !== key);
    this.vipQueue = this.vipQueue.filter((q) => q.key !== key);
    if (this.unreadKeys.delete(key)) this.onUnread(this.unreadKeys.size);
    // Withdraw even when we never tracked the key: the moment may belong to
    // a dismissed item from before a reconcile.
    this.withdraw(NOTIFICATIONS_ID, key);
    if (had) State.notify();
  }

  /** Local clear: the list empties and any showing or queued VIP ends. */
  cleared(): void {
    if (this.disposed) return;
    this.recent = [];
    this.vipQueue = [];
    const had = this.unreadKeys.size > 0;
    this.unreadKeys.clear();
    if (had) this.onUnread(0);
    this.withdraw(NOTIFICATIONS_ID);
    State.notify();
  }

  /** "The list was read": the quiet count resets, the list stays. */
  markRead(): void {
    if (this.disposed || this.unreadKeys.size === 0) return;
    this.unreadKeys.clear();
    this.onUnread(0);
  }

  /**
   * A VIP item wants the pill. If nothing blocks it, it shows now; otherwise
   * it queues, oldest first, bounded, and a queued item older than the TTL
   * expires instead of surfacing stale news when the block lifts.
   */
  private queueVip(item: NotificationItem): void {
    // One moment per key: a refresh replaces the queued copy, never doubles.
    this.vipQueue = this.vipQueue.filter((q) => q.key !== item.key);
    this.vipQueue.push(item);
    while (this.vipQueue.length > MAX_VIP_QUEUE) this.vipQueue.shift();
    this.pump();
  }

  /** Shows the next unexpired queued VIP once the pill is free. Presents at
   *  most one moment per call: the next item waits for a later State change
   *  (for example the Focus expiry notify), so rapid arrivals never collapse
   *  through the Focus per-task queue into a single survivor. */
  pump(): void {
    if (this.disposed || this.vipQueue.length === 0) return;
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = (this.w.now ?? Date.now)();
      const before = this.vipQueue.length;
      this.vipQueue = this.vipQueue.filter((q) => now - q.createdMs < VIP_QUEUE_TTL_MS);
      if (this.vipQueue.length !== before) State.notify();
      if (this.vipQueue.length === 0) return;
      if (!this.w.isEnabled()) return;
      if (this.status && this.status.state !== "allowed") return;
      if (!this.canPresent()) return;
      if ((this.w.isPresenting ?? (() => Focus.hasMoment(NOTIFICATIONS_ID)))()) return;
      const next = this.vipQueue.shift();
      if (!next) return;
      if (!this.recent.some((r) => r.key === next.key)) return;
      const [line1, line2] = vipLines(next, this.w.isPrivate());
      this.present({
        taskId: NOTIFICATIONS_ID,
        kind: "notification",
        line1,
        line2,
        ms: VIP_MOMENT_MS,
        sourceKey: next.key,
      });
    } finally {
      this.pumping = false;
    }
  }

  /** Disable, teardown or shutdown: nothing survives, nothing fires again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const hadRecent = this.recent.length > 0;
    const hadQueue = this.vipQueue.length > 0;
    this.recent = [];
    this.vipQueue = [];
    this.seen.clear();
    const had = this.unreadKeys.size > 0;
    this.unreadKeys.clear();
    this.status = null;
    this.withdraw(NOTIFICATIONS_ID);
    if (had) this.onUnread(0);
    if (hadRecent || hadQueue || had) State.notify();
  }

  /** Clears the frontend content and withdraws VIPs, keeping the status for
   *  display. Disabled, denied, unspecified, unsupported and missingIdentity
   *  all land here, as does a settings turn off. */
  private teardownContent(): void {
    if (this.disposed) return;
    const hadRecent = this.recent.length > 0;
    const hadQueue = this.vipQueue.length > 0;
    const had = this.unreadKeys.size > 0;
    if (!hadRecent && !hadQueue && !had) {
      this.withdraw(NOTIFICATIONS_ID);
      return;
    }
    this.recent = [];
    this.vipQueue = [];
    this.unreadKeys.clear();
    this.withdraw(NOTIFICATIONS_ID);
    if (had) this.onUnread(0);
    State.notify();
  }

  /** Keeps the quiet count bounded to the retained recent list. */
  private pruneUnread(): boolean {
    const keep = new Set(this.recent.map((r) => r.key));
    let changed = false;
    for (const k of [...this.unreadKeys]) {
      if (!keep.has(k)) {
        this.unreadKeys.delete(k);
        changed = true;
      }
    }
    while (this.unreadKeys.size > MAX_RECENT) {
      const oldest = this.unreadKeys.values().next().value;
      if (oldest == null) break;
      this.unreadKeys.delete(oldest);
      changed = true;
    }
    return changed;
  }

  /** Dedup memory with bounded, oldest-first eviction. */
  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest == null) break;
      this.seen.delete(oldest);
    }
  }
}

/** How long a queued VIP may wait for the pill before it is stale news. */
export const VIP_QUEUE_TTL_MS = 30_000;

/**
 * Creates the quiet Notifications pill while the opt-in is on and removes it
 * when off. The pill never takes focus on its own; VIP moments borrow it.
 */
export function syncNotificationsPill(): void {
  const exists = State.tasks.some((t) => t.id === NOTIFICATIONS_ID);
  if (State.settings.notificationsEnabled === true) {
    if (!exists) State.upsertExternalAgent(NOTIFICATIONS_ID, NOTIFICATIONS_NAME, NOTIFICATIONS_COLOR);
    return;
  }
  if (!exists) return;
  if (State.focusId === NOTIFICATIONS_ID) State.focusId = "integration_claude";
  delete State.integrations[NOTIFICATIONS_ID];
  State.removeTask(NOTIFICATIONS_ID);
}

// ── Island wiring ────────────────────────────────────────────────────────────

let active: NotificationsController | null = null;

/** The live controller, for the panel and settings hooks. Null while off. */
export function notificationsController(): NotificationsController | null {
  return active;
}

/**
 * Connects the controller to the native events. Idempotent; main.ts calls it
 * once. When the opt-in is off the controller stays null and the native
 * listener never starts, so nothing is subscribed and nothing counts.
 */
export function registerNotifications(): () => void {
  if (active) return () => {};
  const controller = new NotificationsController({
    isEnabled: () => State.settings.notificationsEnabled === true,
    vipApps: () => State.settings.notificationsVipApps ?? [],
    isPrivate: () => State.settings.notificationsPrivate === true,
  });
  active = controller;
  let dead = false;
  let inHook = false;
  const offs: (() => void)[] = [];
  const track = (p: Promise<() => void>) => {
    void p.then((off) => {
      if (dead) {
        try { off(); } catch { /* already torn down */ }
      } else {
        offs.push(off);
      }
    });
  };
  track(onEvent<NotificationItem>("notification-added", (item) => {
    if (dead) return;
    controller.added(item);
  }));
  track(onEvent<{ key: string }>("notification-removed", ({ key }) => {
    if (dead) return;
    controller.removed(key);
    controller.pump();
  }));
  track(onEvent<void>("notifications-cleared", () => {
    if (dead) return;
    controller.cleared();
  }));
  track(onEvent<void>("notifications-read", () => {
    if (dead) return;
    controller.markRead();
  }));
  track(onEvent<NotificationsStatus>("notifications-status", (status) => {
    if (dead) return;
    controller.applyStatus(status);
    State.notify();
  }));
  // Unblocking an approval, unpinning or resuming lifts the queue; the pill
  // follows the opt-in without ever taking focus. Guarded against re-entry so
  // a notify inside the hook cannot recurse.
  offs.push(State.subscribe(() => {
    if (dead || inHook) return;
    inHook = true;
    try {
      syncNotificationsPill();
      controller.onSettingsChanged();
      controller.pump();
    } finally {
      inHook = false;
    }
  }));
  offs.push(Focus.subscribe(() => controller.pump()));
  syncNotificationsPill();
  // First paint: the native cache may hold items from earlier in the session.
  // Seeded silently: old snapshots never banner and never count.
  void Bridge.notificationsRecent().then((items) => {
    if (dead || active !== controller) return;
    if (!items) return;
    controller.seed(items);
  });
  void Bridge.notificationsStatus().then((status) => {
    if (dead || active !== controller) return;
    if (status) {
      controller.applyStatus(status);
      State.notify();
    }
  });
  return () => {
    dead = true;
    for (const off of offs) {
      try { off(); } catch { /* already torn down */ }
    }
    controller.dispose();
    if (active === controller) active = null;
  };
}
