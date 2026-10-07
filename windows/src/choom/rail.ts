// Mascot rail: the overview's right side is a vertical column of mini Chooms,
// one per task except the focused one. Hover or keyboard focus widens the rail
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

export function buildRail(actions: RailActions): RailHost {
  const list = h("div", { class: "rail-in" });
  const el = h("div", { class: "rail" }, list);

  // Rows are keyed by task and updated in place: rebuilding every button on
  // each state change would drop keyboard focus mid-tab.
  const rows = new Map<string, RailRow>();

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
      const others = State.tasks.filter((t) => t.id !== State.focusId).slice(0, 5);
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
      // Appending moves existing nodes, so order converges with no rebuild.
      for (const task of others) {
        const row = rows.get(task.id);
        if (row) list.append(row.item);
      }
      pruneMiniBots();
    },
  };
}
