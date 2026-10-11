// Settings hub: Pocket control room (route A) with A1 dimensional artwork.
// Home shows a heading plus Voice, Brain and History tiles, then a single
// horizontally scrolling row of secondary tiles. A tile opens its detail in
// the same surface, with icon capsules for every category and a back chevron
// home. Navigation never writes settings: sections save only on explicit
// user action inside their own controls.

import { h, clear } from "../views/dom";

export type HubCategoryId =
  | "voice"
  | "brain"
  | "history"
  | "appearance"
  | "music"
  | "tools"
  | "wake"
  | "connections"
  | "privacy";

export interface HubCategory {
  id: HubCategoryId;
  title: string;
  blurb: string;
  icon: string;
}

/** A detail node may refresh itself every time its category opens. */
export interface HubDetail extends HTMLElement {
  onHubShow?: () => void;
}

const GLYPH = (inner: string, box = "0 0 24 24"): string =>
  `<svg viewBox="${box}" aria-hidden="true" focusable="false">${inner}</svg>`;

export const HUB_ICONS: Record<HubCategoryId, string> = {
  voice: GLYPH(
    `<rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 9v1a6 6 0 0 0 12 0V9M10 16v3M7 19h6"/>`,
    "0 0 20 20",
  ),
  brain: GLYPH(`<path d="M9 3h6v4h4v6h-4v7H9v-7H5V7h4zM9 10h6M12 7v9"/>`),
  history: GLYPH(`<path d="M4 10a8 8 0 1 1 2 8M4 4v6h6M12 7v5l4 2"/>`),
  appearance: GLYPH(
    `<rect x="3" y="5" width="18" height="14" rx="5"/><path d="M8 10v3m8-3v3M10 16h4"/>`,
  ),
  music: GLYPH(
    `<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>`,
  ),
  tools: GLYPH(
    `<path d="M15 4a6 6 0 0 0-7 7l-5 6 4 4 6-6a6 6 0 0 0 7-7l-4 4-4-4z"/>`,
  ),
  privacy: GLYPH(
    `<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>`,
  ),
  wake: GLYPH(`<path d="M18 4a8 8 0 1 0 2 13A9 9 0 0 1 18 4z"/>`),
  connections: GLYPH(
    `<path d="M10 8l3-3a4 4 0 0 1 6 6l-3 3M14 16l-3 3a4 4 0 0 1-6-6l3-3M8 16l8-8"/>`,
  ),
};

const CHEVRON_RIGHT =
  `<svg viewBox="0 0 32 48" aria-hidden="true" focusable="false"><path d="M9 7 24 22Q26 24 24 26L9 41"/></svg>`;
const CHEVRON_LEFT =
  `<svg viewBox="0 0 32 48" aria-hidden="true" focusable="false"><path d="M23 7 8 22Q6 24 8 26L23 41"/></svg>`;

export const HUB_CATEGORIES: HubCategory[] = [
  { id: "voice", title: "Voice", blurb: "Talk, wake word and speech.", icon: HUB_ICONS.voice },
  { id: "brain", title: "Brain", blurb: "Providers and request routing.", icon: HUB_ICONS.brain },
  { id: "history", title: "History", blurb: "Past routing decisions.", icon: HUB_ICONS.history },
  { id: "appearance", title: "Appearance", blurb: "Sound, startup and display.", icon: HUB_ICONS.appearance },
  { id: "music", title: "Music", blurb: "Whatever is playing.", icon: HUB_ICONS.music },
  { id: "tools", title: "Tools", blurb: "System jobs and PC load.", icon: HUB_ICONS.tools },
  { id: "wake", title: "Wake", blurb: "Waking Choom.", icon: HUB_ICONS.wake },
  {
    id: "connections", title: "Connections", blurb: "Hooks, keys and pills.",
    icon: HUB_ICONS.connections,
  },
  { id: "privacy", title: "Privacy", blurb: "What stays on this PC.", icon: HUB_ICONS.privacy },
];

/** Heading plus Voice, Brain and History: the fixed priority row. */
export const HUB_PRIORITY: HubCategoryId[] = ["voice", "brain", "history"];
/** The remaining six categories in the scrolling row. */
export const HUB_RAIL: HubCategoryId[] = [
  "appearance", "music", "tools", "wake", "connections", "privacy",
];

