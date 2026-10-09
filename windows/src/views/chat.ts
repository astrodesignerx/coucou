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

/** Request owner fence: every submit captures the owner; cancel and reset
 * invalidate it so late replies can never mutate history or the view. */
let chatOwner = 0;

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
  if (!trimmed || chatSending) return { error: "busy" };
  chatSending = true;
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
    chatSending = false;
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

export function buildPrompt(
  onHeightChange: () => void,
  opts: { onMic?: () => void } = {},
): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const mic = h("button", { class: "send-btn chat-mic", title: "Talk instead (Ctrl+Shift+V)" }, svg(ICONS.bubble, 11));
  mic.addEventListener("click", () => opts.onMic?.());
  const bar = h("div", { class: "chat-bar" }, input, mic, send);

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
    // One implementation for typed and voice turns: the owner fence drops a
    // reply that a cancel or reset invalidated mid-flight.
    await submitChatTurn(query, context, onHeightChange);
    sending = false;
    input.focus();
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
