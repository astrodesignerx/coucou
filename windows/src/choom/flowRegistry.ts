// Flow capability registry. Every action Flow can run is a registered
// capability keyed by its stable id. A capability declares what it is
// (category, label), whether it works offline, how its parameters are
// validated, when it is ready with a useful unavailable reason, what approval
// it needs, how its result is verified, and its executor. The queue in
// flow.ts consumes this registry and owns step identity, ordering,
// dependencies, cancellation, failures and receipts uniformly. Adapter
// executors are bound once at registration, so the controller never grows a
// dispatch switch. A typed request only ever selects a registered, validated
// capability: nothing here executes generated shell or code.

/** Explicit reference to the note Flow currently owns in this session. A
 *  rename only ever targets this reference, never an arbitrary path. */
export const SESSION_NOTE_REF = "session:current";

export type FlowCapabilityCategory =
  | "notes"
  | "launch"
  | "browser"
  | "media"
  | "routine"
  | "dictation"
  | "agent"
  | "files"
  | "system"
  | "integration";

/** none runs with the turn; explicit needs a click (for example a Run click)
 *  before the queue may dispatch the step. */
export type FlowApprovalPolicy = "none" | "explicit";

/** readback means the executor returned destination proof, such as the bytes
 *  read back from a written note. dispatch means the action was sent but no
 *  destination proof exists, so the queue never reports it verified. */
export type FlowVerificationPolicy = "readback" | "dispatch";

/** A saved shortcut the launch capabilities resolve against. */
export interface FlowCapabilityShortcut {
  id: string;
  name: string;
  kind: "app" | "folder";
  target: string;
}

/** A saved routine the routine capability runs. Steps are shortcut ids. */
export interface FlowCapabilityRoutine {
  id: string;
  name: string;
  steps: string[];
}

/** The facts readiness checks run against. Built per run from the saved
 *  settings, so a missing or broken configuration surfaces as an unavailable
 *  capability with a reason instead of a blind dispatch. */
export interface FlowCapabilityContext {
  settings: {
    flowNotesFolder: string;
    flowSearchEngine: string;
    flowBrowser: string;
    /** Configured editor that opens an owned note. Empty means note.open is
     *  unavailable with that reason, never a guessed handler. */
    flowEditor: string;
  };
  shortcuts: FlowCapabilityShortcut[];
  routines: FlowCapabilityRoutine[];
  /** False means the device is offline. Only capabilities whose offline flag
   *  is false become unavailable, independently of any speech engine. */
  online: boolean;
}

export interface FlowReadiness {
  ready: boolean;
  reason?: string;
}

export interface FlowValidateInput {
  target: string;
  value: string | null;
}

export type FlowValidateResult = { ok: true } | { ok: false; reason: string };

/** One planned step as the executors see it. */
export interface FlowCapabilityStep {
  id: string;
  kind: string;
  target: string;
  value: string | null;
  after: string[];
}

export interface FlowCapability {
  /** Stable contract id, identical to the planned step kind. Never renamed. */
  id: string;
  category: FlowCapabilityCategory;
  label: string;
  /** True when the action needs no network and no Jev or Laya engine. */
  offline: boolean;
  validate: (step: FlowValidateInput) => FlowValidateResult;
  readiness: (ctx: FlowCapabilityContext, step: FlowCapabilityStep) => FlowReadiness;
  approval: FlowApprovalPolicy;
  verification: FlowVerificationPolicy;
  /** Bound at adapter registration. A registered capability with no executor
   *  fails before dispatch as unavailable, never silently. */
  execute?: (
    step: FlowCapabilityStep,
    ctx: FlowCapabilityContext,
    generation: number,
  ) => Promise<string | null>;
}

export function defaultFlowContext(): FlowCapabilityContext {
  return {
    settings: { flowNotesFolder: "", flowSearchEngine: "", flowBrowser: "", flowEditor: "" },
    shortcuts: [],
    routines: [],
    online: true,
  };
}

const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+$/;
/** Windows-hostile title characters plus path separators. Titles never carry
 *  a path: the note lives in the configured folder only. */
