// History detail: the available bounded Jev receipt history through the
// existing Bridge. There is no persisted conversation list in Choom, so this
// view labels the routing history accurately and never invents entries.
// Receipts carry route, mode, confidence, latency and fallback only: no
// request text and no credentials ever reach this list.

import { h, clear } from "../views/dom";
import { Bridge } from "../core/bridge";
import { formatJevReceipt } from "../choom/jev";
import type { HubDetail } from "./hub";
import { t } from "../i18n/i18n";

/** Newest first, bounded so a long session cannot grow the detail. */
const MAX_RECEIPTS = 20;

export function historySection(): HTMLElement {
  const status = h("div", { class: "hint", text: "Loading routing history…" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  const actions = h("div", { class: "row" });
  const feedback = h("div", {});
  // Every refresh takes a generation: a slow result that lands after a newer
  // refresh or a clear is dropped instead of restoring old entries.
  let generation = 0;

  function showError(message: string, retry: () => void): void {
    status.textContent = message;
    const retryBtn = h("button", { text: t("Retry") });
    retryBtn.addEventListener("click", () => retry());
    actions.append(retryBtn);
  }

  async function refresh(): Promise<void> {
    const gen = ++generation;
    clear(list);
    clear(actions);
    clear(feedback);
    status.textContent = "Loading routing history…";
    let receipts;
    try {
      receipts = await Bridge.jevHistory();
    } catch (err) {
      if (gen !== generation) return;
      showError(
        `Routing history is unavailable: ${String(err).replace(/^Error:\s*/, "")}`,
        () => void refresh(),
      );
      return;
    }
    if (gen !== generation) return;
    // Bridge resolves null on native failure: unavailable, not empty.
    if (receipts == null) {
      showError("Routing history is unavailable right now.", () => void refresh());
      return;
    }
    if (receipts.length === 0) {
      status.textContent =
        "No routing decisions yet. When Jev routing is on in Brain, each decision is recorded here without changing answers. Choom keeps no saved conversation list.";
      return;
    }
    const shown = [...receipts].reverse().slice(0, MAX_RECEIPTS);
    status.textContent =
      `${receipts.length} routing decision${receipts.length === 1 ? "" : "s"} (latest first). ` +
      "Only route, mode, confidence, latency and fallback are kept.";
    for (const r of shown) {
      const when = new Date(r.atMs).toLocaleString();
      list.append(
        h("div", { class: "row" },
          h("span", { class: "path", text: formatJevReceipt(r) }),
          h("span", { class: "hint", text: when }),
        ),
      );
    }
    const clearBtn = h("button", { class: "danger", text: t("Clear history") });
    clearBtn.addEventListener("click", async () => {
      // Invalidate in-flight refreshes first, so their late results cannot
      // restore the entries being cleared.
      generation += 1;
      clear(feedback);
      try {
        await Bridge.jevClearHistory();
        feedback.append(h("div", { class: "notice ok", text: "Routing history cleared." }));
      } catch (err) {
        feedback.append(h("div", {
          class: "notice err",
          text: `Could not clear: ${String(err).replace(/^Error:\s*/, "")}`,
        }));
        return;
      }
      await refresh();
    });
    actions.append(clearBtn);
  }

  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Routing history" })),
    status,
    list,
    actions,
    feedback,
  ) as HubDetail;
  // The hub calls this on every entry, so new receipts appear on reentry.
  // Rendering and refresh never clear data: only the button above does.
  section.onHubShow = () => {
    void refresh();
  };
  void refresh();
  return section;
}
