// Mascot rail: the overview's right side is a vertical column of mini Chooms,
// one per task except the focused one. Hover or keyboard focus widens the rail
// to show names while the middle card shrinks to make room; leaving returns
// it. Mini bots stay plain: no outfits, only a status badge dot.

import { h, clear } from "../views/dom";
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

export function buildRail(actions: RailActions): RailHost {
  const list = h("div", { class: "rail-in" });
  const el = h("div", { class: "rail" }, list);

  let railKey = "";

  return {
    el,
    sync() {
      const others = State.tasks.filter((t) => t.id !== State.focusId).slice(0, 5);
      const key = others.map((t) => `${t.id}:${t.pillBadge ?? ""}:${t.state}`).join("|");
      if (key === railKey) return;
      railKey = key;
      clear(list);
      for (const task of others) {
        const item = h(
          "button",
          {
            class: "ri",
            type: "button",
            title: task.name,
            onclick: () => actions.setFocus(task.id),
          },
          createMiniBot(task, 24),
          h("span", { class: "nm", text: task.name }),
          h("i", { class: "bd", style: `background:${statusColor(task)}` }),
        );
        list.append(item);
      }
      pruneMiniBots();
    },
  };
}
