// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildVoiceView, toggleMute } from "../choom/voiceSection";
import { Voice } from "../choom/voice";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { buildSettingsInline, type SettingsInlineHost } from "./settingsInline";
import type { HubCategoryId } from "../settings/hub";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { updateNowPlayingCard } from "../choom/nowPlaying";
import { buildRail } from "../choom/rail";
import { MUSIC_ID } from "../choom/focus";
import {
  dismissToHome,
  isHomeVisible,
  isLaunchpadVisible,
  noteFocusSelected,
  showHome,
} from "../choom/landing";
import { landingHomeCard, landingLaunchpadCard } from "../choom/landingSection";
import { openVoiceEditor, startVoice, stopVoice } from "../choom/voiceSection";
import { JOBS_ID, UTILITY_ID } from "../choom/quickAdditions";
import { jobsCard, systemCard, updateJobsCard, updateSystemCard } from "../choom/quickAdditionsSection";
import { NOTIFICATIONS_ID, notificationsController } from "../choom/notifications";
import { notificationsPanel } from "../choom/notificationsSection";
import { TOOLS_ID } from "../choom/tools";
import { toolsCard, updateToolsCard } from "../choom/toolsSection";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, claudePillVisible, codexPillVisible, planCardOpen, refreshCodexPlanUsage,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildWardrobe } from "./wardrobe";
import { buildSpotifyCard } from "./spotify";
import { SPOTIFY_ID } from "../core/spotify";
import type { Outfit, OutfitSelection } from "../mochi/wardrobe";
import { language, t, tl, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  answer(answers: Record<string, string | string[]>): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  /** Header gear, tray and integration links: the same inline hub route. */
  showSettingsHome(): void;
  openSettingsCategory(id: HubCategoryId): void;
  blip(): void;
  /** Wardrobe click: keeps the outfit ("auto" and "none" included). */
  chooseOutfit(selection: OutfitSelection): void;
  /** Wardrobe hover: shows an outfit on Mochi without keeping it; null ends it. */
  previewOutfit(outfit: Outfit | null): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
  /** Releases listeners and timers. Views without one mount once. */
  dispose?(): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const modeDot = h("i", { class: "mode-dot" });
  const modeApp = h("strong", {});
  const modeState = h("span", { class: "mode-state" });
  const modeLabel = h("div", { class: "mode-label" }, modeDot, modeApp, modeState);

  const tabHome = h("button", { class: "tab reveal", title: "Home", "aria-label": "Home", onclick: () => { showHome(); go("overview"); } }, svg(ICONS.house, 13));
  const tabVoice = h("button", { class: "tab", title: tl("Voice"), "aria-label": "Conversation", onclick: () => go("voice") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab reveal", title: "New", "aria-label": tl("New conversation"), onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const muteBtn = h("button", { title: "Mute microphone", "aria-label": "Mute microphone" }, svg(ICONS.speakerOn, 14));
  muteBtn.addEventListener("click", () => void toggleMute());
  const gearBtn = h("button", { title: tl("Settings"), onclick: () => goHome() }, svg(ICONS.gear, 14));
  // Plan usage pills (off by default): before the gear, Claude first, as on the Mac.
  const claudePill = buildPlanPill(false);
  const codexPill = buildPlanPill(true);
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el);
  let codexShown = false;

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  function goHome() {
    actions.blip();
    actions.showSettingsHome();
  }

  const headerActions = h("div", { class: "header-actions" }, planPills, muteBtn, gearBtn);
  const el = h(
    "div",
    { id: "header" },
    modeLabel,
    h("div", { class: "tabs" }, tabHome, tabVoice, tabDrop),
    headerActions,
  );

  function syncMute(): void {
    const muted = Voice.state.muted;
    muteBtn.classList.toggle("on", muted);
    muteBtn.title = muted ? "Unmute microphone" : "Mute microphone";
    muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    muteBtn.setAttribute("aria-pressed", String(muted));
    clear(muteBtn);
    muteBtn.append(svg(muted ? ICONS.speakerOff : ICONS.speakerOn, 14));
  }
  const offMute = Voice.subscribe(() => syncMute());
  syncMute();

  function labelFor(): { dot: string; app: string; state: string } {
    const view = State.view;
    if (view === "prompt") return { dot: "#f5f6f8", app: t("Chat"), state: t("Ready") };
    if (view === "voice") return { dot: "#22d3ee", app: t("Voice"), state: t("Ready") };
    if (view === "settings") return { dot: "#8e939c", app: t("Settings"), state: "" };
    if (view === "upload" || view === "uploading" || view === "choose") {
      return { dot: "#8e939c", app: "New", state: "" };
    }
    const task = State.focusTask;
    if (task?.id === MUSIC_ID) {
      const data = State.integrations[MUSIC_ID]?.data as { app?: unknown; playing?: unknown } | undefined;
      const app = typeof data?.app === "string" && data.app ? data.app : "Music";
      const playing = data?.playing === true;
      return { dot: "#1ED760", app, state: playing ? "Now playing" : t("Paused") };
    }
    if (task) {
      const state = task.state === "working" || task.state === "thinking" || task.state === "searching"
        ? "Working"
        : task.pillBadge === "approval"
          ? "Needs permission"
          : task.state === "error"
            ? t("Error")
            : task.state === "finished"
              ? "Finished"
              : t("Ready");
      return { dot: task.color, app: task.name, state };
    }
    return { dot: "#8e939c", app: "Choom", state: "" };
  }

  return {
    el,
    dispose() {
      offMute();
    },
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabVoice.classList.toggle("on", v === "voice" || v === "prompt");
      tabDrop.classList.toggle("on", v === "upload" || v === "uploading" || v === "choose");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      syncMute();
      const label = labelFor();
      modeDot.style.background = label.dot;
      modeApp.textContent = label.app;
      modeApp.title = label.app;
      modeState.textContent = label.state;
      modeState.style.display = label.state ? "" : "none";
      syncPlanPills();
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    const codexOn = codexPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn || codexOn);
    // Both pills: the right side tightens so it still clears the screen edge.
    headerActions.classList.toggle("both-plans", claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    // Codex is asked when its pill comes into view (stale answers only).
    const shown = codexOn && State.mode === "expanded";
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const rail = buildRail({ setFocus: (id) => { noteFocusSelected(id); actions.setFocus(id); } });
  const right = h("div", { class: "right rail-col" }, rail.el);
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;
  // Spotify's card is kept and updated in place: the progress bar runs on,
  // and a slider being dragged must not be rebuilt under the pointer.
  const spotifyCard = buildSpotifyCard();

  const el = h("div", { class: "view overview has-rail" },
    h("div", { class: "left" }, left),
    right,
  );

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | null = null;
  let cardKey = "";
  let landingKey = "";
  let landingStop: (() => void) | null = null;

  function clearLanding(): void {
    if (landingStop) {
      landingStop();
      landingStop = null;
    }
    landingKey = "";
  }
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsCategory("connections"),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      activeDiffId = last.id;
      State.notify();
    },
    dispose() {
      clearLanding();
    },
    sync() {
      const homeVisible = isHomeVisible() && !planCardOpen();
      const launchVisible = isLaunchpadVisible() && !planCardOpen();
      el.classList.toggle("is-landing-home", homeVisible);
      el.classList.toggle("is-landing-launch", launchVisible);
      // A open invitation: default on Home and small-tab open, despite music.
      if (homeVisible) {
        if (landingKey !== "home") {
          clearLanding();
          landingKey = "home";
          mode = null;
          cardKey = "";
          clear(leftBody);
          const home = landingHomeCard({
            onInput: () => {
              actions.setView("voice");
              openVoiceEditor();
            },
            onOpenVoice: () => actions.openSettingsWindow(),
            onMicStart: () => void startVoice(),
            onMicStop: () => void stopVoice(),
          });
          landingStop = home.stop;
          leftBody.append(home.el);
        }
        el.classList.toggle("is-music", false);
        jump.style.display = "none";
        rail.sync();
        return;
      }
      // C small launchpad: real Tools shortcuts and routines only.
      if (launchVisible) {
        if (landingKey !== "launchpad") {
          clearLanding();
          landingKey = "launchpad";
          mode = null;
          cardKey = "";
          clear(leftBody);
          const launch = landingLaunchpadCard({
            onDone: () => { dismissToHome(); State.notify(); },
            onOpenTools: () => actions.openSettingsWindow(),
          });
          landingStop = launch.stop;
          leftBody.append(launch.el);
        }
        el.classList.toggle("is-music", false);
        jump.style.display = "none";
        rail.sync();
        return;
      }
      if (landingKey !== "") clearLanding();
      const task = State.focusTask;
      // Scoped hook for music-only rules: no jump button, balanced card.
      el.classList.toggle("is-music", task?.id === MUSIC_ID);
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task && task.id === SPOTIFY_ID) {
        // Its own card for every state: playing, idle, not installed.
        if (mode !== "spotify") {
          clear(leftBody);
          leftBody.append(spotifyCard.el);
          mode = "spotify";
          cardKey = "";
        }
        spotifyCard.sync();
      } else if (task && task.id === JOBS_ID) {
        // The Jobs destination: lead, pills and Resume Auto. Built once per
        // focus and updated in place, so live rows never move keyboard focus.
        // Sampling never moves focus here; only a rail click does.
        if (cardKey !== task.id) {
          cardKey = task.id;
          mode = "card";
          clear(leftBody);
          leftBody.append(jobsCard({ openSession: (id) => actions.setFocus(id) }));
        } else {
          updateJobsCard(leftBody.firstElementChild as HTMLElement | null, {
            openSession: (id) => actions.setFocus(id),
          });
        }
      } else if (task && task.id === UTILITY_ID) {
        // The System destination: CPU, memory and battery tiles. Built once
        // per focus and updated in place, so live readings never move focus.
        if (cardKey !== task.id) {
          cardKey = task.id;
          mode = "card";
          clear(leftBody);
          leftBody.append(systemCard());
        } else {
          updateSystemCard(leftBody.firstElementChild as HTMLElement | null);
        }
      } else if (task && task.id === NOTIFICATIONS_ID) {
        // The Notifications panel: the bounded recent list with local dismiss
        // and clear. Rebuilt when the items or the private mode change.
        const ctl = notificationsController();
        const view = ctl?.view() ?? { recent: [], unread: 0, status: null };
        const pKey = [
          task.id, view.unread, view.recent.length,
          view.recent[0]?.key ?? "", State.settings.notificationsPrivate === true,
        ].join("~");
        if (pKey !== cardKey) {
          cardKey = pKey;
          mode = "card";
          clear(leftBody);
          leftBody.append(notificationsPanel({
            recent: view.recent,
            unread: view.unread,
            enabled: State.settings.notificationsEnabled === true,
            status: view.status?.state ?? "unspecified",
            priv: State.settings.notificationsPrivate === true,
          }));
        }
      } else if (task && task.id === TOOLS_ID) {
        // The Tools card: colour pocket, command bar and routines. Built once
        // per focus and updated in place, so typing never loses its field.
        if (cardKey !== task.id) {
          cardKey = task.id;
          mode = "card";
          clear(leftBody);
          leftBody.append(toolsCard());
        } else {
          updateToolsCard(leftBody.firstElementChild as HTMLElement | null);
        }
      } else if (task) {
        const info = State.integrations[task.id];
        const data = (info?.data ?? {}) as Record<string, unknown>;
        // The music card is built once per track, then updated in place: play,
        // pause and seek animate instead of replaying the entrance.
        const key =
          task.id === "integration_music"
            ? [task.id, data.active === true, data.app ?? "", data.title ?? "", data.artist ?? ""].join("~")
            : [
                language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
                info?.loaded, info?.error, info?.configured,
                JSON.stringify(info?.data ?? {}),
              ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        } else if (task.id === "integration_music") {
          updateNowPlayingCard(leftBody.firstElementChild as HTMLElement | null, data);
        }
      }

      // The music card opens its app from the song row itself, so the
      // jump button stays hidden for it and never overlaps the controls.
      // sessions from their own rows, so they need no jump button either.
      // Tools launches from its own tiles, so it needs none either.
      const hideJump = detailOpen || mode === "plan" || mode === "diff" ||
        task?.id === MUSIC_ID || task?.id === JOBS_ID || task?.id === UTILITY_ID ||
        task?.id === NOTIFICATIONS_ID || task?.id === TOOLS_ID;
      jump.style.display = hideJump ? "none" : "";

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;

      rail.sync();
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: tl("Nothing running right now.") }),
      h("div", { class: "sub", text: tl("Drop a file or window, or ask me anything.") }),
    ),
    h("div", { class: "grow" }),
    btn(tl("Ask Claude"), "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered (Mac #290). Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    card("amber", stack(116, 16, who, code, row), foldButton(actions)));
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  const guarded = (d: "allow" | "deny") => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.decide(d);
  };
  return {
    el,
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
      }
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn(tl("Deny"), "secondary", guarded("deny"), "N"),
        btn(tl("Allow"), "primary", guarded("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => actions.answerInTerminal(),
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const openN8n = btn(tl("Open in n8n"), "secondary", () => actions.openUrl(""));
  const row = h("div", { class: "actions" },
    btn(tl("Retry"), "primary", () => actions.setView(State.defaultView())),
    openN8n,
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = task?.source === "n8n" ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = task?.source === "n8n" ? t("Workflow stopped.") : t("Session stopped on an error.");
      detail.textContent = (task && lastTextStep(task.steps)) ?? t("No detail available.");
      openN8n.style.display = task?.source === "n8n" ? "" : "none";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const agent = State.focusTask?.source === "agent";
      who.append(agentWho(State.focusTask, agent ? t("finished") : t("Claude Code finished")));
      // The final message, else the last step that is not a diff (FinishedView).
      const task = State.focusTask;
      title.textContent = task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec — back to work in three seconds.") }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────
// The inline hub: all nine production categories mounted in the expanded
// island card. No separate window, no duplicate headings, no version header.

function buildSettings(_actions: ViewActions, onHeightChange: () => void): SettingsInlineHost {
  void _actions;
  return buildSettingsInline(onHeightChange);
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: Msg, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions, onChatHeightChange));
  map.set("prompt", buildPrompt(onChatHeightChange, { onMic: () => actions.setView("voice") }));
  map.set("voice", buildVoiceView(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("recap", buildRecap(actions));
  map.set("wardrobe", buildWardrobe(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder(tl("Sending by email isn't in this version."), ""));
  map.set("searching", buildPlaceholder(tl("Claude is searching…"), ""));
  map.set("result", buildPlaceholder(tl("Result"), ""));
  return map;
}