export function hubCategory(id: HubCategoryId): HubCategory {
  return HUB_CATEGORIES.find((c) => c.id === id) ?? HUB_CATEGORIES[0]!;
}

/**
 * Validates an external category id (deep-link payloads, query params).
 * Unknown values return null so callers fall back to the hub home instead of
 * silently opening the wrong room.
 */
export function parseHubCategory(value: unknown): HubCategoryId | null {
  return typeof value === "string" &&
    HUB_CATEGORIES.some((c) => c.id === value)
    ? (value as HubCategoryId)
    : null;
}

export type HubBuilders = Record<HubCategoryId, () => HTMLElement>;

export interface HubHandle {
  el: HTMLElement;
  open: (id: HubCategoryId) => void;
  home: () => void;
  /** Reconciles every cached detail with changed settings, preserving drafts. */
  syncExternal: () => void;
  /** Tears down document listeners, observers and pending layout work. */
  dispose: () => void;
  current: () => HubCategoryId | null;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "select" || tag === "textarea") return true;
  return (el as unknown as { isContentEditable?: unknown }).isContentEditable === true;
}

/** Element children only, so text nodes never shift the paths. */
function elementKids(el: Element): Element[] {
  const kids = (el as unknown as { children?: ArrayLike<Element> }).children;
  const out: Element[] = [];
  if (!kids) return out;
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]!;
    if (kid.tagName && !kid.tagName.startsWith("#")) out.push(kid);
  }
  return out;
}

/** Index path from root to el, or null when el left the tree. */
function indexPath(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  let at: Element | null = el;
  while (at && at !== root) {
    const parent = at.parentNode as Element | null;
    if (!parent) return null;
    const atIndex = elementKids(parent).indexOf(at);
    if (atIndex < 0) return null;
    path.unshift(atIndex);
    at = parent;
  }
  return at === root ? path : null;
}

function resolvePath(root: Element, path: number[]): Element | null {
  let at: Element = root;
  for (const atIndex of path) {
    const next = elementKids(at)[atIndex];
    if (!next) return null;
    at = next;
  }
  return at;
}

interface FieldSnapshot {
  path: number[];
  value: string;
  checked: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/** Captures unsaved drafts, caret included, before a detail rebuild. */
function snapshotFields(root: HTMLElement): FieldSnapshot[] {
  const out: FieldSnapshot[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const field = el as unknown as {
        value?: unknown; checked?: unknown;
        selectionStart?: unknown; selectionEnd?: unknown;
      };
      const path = indexPath(root, el);
      if (path) {
        let start: number | null = null;
        let end: number | null = null;
        try {
          if (typeof field.selectionStart === "number") start = field.selectionStart;
          if (typeof field.selectionEnd === "number") end = field.selectionEnd;
        } catch {
          // Number and range inputs have no caret: keep the value only.
        }
        out.push({
          path,
          value: typeof field.value === "string" ? field.value : "",
          checked: field.checked === true,
          selectionStart: start,
          selectionEnd: end,
        });
      }
    }
    for (const kid of elementKids(el)) walk(kid);
  };
  walk(root);
  return out;
}

/** Restores drafts into a rebuilt detail. Only fields in keep (user-edited or
 * focused) hold their drafts; every other control takes the fresh value, so
 * remote updates reach unedited controls promptly. */
function restoreFields(
  root: HTMLElement,
  snaps: FieldSnapshot[],
  keep: Set<string>,
): void {
  for (const snap of snaps) {
    if (!keep.has(snap.path.join("."))) continue;
    const target = resolvePath(root, snap.path) as unknown as {
      value?: unknown; checked?: unknown;
      selectionStart?: unknown; selectionEnd?: unknown;
      tagName?: string; type?: string;
    } | null;
    if (!target) continue;
    try {
      if (typeof target.value === "string") target.value = snap.value;
      if (target.tagName === "INPUT" && (target.type === "checkbox" || target.type === "radio")) {
        target.checked = snap.checked;
      }
    } catch {
      // A changed control shape keeps its fresh value instead.
    }
  }
}

function restoreSelections(root: HTMLElement, snaps: FieldSnapshot[], keep: Set<string>): void {
  for (const snap of snaps) {
    if (snap.selectionStart == null) continue;
    if (!keep.has(snap.path.join("."))) continue;
    const target = resolvePath(root, snap.path) as unknown as {
      setSelectionRange?: unknown;
    } | null;
    try {
      if (target && typeof target.setSelectionRange === "function") {
        (target.setSelectionRange as (s: number, e: number) => void)(
          snap.selectionStart, snap.selectionEnd ?? snap.selectionStart,
        );
      }
    } catch {
      // Caret restore is best effort only.
    }
  }
}

