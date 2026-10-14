// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerPhoneLink } from "./island/phone-link";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerNowPlaying } from "./choom/nowPlaying";
import { registerNotifications } from "./choom/notifications";
import { registerQuickAdditions } from "./choom/quickAdditions";
import { registerTools } from "./choom/tools";
import { Voice } from "./choom/voice";
import { cancelVoice, handleVoiceEvent, localVoiceStandby, rearmWake, registerVoiceIsland, startVoice } from "./choom/voiceSection";
import { parseHubCategory } from "./settings/hub";
import type { BatterySnapshot } from "./core/bridge";
import { registerShortcutHandlers } from "./island/shortcuts";
import { applySpotify, registerSpotifyHandlers } from "./island/spotify";
import { SPOTIFY_ID } from "./core/spotify";
import { Recap } from "./recap/recap";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";

/** Shows the language Settings asks for ("" = the system's, when Coucou has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot && !boot.cursorPoll) island.followPageCursor();
  await island.desktop.init();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<null>("foreground-changed", () => island.onWindowFocusShift());
  await onEvent<boolean>("pointer-inside", (inside) => island.setPointerInside(inside));

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
        island.showSettingsHome();
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // Settings → Reload sounds: read the sounds folder again, and let them hear it.
  await onEvent<null>("sounds-changed", () => {
    void Sound.reload().then(() => Sound.play("pop"));
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    State.settings = { ...State.settings, ...s };
    if (s.voiceMode === "auto" || s.voiceMode === "a" || s.voiceMode === "b" || s.voiceMode === "c") {
      Voice.state.deckPin = s.voiceMode;
    }
    Voice.state.memoryEnabled = s.voiceMemoryEnabled;
    if (!s.voiceEnabled) void cancelVoice();
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as on macOS.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerPhoneLink(island);
  registerIntegrationHandlers(island);
  registerNowPlaying();
  registerNotifications();
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
  registerShortcutHandlers(island, () => setPaused(false));
  registerSpotifyHandlers(island);
  // Rust may have read Spotify before this page listened: ask once.
  if (State.settings.activeIntegrations.includes(SPOTIFY_ID)) {
    void Bridge.spotifyRefresh().then((s) => s && applySpotify(island, s));
  }

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = checkRecap;
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();

  // Inline settings deep links (voice deck, browser fixture): the island owns
  // the route, so no second native window ever opens from here. Unknown ids
  // fall back to the hub home instead of opening the wrong room.
  window.addEventListener("coucou:open-settings", (e) => {
    const category = parseHubCategory(
      (e as CustomEvent<{ category?: unknown }>).detail?.category,
    );
    setPaused(false);
    if (category) {
      island.openSettingsCategory(category);
    } else {
      island.showSettingsHome();
    }
  });

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
