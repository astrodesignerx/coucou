// Tools card: colour pocket, command bar and routines in one compact card.
// Built once and updated in place, so typing in a field never loses focus:
// updaters rebuild lists, swatches and feedback only, never the inputs
// themselves. The island header already names the Tools pill, so the card
// carries no repeated heading. Motion reuses the shared tokens and rests
// under reduced motion (see choom.css).

import { h, clear } from "../views/dom";
import { Bridge, IS_TAURI } from "../core/bridge";
import { State, type ToolRoutine, type ToolShortcut, type ToolsData } from "../core/state";
import {
  MAX_COLOURS,
  ROUTINE_PAGE,
  SHORTCUT_PAGE,
  addColour,
  beginRoutine,
  cleanShortcutName,
  filterShortcuts,
  finishRoutine,
  getClearConfirm,
  getColourFeedback,
  getColourInput,
  getDeleteConfirmId,
  getRoutineError,
  getRoutineForm,
  getRoutineResults,
  getRoutineSelectedId,
  getRoutinePage,
  getRunningRoutineId,
  getShortcutError,
  getShortcutForm,
  getShortcutPage,
  getShortcutQuery,
  getToolsTab,
  isValidId,
  makeId,
  paginate,
  readTools,
  resolveRoutineSteps,
  routineById,
  routinesUsing,
  setClearConfirm,
  setColourFeedback,
  setColourInput,
  setDeleteConfirmId,
  setRoutineError,
  setRoutineForm,
  setRoutineResults,
  setRoutineSelectedId,
  setRoutinePage,
  setShortcutError,
  setShortcutForm,
  setShortcutPage,
  setShortcutQuery,
  setToolsTab,
  shortcutById,
  validateShortcutShape,
} from "./tools";

function actionable(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

async function persistTools(mut: (data: ToolsData) => ToolsData): Promise<void> {
  State.settings.tools = mut(readTools());
  await Bridge.saveSettings(State.settings);
  State.notify();
}

async function copyHex(hex: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(hex);
    } else {
      throw new Error("no clipboard");
    }
    setColourFeedback({ kind: "ok", text: `Copied ${hex}.` });
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = hex;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      setColourFeedback({ kind: "ok", text: `Copied ${hex}.` });
    } catch {
      setColourFeedback({ kind: "error", text: "Could not copy. Long-press the swatch instead." });
    }
  }
  State.notify();
}

async function launchShortcut(shortcut: ToolShortcut): Promise<void> {
  setShortcutError(null);
  State.notify();
  try {
    if (shortcut.kind === "folder") await Bridge.toolsOpenFolder(shortcut.target);
    else await Bridge.toolsLaunchApp(shortcut.target);
  } catch (err) {
    setShortcutError(actionable(err));
  }
  State.notify();
}

async function saveShortcutForm(): Promise<void> {
  const form = getShortcutForm();
  if (!form) return;
  const name = cleanShortcutName(form.name);
  if (!name) {
    setShortcutForm({ ...form, error: "Give the shortcut a short name." });
    State.notify();
    return;
  }
  const shape = validateShortcutShape(form.kind, form.target);
  if (shape) {
    setShortcutForm({ ...form, error: shape });
    State.notify();
    return;
  }
  if (form.editingId) {
    const existing = shortcutById(form.editingId);
    const refs = routinesUsing(form.editingId);
    if (existing && refs.length > 0 && existing.target.trim() !== form.target.trim() && !form.confirmSave) {
      setShortcutForm({ ...form, confirmSave: true, error: null });
      State.notify();
      return;
    }
  }
  if (IS_TAURI) {
    try {
      await Bridge.toolsValidateTarget(form.kind, form.target.trim());
    } catch (err) {
      setShortcutForm({ ...form, error: actionable(err) });
      State.notify();
      return;
    }
  }
  const id = form.editingId && isValidId(form.editingId) ? form.editingId : makeId("sc");
  const entry: ToolShortcut = { id, name, kind: form.kind, target: form.target.trim() };
  await persistTools((data) => {
    const shortcuts = form.editingId
      ? data.shortcuts.map((s) => (s.id === id ? entry : s))
      : [...data.shortcuts, entry];
    return { ...data, shortcuts: shortcuts.slice(0, 100) };
  });
  setShortcutForm(null);
  setShortcutError(null);
  State.notify();
}