function readFieldValue(el: Element | null): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "select" && tag !== "textarea") return null;
  const field = el as unknown as { value?: unknown; checked?: unknown; type?: unknown };
  if (tag === "input" && (field.type === "checkbox" || field.type === "radio")) {
    return field.checked === true ? "checked" : "";
  }
  return typeof field.value === "string" ? field.value : null;
}

/**
 * Only free-typed fields can hold a genuine draft. Selects, checkboxes,
 * radios and ranges commit through their change handlers at once, so they
 * always follow the fresh value on the next reconcile.
 */
function isDraftField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = String(
    (el as unknown as { type?: unknown }).type ?? "text",
  ).toLowerCase();
  return type === "text" || type === "password" || type === "search";
}

function keepSet(
  id: HubCategoryId,
  node: HTMLElement,
  active: Element | null,
  dirty: Map<HubCategoryId, Set<string>>,
): { keep: Set<string>; focusKey: string | null } {
  const keep = new Set<string>();
  let focusKey: string | null = null;
  if (active && node.contains(active)) {
    const path = indexPath(node, active);
    if (path) {
      // The focused control is always kept: patching never replaces it, and
      // a full rebuild restores it with its caret.
      focusKey = path.join(".");
      keep.add(focusKey);
    }
  }
  for (const key of dirty.get(id) ?? []) {
    const target = resolvePath(node, key.split(".").map(Number));
    if (isDraftField(target)) keep.add(key);
  }
  return { keep, focusKey };
}

/**
 * Drops dirty markers the fresh tree already confirms. A draft whose value
 * matches the fresh factory value was committed (for example through Save),
 * so the marker goes and the control follows remote updates again.
 * Committed control types never hold drafts and are always dropped.
 */
function confirmCommitted(
  id: HubCategoryId,
  oldNode: HTMLElement,
  freshNode: HTMLElement,
  keep: Set<string>,
  focusKey: string | null,
  dirty: Map<HubCategoryId, Set<string>>,
): void {
  const set = dirty.get(id);
  if (!set || set.size === 0) return;
  for (const key of [...set]) {
    if (key === focusKey) continue;
    if (!keep.has(key)) {
      set.delete(key);
      continue;
    }
    const path = key.split(".").map(Number);
    const oldValue = readFieldValue(resolvePath(oldNode, path));
    const freshValue = readFieldValue(resolvePath(freshNode, path));
    if (oldValue != null && oldValue === freshValue) {
      set.delete(key);
      keep.delete(key);
    }
  }
}

/** Preserve live nodes so handlers keep their original control references. */
function patchInto(oldNode: Element, freshNode: Element, keep: Set<string>): boolean {
  const verify = (oldEl: Element, freshEl: Element): boolean => {
    if (oldEl.tagName !== freshEl.tagName) return false;
    const oldKids = elementKids(oldEl);
    const freshKids = elementKids(freshEl);
    return oldKids.length === freshKids.length &&
      oldKids.every((child, i) => verify(child, freshKids[i]));
  };
  if (!verify(oldNode, freshNode)) return false;
  const sync = (oldEl: Element, freshEl: Element, path: string): void => {
    if (keep.has(path)) return;
    for (const name of oldEl.getAttributeNames()) {
      if (!freshEl.hasAttribute(name)) oldEl.removeAttribute(name);
    }
    for (const name of freshEl.getAttributeNames()) {
      oldEl.setAttribute(name, freshEl.getAttribute(name)!);
    }
    const oldKids = elementKids(oldEl);
    const freshKids = elementKids(freshEl);
    oldKids.forEach((child, i) => sync(child, freshKids[i], path ? `${path}.${i}` : `${i}`));
    if (!oldKids.length && !["INPUT", "TEXTAREA", "SELECT"].includes(oldEl.tagName)) {
      oldEl.textContent = freshEl.textContent;
    }
    if (["INPUT", "SELECT", "TEXTAREA"].includes(oldEl.tagName)) {
      (oldEl as HTMLInputElement).value = (freshEl as HTMLInputElement).value;
      if (oldEl.tagName === "INPUT") {
        (oldEl as HTMLInputElement).checked = (freshEl as HTMLInputElement).checked;
      }
    }
    if ("disabled" in oldEl && "disabled" in freshEl) {
      (oldEl as HTMLButtonElement).disabled = (freshEl as HTMLButtonElement).disabled;
    }
  };
  sync(oldNode, freshNode, "");
  return true;
}

