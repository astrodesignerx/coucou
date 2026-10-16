// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, onEvent, type ChatContext, type ModelInfo } from "../core/bridge";
import {
  activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef,
} from "../core/providers";
import { isLocalEngine } from "../choom/laya";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  // Choom: an empty agent model runs OpenCode's own default.
  agentDefault: N_("OpenCode default"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
};

let nextId = 1;

/** Request owner fence: every submit captures the owner; cancel and reset
 * invalidate it so late replies can never mutate history or the view. The
 * busy guard is owner-scoped too, so an old finally can never clear a new
 * request's guard. */
let chatOwner = 0;
let chatSender: number | null = null;

export function currentChatOwner(): number {
  return chatOwner;
}

function invalidateChatOwner(): void {
  chatOwner += 1;
}

/**
 * Shared chat submission for typed and voice turns. One history, one
 * provider, one cancellation path. Voice passes its finalized text here;
 * interim words never reach this function. The captured owner must still
 * own the turn when the reply lands, or the reply is dropped silently.
 */
export async function submitChatTurn(
  query: string,
  context: ChatContext | null,
  onHeightChange: () => void,
  owner: number = currentChatOwner(),
): Promise<{ text: string } | { error: string }> {
  const trimmed = query.trim();
  if (!trimmed || chatSender != null) return { error: "busy" };
  chatSender = owner;
  Sound.play("send");
  State.chatHistory.push({ id: nextId++, role: "user", content: trimmed });
  State.stateOverride = "thinking";
  State.notify();
  onHeightChange();
  try {
    const reply = await Bridge.chatSend(trimmed, context);
    // Cancel or reset invalidated this owner while the request flew: the
    // native side already dropped its history write, so drop the view write.
    if (owner !== chatOwner) return { error: "cancelled" };
    State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
    State.stateOverride = null;
    Sound.play("finish");
    return { text: reply.text };
  } catch (err) {
    if (owner !== chatOwner) return { error: "cancelled" };
    State.stateOverride = null;
    const message = String(err).replace(/^Error:\s*/, "");
    State.noteMessage = message;
    State.view = "note";
    Sound.play("error");
    return { error: message };
  } finally {
    // Only the owning request clears the guard: a late finally from a
    // cancelled turn can never unlock a newer request's busy state.
    if (chatSender === owner) chatSender = null;
    State.notify();
    onHeightChange();
  }
}

/** Cancels the owned in-flight request; the late reply is dropped unheard. */
export function cancelChatTurn(): void {
  invalidateChatOwner();
  void Bridge.chatCancel();
}

/** Drops history and invalidates the owner, so nothing late can land. */
export function resetChatTurn(): void {
  invalidateChatOwner();
  void Bridge.chatReset();
}

export function isChatSending(): boolean {
  return chatSender != null;
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  const el = h("div", { class: "picker" }, chips, h("div", { class: "picker-rule" }), list);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    onChange();
    void loadModels();
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(
  onHeightChange: () => void,
  opts: { onMic?: () => void } = {},
): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const mic = h("button", { class: "send-btn chat-mic", title: "Talk instead (Ctrl+Shift+V)" }, svg(ICONS.bubble, 11));
  mic.addEventListener("click", () => opts.onMic?.());
  const bar = h("div", { class: "chat-bar" }, input, mic, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const modelRow = h("div", { class: "model-row" }, modelBtn);

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    drawModelButton();
  });
  body.append(chipRow, log, picker.el, modelRow, bar);

  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    modelName.textContent = activeModel(State.settings) ||
      t(State.settings.chatProvider === "opencode-agent" ? STRINGS.agentDefault : STRINGS.noModel);
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
  }

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, text);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    input.value = "";
    sending = true;
    drawModelButton(); // no model change while a turn is in flight
    // Bounded Jev record for typed turns. Scope limit: this legacy entry is
    // Shadow only until it shares the voice controller. It records without
    // altering the send, so in Assisted mode it never acts on the decision.
    // Voice manual input keeps using the shared controller in voiceSection.
    // Unfenced (null generation) so cancellation fencing stays voice-scoped.
    // The backend rechecks opt-in, mode and credential, so this stays safe.
    // With Local Laya selected no Jev request is made at all: the local
    // engine has no cloud mode, and this shadow call would be one. The
    // choice is checked again once the status resolves, because the engine
    // can change while that call is in flight. The deliberately selected
    // chat provider below is untouched by either engine.
    const jevMode = (State.settings.jevMode ?? "shadow") as string;
    if (State.settings.jevEnabled && jevMode === "shadow" && !isLocalEngine(State.settings)) {
      void Bridge.jevStatus().then((status) => {
        // Rechecked on arrival: a Local Laya selection made while this was
        // pending must not turn into a request.
        if (isLocalEngine(State.settings)) return undefined;
        if (status?.configured) return Bridge.jevDecide(query.slice(0, 500), [], null);
        return undefined;
      }).catch(() => undefined);
    }
    const file = State.droppedFile;
    // First turn with a dropped file carries it, like before.
    const willBeFirst = State.chatHistory.length === 0;
    const context: ChatContext | null =
      willBeFirst && file ? { kind: "file", name: file.name, path: file.path } : null;
    // One implementation for typed and voice turns: the owner fence drops a
    // reply that a cancel or reset invalidated mid-flight.
    await submitChatTurn(query, context, onHeightChange);
    sending = false;
    // A streamed reply is replaced by the finished answer.
    live = null;
    renderedCount = -1;
    drawModelButton();
    input.focus();
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      el.classList.toggle("chat-empty", State.chatHistory.length === 0 && !sending);
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      drawModelButton();

      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
