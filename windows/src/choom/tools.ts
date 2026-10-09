// Compact local tools: colour pocket, command bar and routines at basic
// scope. The pill is quiet like System: it never ranks for the compact pill,
// never moves focus on its own and never samples anything in the background.
// All persistence flows through the existing settings save path; the backend
// revalidates colours, targets and steps on load and at launch time.
//
// Pure helpers here mirror the Rust validation so the card can report problems
// inline before anything touches the backend or the disk.

import { State, DEFAULT_TOOLS, type ToolRoutine, type ToolShortcut, type ToolsData } from "../core/state";

/** The one quiet tools pill. Stable once created, never renamed. */
export const TOOLS_ID = "utility_tools";
export const TOOLS_NAME = "Tools";
export const TOOLS_COLOR = "#EAB308";

/** Visual swatch history cap, newest first. Mirrors the backend. */
export const MAX_COLOURS = 24;
/** How many shortcut tiles and routine rows show before paging. Small pages
 * keep the card compact: the island grows only for needed content. */
export const SHORTCUT_PAGE = 3;
export const ROUTINE_PAGE = 3;

export type ToolsTab = "colours" | "shortcuts" | "routines";
let toolsTab: ToolsTab = "colours";

export function getToolsTab(): ToolsTab {
  return toolsTab;
}

export function setToolsTab(tab: ToolsTab): void {
  toolsTab = tab;
}

/** Shortcuts search text. Kept here so card updates never lose it. */
let shortcutQuery = "";

export function getShortcutQuery(): string {
  return shortcutQuery;
}

export function setShortcutQuery(query: string): void {
  shortcutQuery = query;
  shortcutPage = 0;
}

let shortcutPage = 0;

export function getShortcutPage(): number {
  return shortcutPage;
}

export function setShortcutPage(page: number): void {
  shortcutPage = Math.max(0, page);
}

let routinePage = 0;

export function getRoutinePage(): number {
  return routinePage;
}

export function setRoutinePage(page: number): void {
  routinePage = Math.max(0, page);
}

// Data access.

/** Tools data from settings, falling back to empty outside Tauri or boot. */
export function readTools(): ToolsData {
  const tools = State.settings.tools;
  if (!tools || typeof tools !== "object") return { ...DEFAULT_TOOLS, colours: [], shortcuts: [], routines: [] };
  return tools;
}

export function shortcutById(id: string): ToolShortcut | null {
  return readTools().shortcuts.find((s) => s.id === id) ?? null;
}

export function routineById(id: string): ToolRoutine | null {
  return readTools().routines.find((r) => r.id === id) ?? null;
}

/** Routines that reference a shortcut: shown before editing or deleting it. */
export function routinesUsing(shortcutId: string): ToolRoutine[] {
  return readTools().routines.filter((r) => r.steps.includes(shortcutId));
}

// Validation (mirrors windows/src-tauri/src/choom/tools.rs).

/** Normalises user-entered HEX to `#RRGGBB`, or null when it is not HEX. */
export function normalizeHex(input: string): string | null {
  const text = input.trim();
  const digits = text.startsWith("#") ? text.slice(1) : text;
  if (digits.length !== 3 && digits.length !== 6) return null;
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (digits.length === 3) {
    return `#${digits.split("").map((c) => c.toUpperCase().repeat(2)).join("")}`;
  }
  return `#${digits.toUpperCase()}`;
}

/** Adds a colour newest-first; duplicates move to the front, capped at 24. */
export function addColour(colours: string[], input: string): { colours: string[]; error: string | null } {
  const hex = normalizeHex(input);
  if (!hex) return { colours, error: "Enter a HEX colour like #1ED760 or 1ED760." };
  const rest = colours.filter((c) => c.toUpperCase() !== hex);
  return { colours: [hex, ...rest].slice(0, MAX_COLOURS), error: null };
}

export function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

export function makeId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}-${stamp}${rand}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
}

/** Shape check before the backend existence check: kind and full local path. */
export function validateShortcutShape(kind: string, target: string): string | null {
  if (kind !== "app" && kind !== "folder") return "Shortcut kind must be app or folder.";
  const trimmed = target.trim();
  if (!trimmed) return "Pick a file or folder first.";
  if (trimmed.length > 4096) return "That path is too long to be a shortcut target.";
  if (trimmed.includes("\0")) return "That path contains a character shortcuts cannot hold.";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("shell:")) {
    return "Shortcuts point at local files and folders, not links.";
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    return "Network and device paths are not supported. Use a local drive path like C:\\Tools\\app.exe.";
  }
  if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return "Shortcuts need a full path, like C:\\Tools\\app.exe.";
  }
  // Approved launching is executables only, matching the backend on Windows.
  if (kind === "app" && !/\.exe$/i.test(trimmed)) {
    return "Pick an .exe file for an app shortcut.";
  }
  return null;
}

export function cleanShortcutName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) return null;
  return trimmed;
}

// Lists.

/** Case-insensitive name and target search over saved shortcuts. */
export function filterShortcuts(shortcuts: ToolShortcut[], query: string): ToolShortcut[] {
  const q = query.trim().toLowerCase();
  if (!q) return shortcuts;
  return shortcuts.filter((s) =>
    s.name.toLowerCase().includes(q) || s.target.toLowerCase().includes(q),
  );
}

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** Paginates long lists so the card grows only for needed content. */
export function paginate<T>(list: T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  return { items: list.slice(at * size, at * size + size), page: at, pages, total: list.length };
}