const TITLE_BAD = /[<>:"/\\|?*\u0000-\u001f]/;

function boundedTitle(value: string | null): FlowValidateResult {
  const title = (value ?? "").trim();
  if (!title) return { ok: false, reason: "it has no name." };
  if (title.length > 60) return { ok: false, reason: "that name is too long." };
  if (TITLE_BAD.test(title)) return { ok: false, reason: "that name cannot be used." };
  return { ok: true };
}

/** Registry keyed by stable capability id. Registration refuses duplicates so
 *  a stable id can never silently change meaning. */
export class FlowCapabilityRegistry {
  private entries = new Map<string, FlowCapability>();

  register(capability: FlowCapability): void {
    const id = typeof capability?.id === "string" ? capability.id.trim() : "";
    if (!CAPABILITY_ID.test(id)) {
      throw new Error(`Invalid capability id "${id}".`);
    }
    if (this.entries.has(id)) {
      throw new Error(`Capability "${id}" is already registered.`);
    }
    this.entries.set(id, capability);
  }

  /** Binds or replaces the executor of a registered capability. Adapter
   *  registration owns this: bridge closures live here, not in the queue. */
  bind(id: string, execute: FlowCapability["execute"]): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Capability "${id}" is not registered.`);
    entry.execute = execute;
  }

  get(id: string): FlowCapability | null {
    return this.entries.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Registration order, stable for the capability view. */
  list(): FlowCapability[] {
    return [...this.entries.values()];
  }
}

function base(
  id: string,
  category: FlowCapabilityCategory,
  label: string,
  offline: boolean,
  verification: FlowVerificationPolicy,
  validate: (step: FlowValidateInput) => FlowValidateResult,
  readiness: (ctx: FlowCapabilityContext, step: FlowCapabilityStep) => FlowReadiness,
  approval: FlowApprovalPolicy = "none",
): FlowCapability {
  return { id, category, label, offline, verification, validate, readiness, approval };
}

const notesReadiness = (ctx: FlowCapabilityContext): FlowReadiness => {
  if (!ctx.settings.flowNotesFolder.trim()) {
    return { ready: false, reason: "Pick a notes folder in Settings first." };
  }
  return { ready: true };
};

const MEDIA_ACTIONS = ["play", "pause", "next", "previous", "toggle"] as const;
export type FlowMediaAction = (typeof MEDIA_ACTIONS)[number];

export function isFlowMediaAction(value: string): value is FlowMediaAction {
  return (MEDIA_ACTIONS as readonly string[]).includes(value);
}

/** The base capability set: the six stable Flow ids plus media and routine.
 *  Executors are bound later; a capability with no executor fails before
 *  dispatch as unavailable. */
export function createBaseFlowRegistry(): FlowCapabilityRegistry {
  const registry = new FlowCapabilityRegistry();

  registry.register(base(
    "note.create", "notes", "Create a note", true, "readback",
    (step) => boundedTitle(step.target),
    notesReadiness,
  ));
  registry.register(base(
    "note.rename", "notes", "Rename a note", true, "readback",
    (step) => {
      if (step.target !== SESSION_NOTE_REF) {
        return { ok: false, reason: "a rename only targets the note from this session." };
      }
      return boundedTitle(step.value);
    },
    notesReadiness,
  ));

  registry.register(base(
    "note.open", "notes", "Open a note", true, "dispatch",
    (step) => {
      if (step.target !== SESSION_NOTE_REF) {
        return { ok: false, reason: "opening a note only targets the note from this session." };
      }
      return { ok: true };
    },
    (ctx) => {
      if (!ctx.settings.flowNotesFolder.trim()) {
        return { ready: false, reason: "Pick a notes folder in Settings first." };
      }
      if (!ctx.settings.flowEditor.trim()) {
        return { ready: false, reason: "Pick a note editor in Settings first." };
      }
      return { ready: true };
    },
  ));

  registry.register(base(
    "app.launch", "launch", "Open an app", true, "dispatch",
    (step) => (step.target.trim() ? { ok: true } : { ok: false, reason: "it has no saved target." }),
    (ctx) => (ctx.shortcuts.some((s) => s.kind === "app")
      ? { ready: true }
      : { ready: false, reason: "Save the app in Tools first." }),
  ));
  registry.register(base(
    "folder.open", "launch", "Open a folder", true, "dispatch",
    (step) => (step.target.trim() ? { ok: true } : { ok: false, reason: "it has no saved target." }),
    (ctx) => (ctx.shortcuts.some((s) => s.kind === "folder")
      ? { ready: true }
      : { ready: false, reason: "Save the folder in Tools first." }),
  ));

  registry.register(base(
    "browser.search", "browser", "Search the web", false, "dispatch",
    (step) => {
      const query = step.target.trim();
      if (!query) return { ok: false, reason: "it has no search words." };
      if (query.length > 200) return { ok: false, reason: "that search is too long." };
      return { ok: true };
    },
    (ctx) => (ctx.settings.flowSearchEngine.includes("{q}")
      ? { ready: true }
      : { ready: false, reason: "The search engine URL needs a {q} placeholder." }),
  ));
  registry.register(base(
    "browser.open", "browser", "Open a link", false, "dispatch",
    (step) => (/^https?:\/\/\S+$/i.test(step.target.trim())
      ? { ok: true }
      : { ok: false, reason: "that link is not an http or https address." }),
    () => ({ ready: true }),
  ));

  // Media is verified by the actual post-action snapshot, so its policy is
  // readback: a matching snapshot is the evidence, and anything less stays
  // sent without proof.
  for (const action of MEDIA_ACTIONS) {
    registry.register(base(
      `media.${action}`, "media", `Media ${action}`, true, "readback",
      (step) => (step.target === action
        ? { ok: true }
        : { ok: false, reason: `media ${action} targets itself.` }),
      () => ({ ready: true }),
    ));
  }
  registry.register(base(
    "media.seek", "media", "Media seek", true, "readback",
    (step) => {
      const ms = Number(step.value ?? step.target);
      return Number.isFinite(ms) && ms >= 0
        ? { ok: true }
        : { ok: false, reason: "seek needs a position in milliseconds." };
    },
    () => ({ ready: true }),
  ));

  // Read-only context snapshots: local APIs whose result is its own proof.
  registry.register(base(
    "context.window", "system", "Active window", true, "readback",
    () => ({ ok: true }),
    () => ({ ready: true }),
  ));
  registry.register(base(
    "context.battery", "system", "Battery state", true, "readback",
    () => ({ ok: true }),
    () => ({ ready: true }),
  ));
  registry.register(base(
    "context.vitals", "system", "System vitals", true, "readback",
    () => ({ ok: true }),
    () => ({ ready: true }),
  ));

  registry.register(base(
    "routine.run", "routine", "Run a routine", true, "dispatch",
    (step) => (step.target.trim() ? { ok: true } : { ok: false, reason: "it names no routine." }),
    (ctx, step) => (ctx.routines.some((r) => r.id === step.target)
      ? { ready: true }
      : { ready: false, reason: "That routine is gone. Pick again." }),
    "explicit",
  ));

  return registry;
}

/**
 * Existing actions that stay outside the queue, with the precise reason. The
 * queue is extensible across supported capabilities; it is not a claim that
 * every Windows application can be controlled.
 */
export interface FlowUnavailableAdapter {
  id: string;
  category: FlowCapabilityCategory;
  label: string;
  reason: string;
}

export const FLOW_UNAVAILABLE_ADAPTERS: readonly FlowUnavailableAdapter[] = [
  {
    id: "dictation.capture",
    category: "dictation",
    label: "Dictation",
    reason: "The microphone stays owned by the voice controls; the queue never starts capture.",
  },
  {
    id: "agent.chat",
    category: "agent",
    label: "Agent reply",
    reason: "Agent replies keep the conversation path and its provider gate; the queue never dispatches generated text.",
  },
  {
    id: "file.attach",
    category: "files",
    label: "Attach file",
    reason: "Attaching a file needs the system picker click on the Voice card.",
  },
  {
    id: "window.attach",
    category: "system",
    label: "Attach window",
    reason: "Attaching a window needs the window picker click on the Voice card.",
  },
  {
    id: "integration.send",
    category: "integration",
    label: "Integration actions",
    reason: "Connected services keep their own confirmation cards; the queue never sends or approves on its own.",
  },
];
