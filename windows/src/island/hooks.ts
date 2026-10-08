// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Focus } from "../choom/focus";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  turn_id?: string;
  permission_mode?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Codex Stop carries the last assistant text here, never a turn failure. */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Relay sets this only on an explicit structured failure, never raw output. */
  coucou_tool_failed?: boolean;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

// ── Codex sessions ──────────────────────────────────────────────────────────
// One pill per Codex session so concurrent sessions never overwrite each
// other. The id carries the full session id: truncating UUID tails collides.
// A missing or invalid session id creates nothing and defers permissions to
// the terminal rather than sharing one misleading pill.

function sanitizeCodexSession(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function codexTaskId(sessionId: string | undefined): string | null {
  const clean = sanitizeCodexSession(sessionId);
  if (!clean) return null;
  return `agent_codex_${clean}`;
}

function codexLabel(projectName: string): string {
  return projectName === "Session" ? "Codex" : `Codex ${projectName}`;
}

function upsertCodex(taskId: string, projectName: string, cwd: string) {
  State.upsertExternalAgent(taskId, codexLabel(projectName), agentColor("codex"));
  const t = State.tasks.find((x) => x.id === taskId);
  if (t && cwd) t.sessionCwd = cwd;
}

// Per-session turn tracking with retired turns: UserPromptSubmit establishes a
// new turn, and a late event from a retired turn can never mutate state again.
// Stop(old) then UserPromptSubmit(new) leaves the new turn alone, and a late
// PreToolUse(old) or PermissionRequest(old) is ignored or declined outright.
interface CodexTrack {
  turn: string | null;
  retired: Set<string>;
  gen: number;
  timer: number | null;
}

const codexTrack = new Map<string, CodexTrack>();

function trackOf(taskId: string): CodexTrack {
  let t = codexTrack.get(taskId);
  if (!t) {
    t = { turn: null, retired: new Set(), gen: 0, timer: null };
    codexTrack.set(taskId, t);
  }
  return t;
}

function cancelCodexTimer(taskId: string) {
  const t = codexTrack.get(taskId);
  if (t?.timer != null) {
    window.clearTimeout(t.timer);
    t.timer = null;
  }
}

function dropCodexTrack(taskId: string) {
  cancelCodexTimer(taskId);
  codexTrack.delete(taskId);
}

/** Releases the card only when it belongs to this task. Never touches Claude. */
function releaseCodexApproval(island: Island, taskId: string, decline: boolean) {
  const pending = State.pendingApproval;
  if (!pending || pending.taskId !== taskId) return;
  if (decline && pending.requestId) void Bridge.approvalDecline(pending.requestId);
  if (pendingTimeout != null) {
    window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  State.pendingApproval = null;
  State.isPinned = false;
  island.dropPin();
  if (State.view === "approval") island.setView(State.defaultView());
  State.notify();
}

/** Verified official Codex lifecycle. Anything else never becomes state. */
const CODEX_SUPPORTED = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
]);

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code pill unchanged.
  const validAgent = validateAgent(payload.coucou_agent);
  if (validAgent === "codex") {
    handleCodex(island, payload, projectName, cwd);
    return;
  }
  const agentId = validAgent ? `agent_${validAgent}` : CLAUDE_ID;
  const isExternalAgent = validAgent !== null;

  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists (no-op for Claude Code). */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else {
      upsert(projectName, cwd);
    }
  };

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      Sound.play("finish");
      const doneTask = State.tasks.find((t) => t.id === agentId);
      Focus.moment({
        taskId: agentId,
        kind: "finished",
        line1: `${doneTask?.name ?? projectName} finished`,
        line2: doneTask?.steps.at(-1) ?? "",
        ms: 4000,
      });
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;
    }

    case "StopFailure": {
      State.updateTask(agentId, "error");
      Sound.play("error");
      const failedTask = State.tasks.find((t) => t.id === agentId);
      Focus.moment({
        taskId: agentId,
        kind: "failed",
        line1: `${failedTask?.name ?? projectName} failed`,
        line2: failedTask?.steps.at(-1) ?? "",
        ms: 4000,
      });
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;
    }

    case "SessionEnd":
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents mostly do not get an approval card: showing one would
      // look like a Claude Code request, so they are handed straight back to
      // their terminal. The OpenCode agent and Codex sessions are the
      // exceptions: they ask through this same card.
      if (isExternalAgent && validAgent !== "opencode" && validAgent !== "codex") {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        taskId: agentId,
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (isExternalAgent) {
        // The OpenCode agent never holds the view when its prompt lands: take
        // focus and open the card instead of only badging its pill.
        State.setFocus(agentId);
        island.alert("approval");
      } else if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(agentId, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(agentId, "working");
        State.setPillBadge(agentId, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}

// ── Codex lifecycle ─────────────────────────────────────────────────────────
// Supported events only: idle, work, permission, finish and interruption.
// Unsupported events never fabricate state. Approvals reuse the same card and
// the same 800 ms ack plus 108 s decision windows as Claude Code; a missing
// pipe, a timeout, a disabled Choom or a second card defers to the terminal.
// Terminal activation reuses the stored session folder; there is no Codex
// session opener, so nothing here opens an unrelated session.

function handleCodex(
  island: Island,
  payload: HookPayload,
  projectName: string,
  cwd: string,
) {
  const name = payload.hook_event_name ?? "";
  if (!CODEX_SUPPORTED.has(name)) return;
  const taskId = codexTaskId(payload.session_id);
  // No shared fallback pill: without a stable session id there is nothing to
  // route to. Permissions defer to the terminal; other events are ignored.
  if (!taskId) {
    if (name === "PermissionRequest" && payload.request_id) {
      void Bridge.approvalDecline(payload.request_id);
    }
    return;
  }
  const focused = State.focusId === taskId;
  const turnId = typeof payload.turn_id === "string" && payload.turn_id.trim()
    ? payload.turn_id.trim()
    : null;

  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  // A prompt establishes a new turn. A late event from a retired turn cannot
  // mutate state: it is ignored, and a stale permission is declined so the
  // terminal takes over immediately.
  const isRetiredTurn = (): boolean => {
    if (turnId == null) return false;
    const t = codexTrack.get(taskId);
    if (!t) return false;
    if (t.turn != null && turnId === t.turn) return false;
    return t.retired.has(turnId);
  };

  // Only a prompt can move the current turn forward. Tool and permission
  // events adopt tracking when nothing was seen, but never switch a known
  // current turn to another id: without prompt ordering that id may be older.
  const adoptTurnIfUntracked = () => {
    if (turnId == null) return;
    const t = trackOf(taskId);
    if (t.turn == null && !t.retired.has(turnId)) t.turn = turnId;
  };

  // A new turn ends the old one: retire it, drop its finish timer on this and
  // resumed same-turn activity, and expire its card.
  const beginTurn = (): boolean => {
    const t = trackOf(taskId);
    if (turnId != null && t.turn != null && turnId === t.turn) {
      if (t.timer != null) {
        window.clearTimeout(t.timer);
        t.timer = null;
      }
      return false;
    }
    if (turnId != null) {
      if (t.turn != null) t.retired.add(t.turn);
      t.turn = turnId;
    }
    t.gen += 1;
    if (t.timer != null) {
      window.clearTimeout(t.timer);
      t.timer = null;
    }
    const pending = State.pendingApproval;
    if (pending && pending.taskId === taskId) {
      if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
      if (pendingTimeout != null) {
        window.clearTimeout(pendingTimeout);
        pendingTimeout = null;
      }
      State.pendingApproval = null;
      State.isPinned = false;
      island.dropPin();
      if (State.view === "approval") island.setView(State.defaultView());
    }
    return true;
  };

  // Stale tool results and finishes from an older turn never run. A turn id
  // that differs from the tracked current turn is stale for every event
  // except a prompt, which alone can establish a new turn.
  const isStaleTurn = (): boolean => {
    if (turnId == null) return false;
    const t = codexTrack.get(taskId);
    if (t?.turn == null) return false;
    return t.turn !== turnId;
  };

  switch (name) {
    case "SessionStart": {
      const t = trackOf(taskId);
      t.turn = null;
      t.retired.clear();
      t.gen += 1;
      cancelCodexTimer(taskId);
      upsertCodex(taskId, projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;
    }

    case "UserPromptSubmit": {
      // A late prompt for a retired turn is not a new turn: ignore it.
      if (isRetiredTurn()) break;
      beginTurn();
      upsertCodex(taskId, projectName, cwd);
      State.updateTask(taskId, "thinking");
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(taskId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      // Tool events never move the current turn: a differing id is either a
      // retired turn or an unordered late event, both ignored. An untracked
      // session adopts the first id it sees.
      if (isRetiredTurn() || isStaleTurn()) break;
      adoptTurnIfUntracked();
      cancelCodexTimer(taskId);
      upsertCodex(taskId, projectName, cwd);
      State.updateTask(taskId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(taskId, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      // A failed tool marks the step but stays working; a failed turn is never
      // inferred. Stop below never fabricates one either. Resumed same-turn
      // activity clears a pending finish timer.
      if (isRetiredTurn() || isStaleTurn()) break;
      adoptTurnIfUntracked();
      cancelCodexTimer(taskId);
      State.updateTask(taskId, "working");
      if (payload.coucou_tool_failed === true) State.appendStep(taskId, "⚠ failed");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // Without an id there is no relay to answer and no card to show.
      if (!requestId) break;
      // A retired turn's permission is declined so the terminal takes over;
      // it must never replace the current card.
      if (isRetiredTurn() || isStaleTurn()) {
        void Bridge.approvalDecline(requestId);
        break;
      }
      adoptTurnIfUntracked();
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        void Bridge.approvalDecline(requestId);
        break;
      }
      upsertCodex(taskId, projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        taskId,
      };
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(taskId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      // A Codex prompt takes focus and opens the card, like the OpenCode
      // agent, instead of only badging its pill.
      State.setFocus(taskId);
      island.alert("approval");
      const myRequest = requestId;
      const myTask = taskId;
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (State.pendingApproval?.requestId !== myRequest) return;
        if (State.pendingApproval.taskId !== myTask) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(myTask, "working");
        State.setPillBadge(myTask, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    case "Stop": {
      // No documented turn-failure event: Stop always means finished, with the
      // last assistant text as the step. Never an error. A stale old-turn
      // Stop after a newer turn started is ignored outright.
      if (isRetiredTurn() || isStaleTurn()) break;
      State.updateTask(taskId, "finished");
      const last = payload.last_assistant_message ?? payload.message;
      if (last) State.appendStep(taskId, last.slice(0, 60));
      Sound.play("finish");
      const doneTask = State.tasks.find((t) => t.id === taskId);
      Focus.moment({
        taskId,
        kind: "finished",
        line1: `${doneTask?.name ?? codexLabel(projectName)} finished`,
        line2: doneTask?.steps.at(-1) ?? "",
        ms: 4000,
      });
      if (focused) surface("finished", true);
      else State.setPillBadge(taskId, "finished");
      const t = trackOf(taskId);
      const gen = t.gen;
      const turn = t.turn;
      if (t.timer != null) window.clearTimeout(t.timer);
      t.timer = window.setTimeout(() => {
        t.timer = null;
        const cur = codexTrack.get(taskId);
        if (!cur || cur.gen !== gen || cur.turn !== turn) return;
        State.updateTask(taskId, "idle");
        State.setPillBadge(taskId, null);
        State.notify();
      }, 5200);
      break;
    }

    case "Interrupt": {
      if (isRetiredTurn() || isStaleTurn()) break;
      const t = trackOf(taskId);
      t.gen += 1;
      cancelCodexTimer(taskId);
      releaseCodexApproval(island, taskId, true);
      State.updateTask(taskId, "idle");
      State.appendStep(taskId, "interrupted");
      State.setPillBadge(taskId, null);
      break;
    }

    case "SessionEnd":
      cancelCodexTimer(taskId);
      releaseCodexApproval(island, taskId, true);
      dropCodexTrack(taskId);
      State.removeTask(taskId);
      break;

    default:
      break;
  }
  State.notify();
}
