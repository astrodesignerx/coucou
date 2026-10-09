// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;
let chatSending = false;

/**
 * Shared chat submission for typed and voice turns. One history, one
 * provider, one cancellation path. Voice passes its finalized text here;
 * interim words never reach this function.
 */
export async function submitChatTurn(
  query: string,
  context: ChatContext | null,
  onHeightChange: () => void,
): Promise<{ text: string } | { error: string }> {
  const trimmed = query.trim();
  if (!trimmed || chatSending) return { error: "busy" };
  chatSending = true;
  Sound.play("send");
  State.chatHistory.push({ id: nextId++, role: "user", content: trimmed });
  State.stateOverride = "thinking";
  State.notify();
  onHeightChange();
  try {
    const reply = await Bridge.chatSend(trimmed, context);
    State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
    State.stateOverride = null;
    Sound.play("finish");
    return { text: reply.text };
  } catch (err) {
    State.stateOverride = null;
    const message = String(err).replace(/^Error:\s*/, "");
    State.noteMessage = message;
    State.view = "note";
    Sound.play("error");
    return { error: message };
  } finally {
    chatSending = false;
    State.notify();
    onHeightChange();
  }
}

export function isChatSending(): boolean {
  return chatSending;
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
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

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view chat-empty" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    const file = State.droppedFile;
    // First turn with a dropped file carries it, like before.
    const willBeFirst = State.chatHistory.length === 0;
    const context: ChatContext | null =
      willBeFirst && file ? { kind: "file", name: file.name, path: file.path } : null;
    // Shared path so voice and typed turns share history and provider.
    // submitChatTurn owns its own sending flag; mirror it locally.
    chatSending = true;
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();
    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      chatSending = false;
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
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
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