export function buildSettingsHub(builders: HubBuilders): HubHandle {
  const surface = h("div", {
    class: "hub-surface",
    role: "region",
    "aria-label": "Settings",
  });
  const built = new Map<HubCategoryId, HTMLElement>();
  const stale = new Set<HubCategoryId>();
  const pending = new Set<HubCategoryId>();
  const detailScroll = new Map<HubCategoryId, number>();
  const pendingRaf = new Set<number>();
  /** Index paths the user edited since the detail was built. Drafts survive. */
  const dirty = new Map<HubCategoryId, Set<string>>();
  const tiles = new Map<HubCategoryId, HTMLElement>();
  let current: HubCategoryId | null = null;
  let lastOpened: HubCategoryId | null = null;
  let disposed = false;
  let railScroll = 0;
  let syncScheduled = false;
  let rail: HTMLElement | null = null;
  let edge: HTMLElement | null = null;
  let edgeButton: HTMLButtonElement | null = null;
  let railObserver: ResizeObserver | null = null;

  function afterLayout(fn: () => void): void {
    if (typeof requestAnimationFrame !== "function") {
      if (!disposed) fn();
      return;
    }
    const id = requestAnimationFrame(() => {
      pendingRaf.delete(id);
      if (!disposed) fn();
    });
    pendingRaf.add(id);
  }

  function artwork(id: HubCategoryId): HTMLElement {
    return h(
      "span",
      { class: `tile-art art-${id}`, "aria-hidden": "true" },
      h(
        "span",
        { class: "sculpture" },
        h("i", {}),
        h("i", {}),
        h("i", {}),
        h("span", { class: "sculpture-mark", html: hubCategory(id).icon }),
      ),
    );
  }

  function tile(id: HubCategoryId): HTMLElement {
    const cat = hubCategory(id);
    const el = h(
      "button",
      {
        class: "hub-tile",
        type: "button",
        "aria-label": `${cat.title}: ${cat.blurb}`,
      } as Record<string, string>,
      artwork(id),
      h("b", { text: cat.title }),
    );
    el.addEventListener("click", () => open(id));
    tiles.set(id, el);
    return el;
  }

  function syncEdge(): void {
    if (disposed || !rail || !edge || !edgeButton) return;
    // Real layout only: before the surface mounts every metric is zero, and
    // zero metrics must not flip the chevron to its end state.
    if (!rail.isConnected || rail.clientWidth <= 0) return;
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const atEnd = max <= 0 || rail.scrollLeft >= max - 2;
    edge.classList.toggle("at-end", atEnd);
    edgeButton.setAttribute(
      "aria-label",
      atEnd ? "Back to first settings" : "More settings",
    );
  }

  function scheduleSync(): void {
    if (syncScheduled) return;
    syncScheduled = true;
    afterLayout(() => {
      syncScheduled = false;
      syncEdge();
    });
  }

  function observeRail(): void {
    if (typeof ResizeObserver !== "function" || !rail) return;
    railObserver?.disconnect();
    const target = rail;
    railObserver = new ResizeObserver(() => {
      if (!disposed) syncEdge();
    });
    railObserver.observe(target);
  }

  function pageRail(): void {
    if (!rail) return;
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    if (max <= 0) return;
    // Instant jump: no smooth scrolling, so reduced motion needs no branch.
    rail.scrollLeft = rail.scrollLeft >= max - 2 ? 0 : rail.scrollLeft + rail.clientWidth;
    syncEdge();
  }

  function detailBody(): HTMLElement | null {
    return surface.querySelector(".hub-detail-body") as HTMLElement | null;
  }

  function focusHeading(): void {
    const heading = surface.querySelector(".hub-focus-head h2") as HTMLElement | null;
    heading?.focus({ preventScroll: true });
  }

  function renderHome(): void {
    clear(surface);
    railObserver?.disconnect();
    railObserver = null;
    rail = null;
    edge = null;
    edgeButton = null;
    tiles.clear();

    const priority = h("div", { class: "hub-priority" });
    priority.append(
      h("div", { class: "hub-lead" }, "Settings", h("small", { text: "Essentials first." })),
    );
    for (const id of HUB_PRIORITY) priority.append(tile(id));

    const railEl = h("div", {
      class: "hub-more",
      tabindex: "0",
      role: "region",
      "aria-label": "More settings, horizontally scrollable",
    });
    for (const id of HUB_RAIL) railEl.append(tile(id));
    railEl.addEventListener("scroll", syncEdge);
    railEl.scrollLeft = railScroll;

    const edgeBtn = h("button", {
      type: "button",
      "aria-label": "More settings",
      html: CHEVRON_RIGHT,
    }) as HTMLButtonElement;
    edgeBtn.addEventListener("click", pageRail);
    const edgeEl = h("div", { class: "hub-edge" }, edgeBtn);

    const wrap = h("div", { class: "hub-more-wrap" }, railEl, edgeEl);
    surface.append(priority, wrap);
    rail = railEl;
    edge = edgeEl;
    edgeButton = edgeBtn;
    observeRail();
    scheduleSync();
  }

  function detailNode(id: HubCategoryId): HTMLElement {
    let node = built.get(id);
    if (!node || stale.has(id)) {
      node?.remove();
      node = builders[id]();
      built.set(id, node);
      stale.delete(id);
    }
    return node;
  }

  function restoreDetailScroll(body: HTMLElement, id: HubCategoryId): void {
    const at = detailScroll.get(id) ?? 0;
    body.scrollTop = at;
    // Before layout the assignment clamps: re-apply once laid out.
    afterLayout(() => {
      if (body.isConnected && body.scrollTop !== at) body.scrollTop = at;
    });
  }

  function renderDetail(id: HubCategoryId): void {
    const cat = hubCategory(id);
    if (rail) railScroll = rail.scrollLeft;
    clear(surface);
    railObserver?.disconnect();
    railObserver = null;
    rail = null;
    edge = null;
    edgeButton = null;

    const back = h("button", {
      class: "hub-back",
      type: "button",
      "aria-label": "Back to settings home",
      html: CHEVRON_LEFT,
    });
    back.addEventListener("click", () => home());
    const heading = h("h2", { tabindex: "-1", text: cat.title });

    const capsules = h("nav", {
      class: "hub-capsules",
      "aria-label": "Setting categories",
    });
    for (const c of HUB_CATEGORIES) {
      const cap = h("button", {
        class: "hub-capsule",
        type: "button",
        "aria-label": c.title,
        title: c.title,
        html: c.icon,
      });
      cap.setAttribute("aria-pressed", c.id === id ? "true" : "false");
      cap.addEventListener("click", () => open(c.id));
      capsules.append(cap);
    }

    const head = h(
      "div",
      { class: "hub-focus-head" },
      h("div", {}, back, heading),
      capsules,
    );
    const body = h("div", { class: "hub-detail-body", tabindex: "-1" });
    const node = detailNode(id);
    body.append(node);
    restoreDetailScroll(body, id);
    // Typing marks a field as user-edited, so its draft survives reconciles.
    // Paths root at the detail node itself, matching the snapshots.
    const markDirty = (e: Event) => {
      const target = e.target as Element | null;
      if (disposed || !current || !target) return;
      const shown = built.get(current);
      if (!shown || !shown.contains(target)) return;
      const path = indexPath(shown, target);
      if (!path) return;
      let set = dirty.get(current);
      if (!set) {
        set = new Set();
        dirty.set(current, set);
      }
      set.add(path.join("."));
    };
    body.addEventListener("input", markDirty);
    body.addEventListener("change", markDirty);
    surface.append(head, body);
    const shown = node as unknown as { onHubShow?: unknown };
    if (typeof shown.onHubShow === "function") {
      (shown.onHubShow as () => void)();
    }
    heading.focus({ preventScroll: true });
  }

  function open(id: HubCategoryId): void {
    if (disposed) return;
    if (current) {
      const prev = detailBody();
      if (prev) detailScroll.set(current, prev.scrollTop);
    }
    lastOpened = id;
    current = id;
    renderDetail(id);
  }

  function home(): void {
    if (disposed) return;
    if (current) {
      const body = detailBody();
      if (body) detailScroll.set(current, (body as HTMLElement).scrollTop);
    }
    current = null;
    renderHome();
    // Narrow windows keep every control reachable: after returning home the
    // rail restores its previous position instead of jumping to the start.
    if (rail) rail.scrollLeft = railScroll;
    scheduleSync();
    const id = lastOpened;
    const target = (id && tiles.get(id)) ?? surface.querySelector(".hub-tile");
    (target as HTMLElement | null)?.focus();
  }

  /** Rebuilds one cached detail, carrying drafts and focus across. */
  function reconcileNode(id: HubCategoryId, restoreFocus: boolean): void {
    const node = built.get(id);
    if (!node) return;
    const isOpen = id === current;
    const host = isOpen ? detailBody() : null;
    const active = document.activeElement as Element | null;
    const { keep, focusKey } = keepSet(
      id, node, isOpen && restoreFocus ? active : null, dirty,
    );
    const snaps = snapshotFields(node);
    const focusPath = focusKey ? focusKey.split(".").map(Number) : null;
    stale.add(id);
    const fresh = detailNode(id);
    confirmCommitted(id, node, fresh, keep, focusKey, dirty);
    if (host) {
      clear(host);
      host.append(fresh);
      restoreFields(fresh, snaps, keep);
      restoreDetailScroll(host, id);
    } else {
      restoreFields(fresh, snaps, keep);
    }
    if (focusPath) {
      const target = resolvePath(fresh, focusPath) as HTMLElement | null;
      if (target && typeof target.focus === "function") {
        target.focus();
      } else {
        focusHeading();
      }
    }
    restoreSelections(fresh, snaps, keep);
    pending.delete(id);
  }

  function syncExternal(): void {
    if (disposed) return;
    if (!current && built.size === 0) return;
    // Every cached offscreen detail reconciles now, so reentry shows fresh
    // values. The open detail goes through the focus-aware path below.
    for (const id of [...built.keys()]) {
      if (id === current) continue;
      reconcileNode(id, false);
    }
    if (!current) return;
    const node = built.get(current);
    const body = detailBody();
    const active = document.activeElement as Element | null;
    if (!node || !body) return;
    // A focused draft stays exactly where it is: fresh values flow into every
    // other control in place, and only a structural change waits for blur.
    if (active && node.contains(active) && isEditable(active)) {
      const fresh = builders[current]();
      const { keep, focusKey } = keepSet(current, node, active, dirty);
      confirmCommitted(current, node, fresh, keep, focusKey, dirty);
      if (patchInto(node, fresh, keep)) return;
      pending.add(current);
      return;
    }
    reconcileNode(current, true);
  }

  surface.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && current) {
      e.preventDefault();
      // The surface lives inside host views (the island settings view): stop
      // here so one Escape steps back to the hub home without also reaching a
      // host-level collapse handler. No-op in the standalone window.
      e.stopPropagation();
      home();
    }
  });

  // A deferred refresh lands on blur: by then the active element settled, so
  // read it in a microtask rather than trusting the focusout moment. Pending
  // details that were navigated away from reconcile offscreen instead.
  surface.addEventListener("focusout", () => {
    if (disposed || pending.size === 0) return;
    const ids = [...pending];
    void Promise.resolve().then(() => {
      if (disposed) return;
      for (const id of ids) {
        if (!pending.has(id)) continue;
        const active = document.activeElement as Element | null;
        const host = id === current ? detailBody() : null;
        if (host && active && host.contains(active) && isEditable(active)) continue;
        reconcileNode(id, id === current);
      }
    });
  });

  function syncPaused(): void {
    document.documentElement?.classList?.toggle("sculptures-paused", document.hidden);
  }

  function onVisibility(): void {
    syncPaused();
  }

  document.addEventListener("visibilitychange", onVisibility);
  syncPaused();

  renderHome();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    railObserver?.disconnect();
    railObserver = null;
    if (typeof cancelAnimationFrame === "function") {
      for (const id of pendingRaf) {
        try {
          cancelAnimationFrame(id);
        } catch {
          // The frame already ran: nothing left to cancel.
        }
      }
    }
    pendingRaf.clear();
    dirty.clear();
    clear(surface);
    built.clear();
    pending.clear();
    stale.clear();
    detailScroll.clear();
    current = null;
  }

  return {
    el: surface,
    open,
    home,
    syncExternal,
    dispose,
    current: () => current,
  };
}