async function deleteShortcut(id: string): Promise<void> {
  if (routinesUsing(id).length > 0 && getDeleteConfirmId() !== id) {
    setDeleteConfirmId(id);
    State.notify();
    return;
  }
  await persistTools((data) => {
    const shortcuts = data.shortcuts.filter((s) => s.id !== id);
    // Confirmed, never silent: the routines that lose this step are named in
    // the confirm row, and routines left empty go away with it.
    const routines = data.routines
      .map((r) => ({ ...r, steps: r.steps.filter((step) => step !== id) }))
      .filter((r) => r.steps.length > 0);
    return { ...data, shortcuts, routines };
  });
  const selected = getRoutineSelectedId();
  if (selected && !routineById(selected)) setRoutineSelectedId(null);
  setDeleteConfirmId(null);
  State.notify();
}

async function saveRoutineForm(): Promise<void> {
  const form = getRoutineForm();
  if (!form) return;
  const name = cleanShortcutName(form.name);
  if (!name) {
    setRoutineForm({ ...form, error: "Give the routine a short name." });
    State.notify();
    return;
  }
  if (form.steps.length === 0) {
    setRoutineForm({ ...form, error: "Add at least one shortcut step." });
    State.notify();
    return;
  }
  if (form.steps.some((id) => !shortcutById(id))) {
    setRoutineForm({ ...form, error: "A step no longer exists. Remove it first." });
    State.notify();
    return;
  }
  const id = form.editingId && isValidId(form.editingId) ? form.editingId : makeId("rt");
  const entry: ToolRoutine = { id, name, steps: [...form.steps] };
  await persistTools((data) => {
    const routines = form.editingId
      ? data.routines.map((r) => (r.id === id ? entry : r))
      : [...data.routines, entry];
    return { ...data, routines: routines.slice(0, 30) };
  });
  setRoutineForm(null);
  setRoutineError(null);
  State.notify();
}

async function runRoutine(routine: ToolRoutine): Promise<void> {
  if (!beginRoutine(routine.id)) {
    setRoutineError("A routine is already running. Wait for it to finish or cancel it.");
    State.notify();
    return;
  }
  const resolved = resolveRoutineSteps(routine);
  if (resolved.some((s) => s.missing)) {
    finishRoutine(routine.id);
    setRoutineError("A step no longer exists. Edit the routine first.");
    State.notify();
    return;
  }
  setRoutineError(null);
  setRoutineResults(routine.id, []);
  State.notify();
  try {
    const results = await Bridge.toolsRoutineStart(
      routine.id,
      resolved.map((s) => ({ id: s.id, kind: s.kind, target: s.target })),
    );
    setRoutineResults(routine.id, results ?? []);
  } catch (err) {
    setRoutineError(actionable(err));
  }
  finishRoutine(routine.id);
  State.notify();
}

/** Island height follows the open tab and its content, clamped to the card.
 * Open forms hide the list behind them; long step previews scroll inside
 * (scrollbars stay hidden) instead of growing past the panel. */
export function toolsIslandHeight(): number {
  const data = readTools();
  switch (getToolsTab()) {
    case "shortcuts": {
      if (getShortcutForm()) return 248;
      const filtered = filterShortcuts(data.shortcuts, getShortcutQuery());
      const shown = Math.min(SHORTCUT_PAGE, filtered.length);
      const pages = Math.max(1, Math.ceil(filtered.length / SHORTCUT_PAGE));
      return Math.min(256, 200 + shown * 16 + (pages > 1 ? 22 : 0));
    }
    case "routines": {
      if (getRoutineForm()) return 256;
      const selected = getRoutineSelectedId();
      if (selected) {
        const found = routineById(selected);
        return Math.min(300, 232 + (found ? found.steps.length : 0) * 6);
      }
      const shown = Math.min(ROUTINE_PAGE, data.routines.length);
      return Math.min(248, 204 + shown * 10);
    }
    default: {
      const rows = Math.max(1, Math.ceil(data.colours.length / 12));
      return 184 + rows * 14;
    }
  }
}

