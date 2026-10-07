// Mascot rail: the overview's right side is a vertical column of mini Chooms,
// the three highest-priority tasks except the focused one. Hover or keyboard focus widens the rail
// to show names while the middle card shrinks to make room; leaving returns
// it. Mini bots stay plain: no outfits, only a status badge dot.

import { h } from "../views/dom";
import { State, type AgentTask } from "../core/state";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";

export interface RailActions {
  setFocus(id: string): void;
}

export interface RailHost {
  el: HTMLElement;
  sync(): void;
}

const BADGE_COLORS = {
  approval: "#F5A524",
  finished: "#22C55E",
  error: "#F4505E",
} as const;

/** Status dot: the pill badge colour when one is set, else the task colour. */
function statusColor(task: Pick<AgentTask, "color" | "pillBadge">): string {
  if (task.pillBadge && task.pillBadge in BADGE_COLORS) {
    return BADGE_COLORS[task.pillBadge as keyof typeof BADGE_COLORS];
  }
  return task.color;
}

interface RailRow {
  item: HTMLElement;
  name: HTMLElement;
  dot: HTMLElement;
}

/** Stable ties keep quiet tasks from shuffling on unrelated updates. */
export function railPriority(task: AgentTask): number {
  if (State.pendingApproval?.taskId === task.id || task.pillBadge === "approval") return 0;
  if (task.pillBadge === "error" || task.state === "error") return 1;
  if (["working", "thinking", "searching"].includes(task.state) && task.id !== "integration_music") return 2;
  if (task.id === "integration_music" && State.integrations[task.id]?.data.playing === true) return 3;
  if (task.pillBadge === "finished") return 4;
  return 5;
}

export function buildRail(actions: RailActions): RailHost {
  const list = h("div", { class: "rail-in" });
  const el = h("div", { class: "rail" }, list);

  // Rows are keyed by task and updated in place: rebuilding every button on
  // each state change would drop keyboard focus mid-tab. Reorders only move
  // nodes when the order actually changed, and restore focus and scroll.
  const rows = new Map<string, RailRow>();
  let order: string[] = [];

  function buildRow(task: AgentTask): RailRow {
    const name = h("span", { class: "nm", text: task.name });
    const dot = h("i", { class: "bd", style: `background:${statusColor(task)}` });
    const item = h(
      "button",
      {
        class: "ri",
        type: "button",
        title: task.name,
        onclick: () => actions.setFocus(task.id),
      },
      createMiniBot(task, 24),
      name,
      dot,
    );
    // Keyboard focus scrolls the item into view inside the rail.
    item.addEventListener("focus", () => {
      item.scrollIntoView({ block: "nearest" });
    });
    return { item, name, dot };
  }

  return {
    el,
    sync() {
      const oldTops = new Map<string, number>();
      for (const [id, row] of rows) {
        if (typeof row.item.getBoundingClientRect === "function") oldTops.set(id, row.item.getBoundingClientRect().top);
      }
      const others = State.tasks.filter((t) => t.id !== State.focusId)
        .sort((a, b) => railPriority(a) - railPriority(b)).slice(0, 3);
      const ids = new Set(others.map((t) => t.id));
      for (const [id, row] of rows) {
        if (!ids.has(id)) {
          row.item.remove();
          rows.delete(id);
        }
      }
      for (const task of others) {
        let row = rows.get(task.id);
        if (!row) {
          row = buildRow(task);
          rows.set(task.id, row);
        }
        row.name.textContent = task.name;
        row.item.title = task.name;
        row.dot.style.background = statusColor(task);
      }
      const wanted = others.map((t) => t.id);
      const sameOrder = order.length === wanted.length && order.every((id, i) => id === wanted[i]);
      if (!sameOrder) {
        // A reorder moves the focused node and resets scroll: remember both
        // for the surviving rows and put them back afterwards.
        const scrolled = list.scrollTop;
        const active = typeof document !== "undefined" ? document.activeElement : null;
        let focusedId: string | null = null;
        if (active) {
          for (const [id, row] of rows) {
            if (row.item === active) {
              focusedId = id;
              break;
            }
          }
        }
        for (const task of others) {
          const row = rows.get(task.id);
          if (row) list.append(row.item);
        }
        const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reduce) for (const task of others) {
          const item = rows.get(task.id)?.item;
          const before = oldTops.get(task.id);
          if (item && before != null && typeof item.animate === "function") {
            const delta = before - item.getBoundingClientRect().top;
            if (delta !== 0) item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
          }
        }
        order = wanted;
        list.scrollTop = scrolled;
        if (focusedId != null) {
          const row = rows.get(focusedId);
          if (row && typeof document !== "undefined" && document.activeElement !== row.item) {
            row.item.focus({ preventScroll: true });
            list.scrollTop = scrolled;
          }
        }
      }
      pruneMiniBots();
    },
  };
}
