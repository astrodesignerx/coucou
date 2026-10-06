// Choom for OpenCode: reports every OpenCode session to the Coucou relay so
// the island shows an "opencode" pill, and turns the island's Allow / Deny
// card into an OpenCode permission answer. Choom installs this from Settings,
// and nothing here may break a session: without the relay exe hooks are no-ops.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT = "opencode";
// A permission may wait a little longer than the relay's own 110 s budget.
const DECISION_TIMEOUT_MS = 115_000;

// Choom's data folder: %LOCALAPPDATA%\Coucou on Windows, ~/.local/share/coucou
// elsewhere, where the relay and its own agent sessions live.
function choomData(...parts) {
  const local = process.env.LOCALAPPDATA;
  const base = local || process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, local ? "Coucou" : "coucou", ...parts);
}

// The relay Choom stages at launch (coucou-hook.exe on Windows).
function relayPath() {
  return process.env.LOCALAPPDATA
    ? choomData("bin", "coucou-hook.exe")
    : choomData("bin", "coucou-hook");
}

// Windows paths are case-insensitive, so the folders compare that way too.
function sameDir(a, b) {
  const clean = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const left = clean(a);
  return left !== "" && left === clean(b);
}

/**
 * Hands one event to the relay with the hook JSON on stdin. Resolves with the
 * relay's stdout; without `wait` it returns once the payload is written, which
 * is all a fire-and-forget event needs. An absent relay exe is a no-op.
 */
async function talk(payload, wait) {
  const exe = relayPath();
  if (!existsSync(exe)) return "";
  const proc = Bun.spawn([exe, "--agent", AGENT, payload.hook_event_name], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  if (!wait) return "";
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, DECISION_TIMEOUT_MS);
  try {
    return await new Response(proc.stdout).text();
  } finally {
    clearTimeout(timer);
  }
}

// Same as talk, with the failure path folded into an empty answer.
function send(payload, wait) {
  return talk(payload, wait).catch(() => "");
}

// The island's step text reads `command` and `file_path`; pass the rest of
// OpenCode's args through untouched.
function toolInput(args) {
  const out = { ...(args && typeof args === "object" ? args : {}) };
  if (typeof out.command !== "string" && typeof out.cmd === "string") out.command = out.cmd;
  if (typeof out.file_path !== "string") {
    if (typeof out.filePath === "string") out.file_path = out.filePath;
    else if (typeof out.path === "string") out.file_path = out.path;
  }
  return out;
}

// The prompt out of a chat.message's parts, or an empty string.
function promptText(output) {
  const parts = Array.isArray(output && output.parts) ? output.parts : [];
  for (const part of parts) {
    if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text.trim().slice(0, 200);
    }
  }
  return "";
}

// The session an event belongs to: created and deleted carry `info`.
function eventSessionID(event) {
  const p = (event && event.properties) || {};
  return p.sessionID || (p.info && (p.info.id || p.info.sessionID)) || "";
}

export const Choom = async ({ directory }) => {
  // Choom's own agent mode already shows its cards; leave those alone.
  if (sameDir(directory, choomData("agent"))) return {};

  const cwd = String(directory || "");
  // Session ids this plugin has already announced to the island.
  const seen = new Set();

  function payloadFor(sessionID, event, extra) {
    return { hook_event_name: event, session_id: sessionID, cwd, ...extra };
  }

  // First sight of a session: create the pill before its events land.
  function ensureSession(sessionID) {
    if (!sessionID || seen.has(sessionID)) return;
    seen.add(sessionID);
    void send(payloadFor(sessionID, "SessionStart", {}), false);
  }

  function emit(sessionID, event, extra) {
    ensureSession(sessionID);
    void send(payloadFor(sessionID, event, extra), false);
  }

  return {
    event: async ({ event }) => {
      try {
        const sessionID = eventSessionID(event);
        if (!sessionID) return;
        switch (event && event.type) {
          case "session.idle":
            emit(sessionID, "Stop", {});
            break;
          case "session.error":
            emit(sessionID, "StopFailure", {});
            break;
          case "session.deleted":
            emit(sessionID, "SessionEnd", {});
            seen.delete(sessionID);
            break;
          default:
            // session.created, session.status, message.updated: keep the pill.
            ensureSession(sessionID);
            break;
        }
      } catch {
        // A Choom problem must never reach OpenCode.
      }
    },
    "chat.message": async (input, output) => {
      try {
        const sessionID = input && input.sessionID;
        if (sessionID) emit(sessionID, "UserPromptSubmit", { prompt: promptText(output) });
      } catch {
        // A Choom problem must never reach OpenCode.
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        const sessionID = input && input.sessionID;
        if (!sessionID) return;
        emit(sessionID, "PreToolUse", {
          tool_name: input.tool || "Tool",
          tool_input: toolInput(output && output.args),
        });
      } catch {
        // A Choom problem must never reach OpenCode.
      }
    },
    "tool.execute.after": async (input) => {
      try {
        const sessionID = input && input.sessionID;
        if (sessionID) emit(sessionID, "PostToolUse", { tool_name: input.tool || "Tool" });
      } catch {
        // A Choom problem must never reach OpenCode.
      }
    },
    "permission.ask": async (input, output) => {
      try {
        const sessionID = input && input.sessionID;
        if (!sessionID) return;
        ensureSession(sessionID);
        const pattern = Array.isArray(input.pattern) ? input.pattern.join(", ") : input.pattern;
        const command = (typeof pattern === "string" && pattern.trim()) || input.title || "";
        const answer = await send(
          payloadFor(sessionID, "PermissionRequest", {
            tool_name: input.type || "permission",
            tool_input: { command },
          }),
          true,
        );
        let behavior = "";
        try {
          behavior = JSON.parse(answer).hookSpecificOutput.decision.behavior || "";
        } catch {
          // No output or something we do not understand: leave the status alone.
        }
        if (behavior === "allow") output.status = "allow";
        else if (behavior === "deny") output.status = "deny";
      } catch {
        // A Choom problem must never reach OpenCode.
      }
    },
  };
};