const updaters = new WeakMap<HTMLElement, () => void>();

function feedbackLine(text: string | null, kind: "error" | "ok"): HTMLElement | null {
  if (!text) return null;
  return h("div", { class: `tools-feedback ${kind}`, role: "status", text });
}

function pager(page: number, pages: number, onPage: (page: number) => void): HTMLElement | null {
  if (pages <= 1) return null;
  const prev = h("button", {
    class: "tools-page", type: "button", text: "Prev",
    onclick: () => onPage(page - 1),
  }) as HTMLButtonElement;
  const next = h("button", {
    class: "tools-page", type: "button", text: "Next",
    onclick: () => onPage(page + 1),
  }) as HTMLButtonElement;
  prev.disabled = page <= 0;
  next.disabled = page >= pages - 1;
  return h("div", { class: "tools-pager" },
    prev,
    h("span", { class: "tools-count", text: `${page + 1}/${pages}` }),
    next);
}

function statusClass(status: string): string {
  if (status === "ok") return "ok";
  if (status === "failed") return "err";
  return "dim";
}

/** The Tools card. The island header already says Tools, so no heading here. */
export function toolsCard(): HTMLElement {
  const tabsEl = h("div", { class: "tools-tabs", role: "tablist" });
  const tabBtns = new Map<string, HTMLElement>();
  for (const tab of [["colours", "Colours"], ["shortcuts", "Shortcuts"], ["routines", "Routines"]] as const) {
    const btn = h("button", {
      class: "tools-tab", role: "tab", type: "button",
      id: `tools-tab-${tab[0]}`, text: tab[1],
      onclick: () => {
        if (getToolsTab() !== tab[0]) {
          setToolsTab(tab[0]);
          State.notify();
        }
      },
    });
    btn.setAttribute("aria-controls", `tools-panel-${tab[0]}`);
    tabBtns.set(tab[0], btn);
    tabsEl.append(btn);
  }

  // Colours panel: static input row, rebuilt swatches.
  const hexInput = h("input", {
    class: "tools-input", type: "text", placeholder: "#1ED760",
    maxlength: "9", value: getColourInput(),
    "aria-label": "HEX colour",
  }) as HTMLInputElement;
  hexInput.addEventListener("input", () => setColourInput(hexInput.value));
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void addColourFromInput(hexInput);
  });
  const colourCount = h("span", { class: "tools-count", text: "" });
  const colourFeedback = h("div", {});
  const swatches = h("div", { class: "tools-swatches" });
  const clearRow = h("div", { class: "tools-clearrow" });
  const coloursPanel = h("div", { class: "tools-panel", role: "tabpanel", id: "tools-panel-colours" },
    h("div", { class: "tools-addrow" },
      hexInput,
      h("button", { class: "tools-btn", type: "button", text: "Add", onclick: () => void addColourFromInput(hexInput) }),
      colourCount),
    colourFeedback, swatches, clearRow);

  async function addColourFromInput(input: HTMLInputElement): Promise<void> {
    const { colours, error } = addColour(readTools().colours, getColourInput());
    if (error) {
      setColourFeedback({ kind: "error", text: error });
      State.notify();
      return;
    }
    await persistTools((data) => ({ ...data, colours }));
    setColourInput("");
    input.value = "";
    setColourFeedback(null);
    State.notify();
    input.focus();
  }

  // Shortcuts panel: static search row and form shell, rebuilt list.
  const searchInput = h("input", {
    class: "tools-input", type: "text", placeholder: "Search shortcuts…",
    value: getShortcutQuery(), "aria-label": "Search shortcuts",
  }) as HTMLInputElement;
  searchInput.addEventListener("input", () => {
    setShortcutQuery(searchInput.value);
    State.notify();
  });
  const shortcutFeedback = h("div", {});
  const shortcutList = h("div", { class: "tools-list" });
  const shortcutPager = h("div", {});
  const shortcutFormWrap = h("div", {});
  const shortcutsPanel = h("div", { class: "tools-panel", role: "tabpanel", id: "tools-panel-shortcuts" },
    h("div", { class: "tools-addrow" },
      searchInput,
      h("button", {
        class: "tools-btn", type: "button", text: "App…",
        onclick: () => {
          setShortcutForm({ editingId: null, name: "", kind: "app", target: "", error: null, confirmSave: false });
          State.notify();
        },
      }),
      h("button", {
        class: "tools-btn", type: "button", text: "Folder…",
        onclick: () => {
          setShortcutForm({ editingId: null, name: "", kind: "folder", target: "", error: null, confirmSave: false });
          State.notify();
        },
      })),
    shortcutFeedback, shortcutFormWrap, shortcutList, shortcutPager);

  // Routines panel: static new button, rebuilt list and form.
  const routineFeedback = h("div", {});
  const routineFormWrap = h("div", {});
  const routineList = h("div", { class: "tools-list" });
  const routinePager = h("div", {});
  const routinesPanel = h("div", { class: "tools-panel", role: "tabpanel", id: "tools-panel-routines" },
    h("div", { class: "tools-addrow" },
      h("span", { class: "tools-hint", text: "Ordered shortcut lists. Steps show before every run." }),
      h("button", {
        class: "tools-btn", type: "button", text: "New…",
        onclick: () => {
          setRoutineForm({ editingId: null, name: "", steps: [], error: null });
          State.notify();
        },
      })),
    routineFeedback, routineFormWrap, routineList, routinePager);

  const root = h("div", { class: "int-card tools-card" }, tabsEl, coloursPanel, shortcutsPanel, routinesPanel);

  let renderedShortcutKey = "";
  let renderedRoutineKey = "";

  const update = () => {
    const data = readTools();
    const tab = getToolsTab();
    for (const [id, btn] of tabBtns) {
      const on = id === tab;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    coloursPanel.hidden = tab !== "colours";
    shortcutsPanel.hidden = tab !== "shortcuts";
    routinesPanel.hidden = tab !== "routines";
    if (tab === "colours") updateColours(data);
    else if (tab === "shortcuts") updateShortcuts(data);
    else updateRoutines(data);
  };

  function updateColours(data: ToolsData): void {
    colourCount.textContent = `${data.colours.length}/${MAX_COLOURS}`;
    clear(colourFeedback);
    const fb = getColourFeedback();
    const line = feedbackLine(fb?.text ?? null, fb?.kind ?? "error");
    if (line) colourFeedback.append(line);
    clear(swatches);
    if (data.colours.length === 0) {
      swatches.append(h("div", { class: "tools-empty", text: "No colours yet. Add a HEX value above." }));
    }
    for (const hex of data.colours) {
      const swatch = h("button", {
        class: "tools-swatch", type: "button", title: `Copy ${hex}`,
        "aria-label": `Copy ${hex}`,
        style: `background:${hex}`,
        onclick: () => void copyHex(hex),
      });
      const remove = h("button", {
        class: "tools-x", type: "button", text: "×",
        title: `Remove ${hex}`, "aria-label": `Remove ${hex}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          void persistTools((d) => ({
            ...d,
            colours: d.colours.filter((c) => c.toUpperCase() !== hex.toUpperCase()),
          })).then(() => hexInput.focus());
        },
      });
      swatches.append(h("span", { class: "tools-swatchwrap" }, swatch, remove));
    }
    clear(clearRow);
    if (data.colours.length > 0) {
      if (!getClearConfirm()) {
        clearRow.append(h("button", {
          class: "tools-link", type: "button", text: "Clear all",
          onclick: () => { setClearConfirm(true); State.notify(); },
        }));
      } else {
        clearRow.append(
          h("span", { class: "tools-count", text: `Clear all ${data.colours.length}?` }),
          h("button", {
            class: "tools-link danger", type: "button", text: "Clear",
            onclick: () => void persistTools((d) => ({ ...d, colours: [] })).then(() => {
              setClearConfirm(false);
              State.notify();
            }),
          }),
          h("button", {
            class: "tools-link", type: "button", text: "Keep",
            onclick: () => { setClearConfirm(false); State.notify(); },
          }));
      }
    }
  }

  function updateShortcuts(data: ToolsData): void {
    clear(shortcutFeedback);
    const err = feedbackLine(getShortcutError(), "error");
    if (err) shortcutFeedback.append(err);

    // The form rebuilds only when its identity changes, so typing never
    // loses focus or caret position.
    const form = getShortcutForm();
    const formKey = form ? `${form.editingId ?? "new"}|${form.kind}` : "";
    if (formKey !== renderedShortcutKey) {
      renderedShortcutKey = formKey;
      clear(shortcutFormWrap);
      if (form) shortcutFormWrap.append(buildShortcutForm(form));
    } else if (form) {
      const line = shortcutFormWrap.querySelector(".tools-feedback");      if (line) {
        line.remove();
        const fresh = feedbackLine(form.error, "error");
        if (fresh) shortcutFormWrap.append(fresh);
      }
      const confirm = shortcutFormWrap.querySelector(".tools-confirm");
      if (confirm && !form.confirmSave) confirm.remove();
      if (!confirm && form.confirmSave && form.editingId) {
        shortcutFormWrap.append(buildEditConfirm(form));
      }
    }

    clear(shortcutList);
    const filtered = filterShortcuts(data.shortcuts, getShortcutQuery());
    const page = paginate(filtered, getShortcutPage(), SHORTCUT_PAGE);
    // An open form takes the list's place so the card stays compact.
    const formOpen = getShortcutForm() != null;
    shortcutList.style.display = formOpen ? "none" : "";
    shortcutPager.style.display = formOpen ? "none" : "";
    if (filtered.length === 0) {
      shortcutList.append(h("div", {
        class: "tools-empty",
        text: data.shortcuts.length === 0 ? "No shortcuts yet. Add an app or a folder above." : "No shortcuts match.",
      }));
    }
    for (const s of page.items) {
      shortcutList.append(buildShortcutTile(s));
    }
    clear(shortcutPager);
    const pagerEl = pager(page.page, page.pages, (p) => { setShortcutPage(p); State.notify(); });
    if (pagerEl) shortcutPager.append(pagerEl);
  }

  function buildShortcutForm(form: { editingId: string | null; name: string; kind: "app" | "folder"; target: string; error: string | null; confirmSave: boolean }): HTMLElement {
    const nameInput = h("input", {
      class: "tools-input", type: "text", placeholder: "Name", maxlength: "60",
      value: form.name, "aria-label": "Shortcut name",
    }) as HTMLInputElement;
    nameInput.addEventListener("input", () => {
      const current = getShortcutForm();
      if (current) setShortcutForm({ ...current, name: nameInput.value });
    });
    const targetInput = h("input", {
      class: "tools-input", type: "text", placeholder: form.kind === "app" ? "C:\\Tools\\app.exe" : "C:\\Tools",
      value: form.target, "aria-label": "Shortcut target", spellcheck: "false",
    }) as HTMLInputElement;
    targetInput.addEventListener("input", () => {
      const current = getShortcutForm();
      if (current) setShortcutForm({ ...current, target: targetInput.value, confirmSave: false });
    });
    const kindApp = h("button", {
      class: `tools-seg${form.kind === "app" ? " on" : ""}`, type: "button", text: "App",
      onclick: () => {
        const current = getShortcutForm();
        if (current && current.kind !== "app") {
          setShortcutForm({ ...current, kind: "app", error: null, confirmSave: false });
          State.notify();
        }
      },
    });
    const kindFolder = h("button", {
      class: `tools-seg${form.kind === "folder" ? " on" : ""}`, type: "button", text: "Folder",
      onclick: () => {
        const current = getShortcutForm();
        if (current && current.kind !== "folder") {
          setShortcutForm({ ...current, kind: "folder", error: null, confirmSave: false });
          State.notify();
        }
      },
    });
    const wrap = h("div", { class: "tools-form" },
      h("div", { class: "tools-segrow" }, kindApp, kindFolder),
      nameInput,
      h("div", { class: "tools-targetrow" },
        targetInput,
        h("button", {
          class: "tools-btn", type: "button", text: "Browse…",
          title: "Choose with the system picker",
          onclick: () => void (async () => {
            const picked = form.kind === "app" ? await Bridge.toolsPickFile() : await Bridge.toolsPickFolder();
            if (picked) {
              const current = getShortcutForm();
              if (current) setShortcutForm({ ...current, target: picked, error: null, confirmSave: false });
              targetInput.value = picked;
              targetInput.focus();
            }
          })(),
        })),
      h("div", { class: "tools-formrow" },
        h("button", { class: "tools-btn primary", type: "button", text: form.editingId ? "Save" : "Add", onclick: () => void saveShortcutForm() }),
        h("button", {
          class: "tools-link", type: "button", text: "Cancel",
          onclick: () => { setShortcutForm(null); State.notify(); },
        })));
    const line = feedbackLine(form.error, "error");
    if (line) wrap.append(line);
    if (form.confirmSave && form.editingId) wrap.append(buildEditConfirm(form));
    window.setTimeout(() => nameInput.focus(), 0);
    return wrap;
  }

  function buildEditConfirm(form: { editingId: string | null }): HTMLElement {
    const refs = form.editingId ? routinesUsing(form.editingId) : [];
    return h("div", { class: "tools-confirm" },
      h("span", { text: `Used in ${refs.map((r) => r.name).join(", ")}. Save anyway?` }),
      h("button", {
        class: "tools-btn primary", type: "button", text: "Save",
        onclick: () => {
          const current = getShortcutForm();
          if (current) setShortcutForm({ ...current, confirmSave: true });
          void saveShortcutForm();
        },
      }),
      h("button", {
        class: "tools-link", type: "button", text: "Back",
        onclick: () => {
          const current = getShortcutForm();
          if (current) setShortcutForm({ ...current, confirmSave: false });
          State.notify();
        },
      }));
  }

  function buildShortcutTile(s: ToolShortcut): HTMLElement {
    const tile = h("div", { class: "tools-tile" });
    const open = h("button", {
      class: "tools-open", type: "button", title: s.target,
      "aria-label": `Launch ${s.name}`,
      onclick: () => void launchShortcut(s),
    },
      h("span", { class: "tools-kind", text: s.kind === "app" ? "APP" : "DIR" }),
      h("span", { class: "tools-names" },
        h("b", { text: s.name }),
        h("small", { text: s.target })));
    tile.append(open,
      h("button", {
        class: "tools-mini", type: "button", text: "Edit",
        "aria-label": `Edit ${s.name}`,
        onclick: () => {
          setShortcutForm({ editingId: s.id, name: s.name, kind: s.kind, target: s.target, error: null, confirmSave: false });
          setDeleteConfirmId(null);
          State.notify();
        },
      }),
      h("button", {
        class: "tools-mini", type: "button", text: "Del",
        "aria-label": `Delete ${s.name}`,
        onclick: () => void deleteShortcut(s.id),
      }));
    if (getDeleteConfirmId() === s.id) {
      const refs = routinesUsing(s.id);
      tile.append(h("div", { class: "tools-confirm" },
        h("span", {
          text: refs.length > 0
            ? `Delete? ${refs.map((r) => r.name).join(", ")} ${refs.length === 1 ? "loses" : "lose"} this step${refs.every((r) => r.steps.length === 1) ? " and goes away" : ""}.`
            : "Delete this shortcut?",
        }),
        h("button", {
          class: "tools-btn primary", type: "button", text: "Delete",
          onclick: () => void deleteShortcut(s.id),
        }),
        h("button", {
          class: "tools-link", type: "button", text: "Keep",
          onclick: () => { setDeleteConfirmId(null); State.notify(); },
        })));
    }
    return tile;
  }

  function updateRoutines(data: ToolsData): void {
    clear(routineFeedback);
    const running = getRunningRoutineId();
    const err = feedbackLine(getRoutineError() ?? (running ? `Running ${routineById(running)?.name ?? "routine"}…` : null), getRoutineError() ? "error" : "ok");
    if (err) routineFeedback.append(err);

    const form = getRoutineForm();
    const formKey = form ? `${form.editingId ?? "new"}` : "";
    if (formKey !== renderedRoutineKey) {
      renderedRoutineKey = formKey;
      clear(routineFormWrap);
      if (form) routineFormWrap.append(buildRoutineForm(form, data));
    } else if (form) {
      const line = routineFormWrap.querySelector(".tools-feedback");
      if (line) {
        line.remove();
        const fresh = feedbackLine(form.error, "error");
        if (fresh) routineFormWrap.append(fresh);
      }
      const stepsBox = routineFormWrap.querySelector(".tools-formsteps");
      if (stepsBox) {
        clear(stepsBox);
        stepsBox.append(...formStepRows(form));
      }
    }

    clear(routineList);
    const page = paginate(data.routines, getRoutinePage(), ROUTINE_PAGE);
    // An open form takes the list's place so the card stays compact.
    const routineFormOpen = getRoutineForm() != null;
    routineList.style.display = routineFormOpen ? "none" : "";
    routinePager.style.display = routineFormOpen ? "none" : "";
    if (data.routines.length === 0) {
      routineList.append(h("div", { class: "tools-empty", text: "No routines yet. Bundle shortcuts into a one-tap chore." }));
    }
    for (const r of page.items) {
      routineList.append(buildRoutineRow(r, running));
    }
    clear(routinePager);
    const pagerEl = pager(page.page, page.pages, (p) => { setRoutinePage(p); State.notify(); });
    if (pagerEl) routinePager.append(pagerEl);
  }

  function buildRoutineForm(form: { editingId: string | null; name: string; steps: string[]; error: string | null }, data: ToolsData): HTMLElement {
    const nameInput = h("input", {
      class: "tools-input", type: "text", placeholder: "Routine name", maxlength: "60",
      value: form.name, "aria-label": "Routine name",
    }) as HTMLInputElement;
    nameInput.addEventListener("input", () => {
      const current = getRoutineForm();
      if (current) setRoutineForm({ ...current, name: nameInput.value });
    });
    const options = data.shortcuts.filter((s) => !form.steps.includes(s.id));
    const picker = h("select", { class: "tools-input", "aria-label": "Add a shortcut step" }) as HTMLSelectElement;
    picker.append(h("option", { value: "", text: "Add a step…" }));
    for (const s of options) picker.append(h("option", { value: s.id, text: s.name }));
    const wrap = h("div", { class: "tools-form" },
      nameInput,
      h("div", { class: "tools-formsteps" }, ...formStepRows(form)),
      h("div", { class: "tools-targetrow" },
        picker,
        h("button", {
          class: "tools-btn", type: "button", text: "Add",
          onclick: () => {
            if (!picker.value) return;
            const current = getRoutineForm();
            if (current && current.steps.length < 20) {
              setRoutineForm({ ...current, steps: [...current.steps, picker.value], error: null });
              State.notify();
            }
          },
        })),
      h("div", { class: "tools-formrow" },
        h("button", { class: "tools-btn primary", type: "button", text: form.editingId ? "Save" : "Add", onclick: () => void saveRoutineForm() }),
        h("button", {
          class: "tools-link", type: "button", text: "Cancel",
          onclick: () => { setRoutineForm(null); State.notify(); },
        })));
    const line = feedbackLine(form.error, "error");
    if (line) wrap.append(line);
    window.setTimeout(() => nameInput.focus(), 0);
    return wrap;
  }

  function formStepRows(form: { steps: string[] }): HTMLElement[] {
    return form.steps.map((id, index) => {
      const found = shortcutById(id);
      const row = h("div", { class: "tools-formstep" },
        h("span", { class: "tools-stepname", text: found ? found.name : `${id} (missing)` }));
      const up = h("button", { class: "tools-mini", type: "button", text: "↑", title: "Move up", "aria-label": "Move step up" }) as HTMLButtonElement;
      const down = h("button", { class: "tools-mini", type: "button", text: "↓", title: "Move down", "aria-label": "Move step down" }) as HTMLButtonElement;
      up.disabled = index === 0;
      down.disabled = index === form.steps.length - 1;
      up.onclick = () => {
        const current = getRoutineForm();
        if (!current) return;
        const steps = [...current.steps];
        [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
        setRoutineForm({ ...current, steps });
        State.notify();
      };
      down.onclick = () => {
        const current = getRoutineForm();
        if (!current) return;
        const steps = [...current.steps];
        [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
        setRoutineForm({ ...current, steps });
        State.notify();
      };
      row.append(up, down,
        h("button", {
          class: "tools-mini", type: "button", text: "×", title: "Remove step", "aria-label": "Remove step",
          onclick: () => {
            const current = getRoutineForm();
            if (!current) return;
            setRoutineForm({ ...current, steps: current.steps.filter((_, i) => i !== index) });
            State.notify();
          },
        }));
      return row;
    });
  }

  function buildRoutineRow(r: ToolRoutine, running: string | null): HTMLElement {
    const selected = getRoutineSelectedId() === r.id;
    const row = h("div", { class: "tools-routine" });
    row.append(h("button", {
      class: `tools-routinehead${selected ? " on" : ""}`, type: "button",
      "aria-expanded": selected ? "true" : "false",
      onclick: () => {
        setRoutineSelectedId(selected ? null : r.id);
        State.notify();
      },
    },
      h("b", { text: r.name }),
      h("span", { class: "tools-count", text: `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}` })));
    if (!selected) return row;
    const resolved = resolveRoutineSteps(r);
    const steps = h("ol", { class: "tools-steps" });
    for (const [index, s] of resolved.entries()) {
      steps.append(h("li", { class: s.missing ? "missing" : "" },
        h("span", { class: "tools-stepnum", text: `${index + 1}.` }),
        h("span", { text: s.missing ? `${s.id} (missing, edit the routine)` : `${s.name}: ${s.target}` })));
    }
    row.append(steps);
    const results = getRoutineResults(r.id);
    if (results && results.length > 0) {
      const out = h("ol", { class: "tools-steps results" });
      for (const result of results) {
        const name = shortcutById(result.id)?.name ?? result.id;
        out.append(h("li", { class: statusClass(result.status) }, h("span", { text: `${name}: ${result.message}` })));
      }
      row.append(out);
    }
    const actions = h("div", { class: "tools-formrow" });
    if (running === r.id) {
      actions.append(h("button", {
        class: "tools-btn", type: "button", text: "Cancel",
        onclick: () => void Bridge.toolsRoutineCancel(),
      }));
    } else {
      const run = h("button", { class: "tools-btn primary", type: "button", text: "Run" }) as HTMLButtonElement;
      run.disabled = running != null;
      run.title = running != null ? "Another routine is running" : `Run ${r.name}: ${resolved.map((s) => s.name).join(", ")}`;
      run.onclick = () => void runRoutine(r);
      actions.append(run);
    }
    actions.append(
      h("button", {
        class: "tools-mini", type: "button", text: "Edit",
        onclick: () => {
          setRoutineForm({ editingId: r.id, name: r.name, steps: [...r.steps], error: null });
          State.notify();
        },
      }),
      h("button", {
        class: "tools-mini", type: "button", text: "Del",
        onclick: () => void persistTools((data) => ({
          ...data,
          routines: data.routines.filter((x) => x.id !== r.id),
        })).then(() => {
          if (getRoutineSelectedId() === r.id) setRoutineSelectedId(null);
          State.notify();
        }),
      }));
    row.append(actions);
    return row;
  }

  update();
  updaters.set(root, update);
  return root;
}

/** Refreshes the mounted Tools card in place, keeping focus in its fields. */
export function updateToolsCard(el: HTMLElement | null): void {
  if (!el) return;
  updaters.get(el)?.();
}
