// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerNowPlaying } from "./choom/nowPlaying";
import { registerQuickAdditions } from "./choom/quickAdditions";
import { registerTools } from "./choom/tools";
import { Voice } from "./choom/voice";
import { cancelVoice, handleVoiceEvent, localVoiceStandby, rearmWake, registerVoiceIsland, startVoice } from "./choom/voiceSection";
import type { BatterySnapshot } from "./core/bridge";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<null>("foreground-changed", () => island.onWindowFocusShift());

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    if (s.voiceMode === "auto" || s.voiceMode === "a" || s.voiceMode === "b" || s.voiceMode === "c") {
      Voice.state.deckPin = s.voiceMode;
    }
    Voice.state.memoryEnabled = s.voiceMemoryEnabled;
    if (!s.voiceEnabled) void cancelVoice();
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  registerNowPlaying();
  registerTools();
  registerVoiceIsland(
    () => island.alert("voice"),
    () => island.reveal(),
  );
  // Voice deck pin survives automatic transitions; manual pin only.
  if (boot && typeof (boot.settings as { voiceMode?: string }).voiceMode === "string") {
    const pin = (boot.settings as { voiceMode?: string }).voiceMode;
    if (pin === "auto" || pin === "a" || pin === "b" || pin === "c") Voice.state.deckPin = pin;
  }
  if (boot) {
    Voice.state.runtime = State.settings.voiceEnabled ? "standby" : "disabled";
    Voice.state.memoryEnabled = State.settings.voiceMemoryEnabled;
  }
  await onEvent<Record<string, unknown>>("voice-event", (payload) =>
    handleVoiceEvent({ name: "voice-event", payload }),
  );
  // Native global hotkey: works while another app is focused.
  await onEvent<null>("voice-hotkey", () => {
    if (!State.settings.voiceEnabled || Voice.state.muted || State.paused) return;
    island.alert("voice");
    void startVoice();
  });
  await onEvent<string>("voice-hotkey-error", (message) => {
    Voice.state.error = message;
    Voice.notify();
  });
  // Native session lock, suspend, unlock and resume: capture already closed
  // Rust side, so only settle the UI here. Unlock and resume re-arm
  // opted-in wake; the native side re-arms too, and the call is idempotent.
  await onEvent<string>("voice-session", (what) => {
    if (what === "locked" || what === "suspended") {
      localVoiceStandby();
      return;
    }
    if ((what === "unlocked" || what === "resumed") && State.settings.voiceWakeEnabled && !State.paused) {
      void rearmWake();
    }
  });
  // Hotkey plus visible mic control. Escape cancels voice first.
  window.addEventListener("keydown", (e) => {
    const hotkey = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "V" || e.key === "v");
    if (hotkey) {
      e.preventDefault();
      island.alert("voice");
      void startVoice();
      return;
    }
    if (e.key === "Escape" && (Voice.state.runtime === "listening" || Voice.state.runtime === "speaking" || Voice.state.runtime === "working")) {
      e.stopPropagation();
      void cancelVoice();
    }
  }, { capture: true });
  registerQuickAdditions({
    snapshotVitals: () => Bridge.vitalsSnapshot(),
    snapshotBattery: () => Bridge.batterySnapshot(),
    subscribeBattery: (handler: (reading: BatterySnapshot) => void) => {
      // The Tauri listener resolves async; a disable in between must still
      // remove it instead of leaking a hidden observer.
      let off: (() => void) | null = null;
      let dead = false;
      void onEvent<BatterySnapshot>("battery", (reading) => {
        if (!dead) handler(reading);
      }).then((unsub) => {
        if (dead) unsub();
        else off = unsub;
      });
      return () => {
        dead = true;
        off?.();
      };
    },
    setNativeWatching: (on: boolean) => {
      void Bridge.setBatteryWatching(on);
    },
  });

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