/** Exact steps of a routine with names resolved, for the pre-Run preview. */
export function resolveRoutineSteps(routine: ToolRoutine): { id: string; name: string; kind: string; target: string; missing: boolean }[] {
  return routine.steps.map((id) => {
    const found = shortcutById(id);
    if (!found) return { id, name: id, kind: "app", target: "", missing: true };
    return { id, name: found.name, kind: found.kind, target: found.target, missing: false };
  });
}

// Duplicate-run prevention (frontend half; the backend gate double-guards).

let runningRoutineId: string | null = null;

export function getRunningRoutineId(): string | null {
  return runningRoutineId;
}

export function beginRoutine(id: string): boolean {
  if (runningRoutineId != null) return false;
  runningRoutineId = id;
  return true;
}

export function finishRoutine(id: string): void {
  if (runningRoutineId === id) runningRoutineId = null;
}

// Pill.

/** The Tools pill is always present and quiet: it never ranks, never warns. */
export function syncToolsPill(): void {
  if (!State.tasks.some((t) => t.id === TOOLS_ID)) {
    State.upsertExternalAgent(TOOLS_ID, TOOLS_NAME, TOOLS_COLOR);
  }
}

/**
 * Starts the tools wiring. Idempotent per call site: main.ts calls it once.
 * The pill only reacts to State, so settings changes apply without restart.
 */
export function registerTools(): () => void {
  const sync = () => syncToolsPill();
  const unsubscribe = State.subscribe(sync);
  sync();
  return () => unsubscribe();
}

// Card UI store. One place holds every form, selection and feedback so card
// updates never lose context and the island height follows the content.

export interface ShortcutForm {
  editingId: string | null;
  name: string;
  kind: "app" | "folder";
  target: string;
  error: string | null;
  confirmSave: boolean;
}

export interface RoutineForm {
  editingId: string | null;
  name: string;
  steps: string[];
  error: string | null;
}

export interface Feedback {
  kind: "error" | "ok";
  text: string;
}

let shortcutForm: ShortcutForm | null = null;
let deleteConfirmId: string | null = null;
let shortcutError: string | null = null;
let colourInput = "";
let colourFeedback: Feedback | null = null;
let clearConfirm = false;
let routineSelectedId: string | null = null;
let routineForm: RoutineForm | null = null;
let routineError: string | null = null;
const routineResults = new Map<string, import("../core/bridge").StepResult[]>();

export function getShortcutForm(): ShortcutForm | null {
  return shortcutForm;
}

export function setShortcutForm(form: ShortcutForm | null): void {
  shortcutForm = form;
}

export function getDeleteConfirmId(): string | null {
  return deleteConfirmId;
}

export function setDeleteConfirmId(id: string | null): void {
  deleteConfirmId = id;
}

export function getShortcutError(): string | null {
  return shortcutError;
}

export function setShortcutError(error: string | null): void {
  shortcutError = error;
}

export function getColourInput(): string {
  return colourInput;
}

export function setColourInput(value: string): void {
  colourInput = value;
}

export function getColourFeedback(): Feedback | null {
  return colourFeedback;
}

export function setColourFeedback(feedback: Feedback | null): void {
  colourFeedback = feedback;
}

export function getClearConfirm(): boolean {
  return clearConfirm;
}

export function setClearConfirm(on: boolean): void {
  clearConfirm = on;
}

export function getRoutineSelectedId(): string | null {
  return routineSelectedId;
}

export function setRoutineSelectedId(id: string | null): void {
  routineSelectedId = id;
}

export function getRoutineForm(): RoutineForm | null {
  return routineForm;
}

export function setRoutineForm(form: RoutineForm | null): void {
  routineForm = form;
}

export function getRoutineError(): string | null {
  return routineError;
}

export function setRoutineError(error: string | null): void {
  routineError = error;
}

export function getRoutineResults(id: string): import("../core/bridge").StepResult[] | null {
  return routineResults.get(id) ?? null;
}

export function setRoutineResults(id: string, results: import("../core/bridge").StepResult[]): void {
  routineResults.set(id, results);
}

/** Whether any Tools form or preview is open: the island grows for it. */
export function toolsDetailOpen(): boolean {
  return shortcutForm != null || routineForm != null || routineSelectedId != null;
}

// Saving: serialized, commit-on-success.

export interface ToolSaveDeps {
  /** Current committed tools, read at execution time (not call time). */
  load: () => ToolsData;
  /** Backend save; returns the stored tools or throws. */
  save: (data: ToolsData) => Promise<ToolsData>;
  /** Commits stored tools after a successful save. */
  commit: (data: ToolsData) => void;
}

export interface ToolSaveOutcome {
  ok: boolean;
  error: string | null;
}

let saveChain: Promise<void> = Promise.resolve();

/**
 * Saves one tools mutation through the backend. Operations serialize in call
 * order and each reads the latest committed state when it runs, so rapid
 * concurrent saves retain every change. State commits only on success; a
 * failure returns an actionable error and leaves edits available.
 */
export function saveToolsData(
  mut: (data: ToolsData) => ToolsData,
  deps: ToolSaveDeps,
): Promise<ToolSaveOutcome> {
  const run = saveChain.then(async (): Promise<ToolSaveOutcome> => {
    const next = mut(structuredClone(deps.load()));
    try {
      deps.commit(await deps.save(next));
      return { ok: true, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message.replace(/^Error:\s*/, "") };
    }
  });
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
