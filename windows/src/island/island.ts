// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, FOCUS_COMPACT_W, NOTCH_W, PANEL_H, PANEL_W,
  PEEK_W, ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize, wakeStripWidth,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { SPOTIFY_ID, islandDances } from "../core/spotify";
import { Focus, liveDots, startFocus, momentWakeAllowed, MUSIC_ID, type Moment } from "../choom/focus";
import { homeIslandView, isHomeVisible, isLaunchpadVisible, noteFocusSelected, showHome } from "../choom/landing";
import { UTILITY_ID, JOBS_ID, currentSystemMood, jobsLiveHeight, systemLiveHeight } from "../choom/quickAdditions";
import { NOTIFICATIONS_ID, canPresentNow } from "../choom/notifications";
import { NOTIFICATIONS_PANEL_H } from "../choom/notificationsSection";
import { Voice } from "../choom/voice";
import { resetChatTurn } from "../views/chat";
import { TOOLS_ID } from "../choom/tools";
import { toolsIslandHeight } from "../choom/toolsSection";
import { landingLaunchpadHeight } from "../choom/landingSection";
import { closeVoicePanel, voiceIslandHeight } from "../choom/voiceSection";
import { Mood, musicMoodsEnabled } from "../choom/musicMood";
import { WakeHold } from "../choom/wake";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { SeasonCache, parseOutfit } from "../mochi/wardrobe";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { closePlanCard, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { settingsInlineHeight, type SettingsInlineHost } from "../views/settingsInline";
import type { HubCategoryId } from "../settings/hub";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { refreshHookPills } from "./integrations";
import { DesktopLink } from "./desktop";
import type { ViewCommand } from "./shortcuts";
import { DRAG_THRESHOLD } from "../mochi/desktop-logic";

const BOT_OVERHANG = 40;
/** Frame spacing for a resting compact pill (about 30 fps). */
const COMPACT_AMBIENT_FRAME_MS = 1000 / 30;
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra canvas on each side of Mochi, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** New compact motion cuts to its end state under reduced motion. */
function reducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  /** Mochi on the desktop: his life cycle and the drag out of the island. */
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private dotsEl!: HTMLElement;
  private dotSlots: HTMLElement[] = [];
  private peekEl!: HTMLElement;
  private peekLine1!: HTMLElement;
  private peekLine2!: HTMLElement;
  /** True while the pill is widened for a moment; the text lags behind. */
  private peekWide = false;
  private peekWidth = PEEK_W;
  private peekKey = "";
  private peekTimer: number | null = null;
  /** Alternating timer for track moments: song first, then artist. */
  private peekAltTimer: number | null = null;
  /** Pin glyph on the compact pill while its owner is pinned. */
  private pinEl!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;
  /** Deliberate wake: dwell, no held button, then Rust's full-screen check. */
  private wakeHold = new WakeHold({
    dwellMs: () => State.settings.wakeDwellMs,
    stillHidden: () => State.mode === "hidden",
    allowed: () => Bridge.wakeAllowed(),
    wake: () => {
      // The dwell can outlive the hidden state by one IPC round trip.
      if (State.mode === "hidden") this.fsm.mouseEntered();
    },
  });

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private settingsView: SettingsInlineHost | null = null;
  private lastSettingsH = 0;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private musicGeometryActive = false;
  private jobsGeometryActive = false;
  private utilityGeometryActive = false;
  private toolsGeometryActive = false;
  private launchGeometryActive = false;
  private lastJobsH = 0;
  private lastToolsH = 0;
  private lastLaunchH = 0;
  private lastVoiceH = 0;
  /** Last high load sweat drop, so the System card breathes heat calmly. */
  private lastSysSweat = 0;

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** Where a press on Mochi started: moving past DRAG_THRESHOLD drags him out. */
  private botPress: { x: number; y: number } | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
      dizzyFromDesktop: () => this.handleDizzy(),
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
    // The pill owner drives the compact geometry: a new owner re-centres the
    // bot, a moment reveals the island and widens the pill for its two lines.
    Focus.wakeGate = async (moment) => {
      if (moment.kind === "notification") {
        if (State.mode !== "compact" || State.paused) return false;
        const allowed = await Bridge.notificationsPresentationAllowed();
        return allowed === true && canPresentNow();
      }
      return momentWakeAllowed(await Bridge.wakeAllowed(), IS_TAURI);
    };
    startFocus();
    Focus.subscribe(() => this.onFocusChanged());
    Mood.bind({
      engine: () => this.engine,
      isMusicFocused: () => State.focusId === MUSIC_ID,
      isPlaying: () => State.integrations[MUSIC_ID]?.data.playing === true,
      suspended: () => State.mode === "hidden" || State.paused || !musicMoodsEnabled(),
    });
    Mood.start((fn) => State.subscribe(fn));
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    this.fsm.pinned = false;
    this.setView(State.defaultView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        noteFocusSelected(id);
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (task.id === SPOTIFY_ID) void Bridge.spotifyOpen();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => this.showSettingsHome(),
      showSettingsHome: () => this.showSettingsHome(),
      openSettingsCategory: (id) => this.openSettingsCategory(id),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        if (parseOutfit(State.settings.mochiOutfit) === selection) return;
        State.settings.mochiOutfit = selection;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.wakeStrip.style.width = `${wakeStripWidth(State.settings)}px`;
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.dotsEl = h("div", { id: "live-dots" });
    for (let i = 0; i < 3; i++) {
      const dot = h("i", {});
      this.dotSlots.push(dot);
      this.dotsEl.append(dot);
    }
    this.peekLine1 = h("b", {});
    this.peekLine2 = h("span", {});
    this.peekEl = h("div", { id: "peek-text" }, this.peekLine1, this.peekLine2);
    this.pinEl = h("div", { id: "pin", title: "Pinned" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.settingsView = this.views.get("settings") as SettingsInlineHost | null;
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.discardDrop(),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.dotsEl,
      this.peekEl,
      this.pinEl,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      if (from === "home" && to !== "home" && State.view === "voice") {
        void closeVoicePanel();
      }
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "coucou" && to !== "coucou") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          showHome();
          this.expand(homeIslandView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  /** Focus moved: reveal for a moment, widen for its text, refresh dots. */
  private onFocusChanged() {
    if (State.mode === "hidden" && Focus.owner.moment) this.reveal();
    if (State.mode === "compact" && Focus.owner.moment) this.fsm.holdForMoment();
    this.setPeek(State.mode === "compact" ? Focus.owner.moment : null);
  }

  /**
   * Converges the pill on the moment: widen first, fade the text in once the
   * width has mostly settled (140 ms), fade it out before shrinking (160 ms,
   * after the fade finishes). Called from Focus changes and from the DOM sync,
   * so collapsing onto an active moment still peeks. Re-entry with the same
   * moment is a no-op, so the timers are never restarted by an unrelated sync.
   * Track moments alternate song then artist with a soft crossfade halfway
   * through the 3.5 s moment, so both can be read. Agent moments keep two
   * lines unchanged. Reduced motion shows both statically with no timers.
   * The alternating timer never extends the moment and never runs while the
   * island is hidden. All timers clear on hide, new moment and dispose paths.
   */
  private clearPeekAlt(resetPresentation = true): void {
    if (this.peekAltTimer != null) {
      clearTimeout(this.peekAltTimer);
      this.peekAltTimer = null;
    }
    if (resetPresentation) {
      this.peekEl.classList.remove("alternating");
      this.peekEl.classList.remove("artist-visible");
    }
  }

  private setPeek(moment: Moment | null) {
    if (moment) {
      const key = `${moment.taskId}|${moment.kind}|${moment.line1}|${moment.line2}`;
      if (key === this.peekKey && (this.peekEl.classList.contains("on") || this.peekTimer != null)) {
        return;
      }
      this.peekKey = key;
      this.peekLine1.textContent = moment.line1;
      this.peekLine2.textContent = moment.line2;
      const isTrack = moment.kind === "track";
      const previousWidth = this.peekWidth;
      this.peekWidth = PEEK_W;
      if (isTrack) {
        const context = document.createElement('canvas').getContext('2d');
        if (context) {
          context.font = getComputedStyle(this.peekLine1).font || '600 13px sans-serif';
          const titleWidth = context.measureText(moment.line1).width;
          context.font = getComputedStyle(this.peekLine2).font || '400 11.5px sans-serif';
          const artistWidth = context.measureText(moment.line2).width;
          this.peekWidth = Math.min(560, Math.max(140, Math.ceil(Math.max(titleWidth, artistWidth)) + 86));
        }
      }
      if (this.peekWide && previousWidth !== this.peekWidth) this.animateGeometry(false);
      // Track moments alternate one at a time; agent moments keep two lines.
      this.peekEl.classList.toggle("track", isTrack);
      this.clearPeekAlt();
      if (isTrack && !reducedMotion() && State.mode === "compact") {
        this.peekEl.classList.add("alternating");
        this.peekAltTimer = window.setTimeout(() => {
          this.peekAltTimer = null;
          if (Focus.owner.moment && State.mode === "compact") {
            this.peekEl.classList.add("artist-visible");
            this.dirty = true;
            this.ensureRunning();
          }
        }, 1750);
      }
      if (!this.peekWide) {
        this.peekWide = true;
        this.animateGeometry(false);
      }
      this.peekEl.classList.remove("on");
      if (this.peekTimer != null) clearTimeout(this.peekTimer);
      if (reducedMotion()) {
        this.peekTimer = null;
        this.peekEl.classList.add("on");
      } else {
        this.peekTimer = window.setTimeout(() => {
          this.peekTimer = null;
          if (Focus.owner.moment && State.mode === "compact") {
            this.peekEl.classList.add("on");
            this.dirty = true;
            this.ensureRunning();
          }
        }, 140);
      }
    } else {
      if (this.peekKey === "" && !this.peekEl.classList.contains("on") &&
          (!this.peekWide || this.peekTimer != null)) {
        return;
      }
      this.peekKey = "";
      this.peekEl.classList.remove("on");
      this.clearPeekAlt(false);
      if (this.peekTimer != null) clearTimeout(this.peekTimer);
      if (!this.peekWide) {
        this.peekEl.classList.remove("track");
        this.clearPeekAlt();
        this.peekTimer = null;
      } else if (reducedMotion()) {
        this.peekEl.classList.remove("track");
        this.clearPeekAlt();
        this.peekTimer = null;
        this.peekWide = false;
        if (State.mode === "compact") this.animateGeometry(true);
      } else {
        this.peekTimer = window.setTimeout(() => {
          this.peekTimer = null;
          if (!Focus.owner.moment || State.mode !== "compact") {
            this.peekEl.classList.remove("track");
            this.clearPeekAlt();
            this.peekWide = false;
            if (State.mode === "compact") this.animateGeometry(true);
            this.dirty = true;
            this.ensureRunning();
          }
        }, 160);
      }
    }
    this.dirty = true;
    this.ensureRunning();
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /** Header gear, tray and integration links: the same inline hub home. */
  showSettingsHome() {
    // Mirror alert(): cancel stale FSM timers and land in home, so a hidden
    // island never collapses back to compact on first cursor entry and an
    // armed petitHide timer cannot hide the island mid-settings.
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand("settings");
    this.settingsView?.showHome();
  }

  /** Deep link into one Pocket control room inside the expanded island. */
  openSettingsCategory(id: HubCategoryId) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand("settings");
    this.settingsView?.openCategory(id);
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  onWindowFocusShift() {
    if (State.isPinned || State.pendingApproval || UPLOAD_VIEWS.has(State.view)) return;
    // A voice turn holds the island open until it finishes.
    if (State.view === "voice" && Voice.state.runtime !== "standby" && Voice.state.runtime !== "disabled" && Voice.state.runtime !== "error") return;
    this.fsm.focusShift();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    if (view === "settings") {
      this.showSettingsHome();
      return;
    }
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** Right-click on Mochi: wardrobe open ↔ back to the usual view. */
  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    // The greeting and the drop sequence draw a Mochi of their own.
    if (State.mode === "expanded" && (State.view === "greeting" || this.uploadActive)) return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  /**
   * Right-click on the desktop Mochi (macOS openWardrobeFromDesktop): opens the
   * wardrobe from any state, or goes back if it is already open.
   */
  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  /**
   * The wardrobe from any state — compact or hidden island included — or back
   * to the usual view if it is already open. The desktop Mochi's right-click
   * and the wardrobe shortcut (`open-wardrobe`) both land here.
   */
  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** The desktop shortcut needs a desktop Mochi: none on GNOME's Wayland. */
  canLeaveIsland(): boolean {
    return this.desktop.supported;
  }

  /** The desktop shortcut (macOS DesktopMochiController.flyOutOrHome). */
  flyOutOrHome() {
    // The greeting and the drop sequence draw a Mochi of their own: he stays
    // for them, as he does for a drag (canDragOut).
    const busy = State.mode === "expanded" && (State.view === "greeting" || this.uploadActive);
    if (busy && !State.mochiOnDesktop) return;
    this.desktop.flyOutOrHome();
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    resetChatTurn();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    // The compact pill holds one centred Choom, widened while a moment peeks.
    const compactW = this.peekWide ? this.peekWidth : FOCUS_COMPACT_W;
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    const musicHeight = State.mode === "expanded" && State.view === "overview" && State.focusId === MUSIC_ID ? 184 : h;
    // Jobs sizes to its content: the short lead, growing only for the pinned
    // note. System keeps the fixed PC tile height. Every other view keeps its
    // measured height.
    const jobsHeight = State.mode === "expanded" && State.view === "overview" && State.focusId === JOBS_ID ? jobsLiveHeight() : musicHeight;
    const utilityHeight = State.mode === "expanded" && State.view === "overview" && State.focusId === UTILITY_ID ? systemLiveHeight() : jobsHeight;
    // The Tools card sizes to its open tab: swatches, tiles or routines.
    const toolsHeight = State.mode === "expanded" && State.view === "overview" && State.focusId === TOOLS_ID ? toolsIslandHeight() : utilityHeight;
    // The Notifications panel keeps one fixed compact height, so the list
    // never makes the island jump.
    const notificationsHeight = State.mode === "expanded" && State.view === "overview" && State.focusId === NOTIFICATIONS_ID ? NOTIFICATIONS_PANEL_H : toolsHeight;
    // The voice deck sizes to its content: compact A, transcript B, desk C.
    const voiceHeight = State.mode === "expanded" && State.view === "voice" ? voiceIslandHeight() : notificationsHeight;

    // Landing home keeps the base overview height so a hidden music/jobs/tools
    // focus never leaves an empty tall panel behind the invitation. Bypassed
    // approval and error cards keep their own activity geometry.
    if (State.mode === "expanded" && State.view === "overview" && isHomeVisible()) {
      return { w, h: 184, r };
    }
    // C grows only for its real tiles, preview and results, measured on the
    // mounted card itself rather than the hidden Tools card.
    if (State.mode === "expanded" && State.view === "overview" && isLaunchpadVisible()) {
      return { w, h: landingLaunchpadHeight(), r };
    }

    // The inline Settings hub sizes to its content: tiles home or bounded
    // detail scroll, never oversized empty space, never clipped.
    const settingsHeight = State.mode === "expanded" && State.view === "settings" ? settingsInlineHeight() : voiceHeight;
    const settingsWidth = State.mode === "expanded" && State.view === "settings"
      ? Math.min(w, Math.max(0, window.innerWidth - 20))
      : w;
    return { w: State.mode === "compact" ? compactW : settingsWidth, h: settingsHeight, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (reducedMotion()) {
      // New compact motion cuts to its end state; older motion is untouched.
      this.width.jump(w);
      this.height.jump(h);
      this.radius.jump(r);
      this.ensureRunning();
      return;
    }
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is
    // hidden. Waking must be deliberate: the cursor rests on the strip with no
    // button held, and Rust's full-screen check gets the final word. A release
    // over the strip rearms without leaving; plain moves never restart.
    this.wakeStrip.addEventListener("mouseenter", (e) => {
      Sound.resume();
      if (State.mode === "hidden") this.wakeHold.enter(e.buttons);
    });
    this.wakeStrip.addEventListener("mousemove", (e) => {
      if (State.mode === "hidden") this.wakeHold.move(e.buttons);
    });
    // A press without movement fires no mousemove, so it must cancel too.
    this.wakeStrip.addEventListener("mousedown", (e) => {
      if (State.mode === "hidden") this.wakeHold.down(e.buttons);
    });
    this.wakeStrip.addEventListener("mouseup", (e) => {
      if (State.mode === "hidden") this.wakeHold.release(e.buttons);
    });
    this.wakeStrip.addEventListener("mouseleave", () => this.wakeHold.leave());

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      // A press on Mochi may become a drag out to the desktop.
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Right-click on Mochi opens the wardrobe, and closes it again.
      if (e.button === 2 && State.mode !== "compact" && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        // A click during a moment opens that card directly.
        const m = Focus.owner.moment;
        if (m) State.setFocus(m.taskId);
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // Wheel over the small pill steps through live owners and holds the manual
    // choice for 30 s; right-click pins the current owner until unpinned.
    this.islandEl.addEventListener("wheel", (e) => {
      if (State.mode !== "compact") return;
      e.preventDefault();
      State.lastActivity = performance.now();
      Focus.cycle(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    // Right-click: on the small pill it pins the current owner (Choom Focus);
    // on Mochi in the open island it is the wardrobe (mousedown above). No
    // browser menu over Mochi; the chat field keeps its own.
    this.islandEl.addEventListener("contextmenu", (e) => {
      if (State.mode === "compact") {
        e.preventDefault();
        State.lastActivity = performance.now();
        const owner = Focus.owner.taskId;
        if (owner) Focus.togglePin(owner);
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    // Dragging Mochi out of the island puts him on the desktop.
    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      // Escape reaches native voice cancellation first: while a voice turn
      // owns the deck the island must not collapse under it.
      if (e.key === "Escape" && State.view === "voice" && State.mode === "expanded" &&
        (Voice.state.runtime === "listening" || Voice.state.runtime === "processing" ||
          Voice.state.runtime === "working" || Voice.state.runtime === "speaking")) {
        State.lastActivity = performance.now();
        return;
      }
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Hidden wake is the WakeHold dwell plus Rust's fullscreen gate only.
    // A direct FSM entry here would bypass both, so a hidden island never
    // wakes from the cursor poll. The strip's own mouse events own that path.
    if (State.mode === "hidden") {
      this.wasInIsland = false;
      return;
    }

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      // Interacting with the inline Settings hub holds the island open: a
      // hover leave never schedules the auto-close. Focus-shift still closes
      // through onWindowFocusShift, and returning Home restores the policy.
      if (State.view !== "settings") this.fsm.mouseLeft();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    Mood.setHover(this.botHovering);
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** The greeting and the drop sequence draw a Mochi of their own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Mochi is invisible: nothing to hit.
    if (State.mochiOnDesktop) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    // A resting compact pill only has Choom's ambient loops (blink, breathing,
    // music moods) to draw. Those read fine at 30 fps, so cap them there instead
    // of repainting at the display rate for as long as the pill stays up.
    // Anything that moves geometry or the bot still gets full-rate frames.
    const ambientOnly =
      State.mode === "compact" && !settling && !UploadSeq.isActive &&
      this.botCx.settled && this.botCy.settled && this.botSize.settled;

    if (busy && ambientOnly) {
      window.setTimeout(() => requestAnimationFrame(this.frame), COMPACT_AMBIENT_FRAME_MS);
    } else if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    if (State.mode === "expanded" && State.view === "prompt" && State.chatHistory.length === 0) {
      p.cx = this.width.value / 2;
      p.cy = 42 + (this.height.value - 42) * 0.34;
    }
    // One centred Choom in the narrow pill, left aligned while peeking.
    const compactCx = State.mode === "compact"
      ? (this.peekWide ? 38 : this.width.value / 2)
      : p.cx;
    if (reducedMotion()) {
      this.botCx.set(compactCx);
      this.botCy.set(p.cy);
      this.botSize.set(p.diameter / 0.6);
    } else {
      this.botCx.target = compactCx;
      this.botCy.target = p.cy;
      this.botSize.target = p.diameter / 0.6;
    }

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap. Out on the
    // desktop, he isn't here at all.
    const away = State.mochiOnDesktop;
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive && !away) {
      const d = p.diameter;
      // High PC load warms the System glow red orange. The body, size and
      // padding stay exactly as the agent state draws them. Jobs never warms:
      // vitals mood must not leak into the Jobs destination.
      const sysHigh = State.focusId === UTILITY_ID && currentSystemMood() === "high";
      const color = sysHigh ? "#F0663F" : botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(sysHigh ? 0.65 : botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    // While a plan card is open Mochi wears the plan's colour, like its pill.
    this.engine.bodyColor = planCardOpen()
      ? hexToRGB(openPlanColor())
      : State.focusId === MUSIC_ID
        ? hexToRGB(focus?.color ?? '#1ED760')
        : focus?.isIntegration
          ? hexToRGB(focus.color)
          : null;
    // System load faces live only on the System expanded overview. Jobs and
    // every other mode keep the state driven face, size and padding.
    this.engine.systemMood =
      State.focusId === UTILITY_ID && State.mode === "expanded" && State.view === "overview"
        ? currentSystemMood()
        : null;
    // High PC load sweats calmly through the existing particle path while the
    // System card is up. Body, size and padding never change.
    if (State.focusId === UTILITY_ID && currentSystemMood() === "high") {
      const t = performance.now();
      if (t - this.lastSysSweat > 1600) {
        this.lastSysSweat = t;
        this.engine.emit("sweat", 1);
      }
    }
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Only the main Mochi is dressed — the one of the main tool's pill (Settings →
    // Active pills): a focused integration pill shows its own colours, unless
    // the wardrobe is open (BotCanvasView.showOutfit, macOS).
    // In the wardrobe the hovered outfit swaps in at once, without the drop-in.
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const mainFocused = State.focusId == null || State.focusId === State.mainPillId;
    const showOutfit = mainFocused || State.mode !== "expanded" || inWardrobe;
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.mochiOutfit));
    this.engine.setOutfit(showOutfit ? outfit : "none", !inWardrobe);
    // Dances while music plays: always in the compact island, expanded only on
    // the music pill's card (BotCanvasView, macOS). Asked every frame.
    this.engine.setDancing(islandDances({
      music: State.spotifyPlaying,
      state: State.effectiveState,
      mode: State.mode,
      view: State.view,
      focusId: State.focusTask?.id,
    }));

    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.clearRect(-BOT_SIDE, 0, wCss, hCss);
    ctx.save();
    this.engine.applyDance(ctx, w, hCss);
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    // Listening, processing, working and speaking suspend the auto-close
    // countdown, as does a click approval waiting on the human — and the
    // inline Settings hub while it is open.
    if (State.pendingApproval != null) {
      this.countdown.style.width = "0px";
      return;
    }
    if (State.view === "settings") {
      this.countdown.style.width = "0px";
      return;
    }
    if (State.view === "voice" && Voice.state.runtime !== "standby" && Voice.state.runtime !== "disabled" && Voice.state.runtime !== "error") {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";
    const homeLanding = isHomeVisible() && State.view === "overview";
    const launchLanding = isLaunchpadVisible() && State.view === "overview";
    const musicExpanded = expanded && State.view === "overview" && State.focusId === MUSIC_ID && !homeLanding;
    if (musicExpanded !== this.musicGeometryActive) {
      this.musicGeometryActive = musicExpanded;
      this.animateGeometry(!musicExpanded);
    }
    const utilityExpanded = expanded && State.view === "overview" && State.focusId === UTILITY_ID && !homeLanding;
    if (utilityExpanded !== this.utilityGeometryActive) {
      this.utilityGeometryActive = utilityExpanded;
      this.animateGeometry(!utilityExpanded);
    }
    // System height is fixed, so entering and leaving is enough. Jobs follows
    // its content height while up: pin changes resize without moving focus.
    const jobsExpanded = expanded && State.view === "overview" && State.focusId === JOBS_ID && !homeLanding;
    if (jobsExpanded !== this.jobsGeometryActive) {
      this.jobsGeometryActive = jobsExpanded;
      if (jobsExpanded) this.lastJobsH = 0;
      this.animateGeometry(!jobsExpanded);
    }
    if (jobsExpanded) {
      const wantH = jobsLiveHeight();
      if (wantH !== this.lastJobsH) {
        const grew = wantH > this.lastJobsH;
        this.lastJobsH = wantH;
        this.animateGeometry(!grew);
      }
    } else {
      this.lastJobsH = 0;
    }
    // Same for the Tools card: tabs, forms and previews resize it in place.
    // The launchpad owns its own measurement while visible, so the hidden
    // Tools card never drives C geometry.
    const toolsExpanded = expanded && State.view === "overview" && State.focusId === TOOLS_ID && !homeLanding && !launchLanding;
    if (toolsExpanded !== this.toolsGeometryActive) {
      this.toolsGeometryActive = toolsExpanded;
      if (toolsExpanded) this.lastToolsH = 0;
      this.animateGeometry(!toolsExpanded);
    }
    if (toolsExpanded) {
      const wantH = toolsIslandHeight();
      if (wantH !== this.lastToolsH) {
        const grew = wantH > this.lastToolsH;
        this.lastToolsH = wantH;
        this.animateGeometry(!grew);
      }
    } else {
      this.lastToolsH = 0;
    }
    // Same for the launchpad: tiles, preview and results resize it in place,
    // measured on the mounted C card itself.
    const launchExpanded = expanded && launchLanding;
    if (launchExpanded !== this.launchGeometryActive) {
      this.launchGeometryActive = launchExpanded;
      if (launchExpanded) this.lastLaunchH = 0;
      this.animateGeometry(!launchExpanded);
    }
    if (launchExpanded) {
      const wantH = landingLaunchpadHeight();
      if (wantH !== this.lastLaunchH) {
        const grew = wantH > this.lastLaunchH;
        this.lastLaunchH = wantH;
        this.animateGeometry(!grew);
      }
    } else {
      this.lastLaunchH = 0;
    }
    // Same for the voice deck: transcript, receipts and context resize it.
    const voiceExpanded = expanded && State.view === "voice";
    if (voiceExpanded) {
      const wantH = voiceIslandHeight();
      if (wantH !== this.lastVoiceH) {
        const grew = wantH > this.lastVoiceH;
        this.lastVoiceH = wantH;
        this.animateGeometry(!grew);
      }
    } else {
      this.lastVoiceH = 0;
    }
    // Same for the inline Settings hub: home tiles or one bounded detail.
    const settingsExpanded = expanded && State.view === "settings";
    if (settingsExpanded) {
      const wantH = settingsInlineHeight();
      if (wantH !== this.lastSettingsH) {
        const grew = wantH > this.lastSettingsH;
        this.lastSettingsH = wantH;
        this.animateGeometry(!grew);
      }
    } else {
      this.lastSettingsH = 0;
    }

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    // A wardrobe try-on never outlives the wardrobe.
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat, voice and settings views hold text fields, so they may take
    // keyboard focus. Every other view gives it back.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt" || this.lastSyncedView === "voice" || this.lastSyncedView === "settings";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (State.view === "voice") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("voice")?.focus?.(), 120);
      } else if (State.view === "settings") {
        void Bridge.focusWindow(true);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact pill: one Choom plus live dots for the rest.
    this.setPeek(State.mode === "compact" ? Focus.owner.moment : null);
    this.syncDots();
    this.pinEl.classList.toggle(
      "on",
      State.mode === "compact" && Focus.pinned === Focus.owner.taskId,
    );

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  private syncDots() {
    const show = State.mode === "compact" && !this.peekWide;
    this.dotsEl.style.opacity = show ? "1" : "0";
    if (!show) {
      for (const slot of this.dotSlots) slot.classList.remove("on");
      return;
    }
    const playing =
      (State.integrations[MUSIC_ID]?.data.playing as boolean | undefined) === true;
    const dots = liveDots(State.tasks, Focus.owner.taskId, playing);
    this.dotSlots.forEach((slot, i) => {
      const task = dots[i];
      if (!task) {
        slot.classList.remove("on");
        return;
      }
      slot.style.background = task.color;
      slot.classList.add("on");
    });
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.wakeStrip.style.width = `${wakeStripWidth(State.settings)}px`;
    this.fsm.openOnHover = State.settings.openOnHover;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
