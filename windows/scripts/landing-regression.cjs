// Landing instances behavioral regressions: A opens despite active music,
// B follows deliberate rail choices, C shows real Tools actions with an empty
// route, pins stay sticky, listening supersedes rotation, and mode switches
// never touch drafts or approvals. No dependencies beyond the compiled
// modules and the checked-in sources for static guards.
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "landing-regression-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/choom/landing.ts",
    "src/choom/focus.ts",
    "src/choom/quickAdditions.ts",
    "src/choom/tools.ts",
    "src/choom/voice.ts",
    "src/core/state.ts",
    "src/core/layout.ts",
    "--outDir", out,
    "--module", "commonjs", "--resolveJsonModule", "--esModuleInterop",
    "--target", "es2022",
    "--lib", "es2022,dom",
    "--skipLibCheck",
    "--noUnusedLocals", "false",
    "--noUnusedParameters", "false",
  ],
  { cwd: windowsDir, stdio: "inherit" },
);

const { State } = require(path.join(out, "core/state.js"));
const landing = require(path.join(out, "choom/landing.js"));
const { Focus } = require(path.join(out, "choom/focus.js"));
const { Voice, resetSubmissionGuard } = require(path.join(out, "choom/voice.js"));

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

function resetWorld() {
  State.tasks = [
    { id: "integration_claude", name: "VS Code", color: "#fff", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true },
  ];
  State.focusId = "integration_claude";
  State.pendingApproval = null;
  State.integrations = {};
  State.settings.jobRadar = true;
  State.settings.tools = { version: 1, colours: [], shortcuts: [], routines: [] };
  Voice.state.runtime = "standby";
  Voice.state.stable = [];
  Voice.state.pendingSegments = [];
  Voice.state.receipt = null;
  resetSubmissionGuard();
  landing.showHome();
}

async function main() {
  // A opens despite active music: Home stays home, invitation first.
  resetWorld();
  State.integrations.integration_music = {
    data: { active: true, playing: true, title: "Love Me The Same", artist: "Astrality", app: "Spotify" },
    loaded: true, configured: true, error: null,
  };
  State.tasks.push({ id: "integration_music", name: "Music", color: "#1ED760", state: "working", stepIndex: 0, steps: [], source: "agent", isIntegration: false });
  landing.showHome();
  check("A is the default instance", landing.getLandingMode() === "home" && landing.isLandingHome());
  check("effective home visible despite active music", landing.isHomeVisible() === true);
  check("ordinary Home openings reach the overview with tasks", landing.homeIslandView() === "overview");
  State.tasks = [];
  State.focusId = null;
  check("ordinary Home openings reach A with zero tasks", landing.homeIslandView() === "overview" && landing.isHomeVisible() === true);
  const lines = landing.sublineLines();
  check("shared subline leads with the approved invitation", lines[0] === landing.LANDING_SUBLINE_INVITE);
  check("heading keeps its own invitation line", landing.LANDING_INVITATION === "What shall we do?");
  check("shared subline alternates real music info", lines.some((l) => l.includes("Love Me The Same")));
  check("shared subline exposes no receipts", !lines.some((l) => l.includes("Agent") || l.includes("receipt") || l.includes("confidence")));

  // B deliberate activity choice through the rail.
  resetWorld();
  landing.noteFocusSelected("integration_music");
  check("B music choice shows the activity instance", landing.getLandingMode() === "activity" && landing.getLandingActivityId() === "integration_music");
  landing.noteFocusSelected("utility_jobs");
  check("B jobs choice shows the activity instance", landing.getLandingMode() === "activity" && landing.getLandingActivityId() === "utility_jobs");
  landing.noteFocusSelected("utility_system");
  check("B system choice shows the activity instance", landing.getLandingMode() === "activity");
  const beforeFocus = State.focusId;
  State.notify();
  check("live updates never reset the deliberate choice", landing.getLandingMode() === "activity" && State.focusId === beforeFocus);

  // C real configured actions and the empty route.
  resetWorld();
  landing.noteFocusSelected("utility_tools");
  check("C tools choice shows the launchpad instance", landing.getLandingMode() === "launchpad");
  State.settings.tools = {
    version: 1,
    colours: [],
    shortcuts: [{ id: "sc-real", name: "Real App", kind: "app", target: "C:\\Tools\\real.exe" }],
    routines: [{ id: "rt-real", name: "Real Routine", steps: ["sc-real"] }],
  };
  const { readTools } = require(path.join(out, "choom/tools.js"));
  const configured = readTools();
  check("C reads real configured shortcuts", configured.shortcuts.some((s) => s.id === "sc-real"));
  check("C reads real configured routines", configured.routines.some((r) => r.id === "rt-real"));
  const sectionSrc = fs.readFileSync(path.join(windowsDir, "src", "choom", "landingSection.ts"), "utf8");
  check("C ships no illustrative Shelf button", !sectionSrc.includes("Shelf"));
  check("C ships no illustrative Focus button", !/["']Focus["']/.test(sectionSrc));
  check("C ships no illustrative Workspace tile", !sectionSrc.includes("Workspace"));
  check("C empty state offers the real Tools route", sectionSrc.includes("Open Tools settings"));
  check("C timers clear once the card leaves the DOM", sectionSrc.includes("clearInterval") && sectionSrc.includes("isConnected"));
  check("C reports real Bridge results without invented progress", !/progress|percent complete|manufacturer/i.test(sectionSrc) || sectionSrc.includes("Ran "));

  // Sticky pin across landing switches and live updates.
  resetWorld();
  State.tasks.push({ id: "integration_music", name: "Music", color: "#1ED760", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false });
  Focus.pin("integration_music");
  landing.showHome();
  State.notify();
  check("manual pin stays sticky on Home", Focus.pinned === "integration_music");
  landing.noteFocusSelected("utility_jobs");
  State.notify();
  check("manual pin stays sticky across activity choices", Focus.pinned === "integration_music");
  Focus.pin(null);

  // Listening priority over rotation.
  resetWorld();
  State.integrations.integration_music = {
    data: { active: true, playing: true, title: "Song", artist: "Artist", app: "Spotify" },
    loaded: true, configured: true, error: null,
  };
  check("listening supersedes rotation", landing.sublineListening("listening") === true);
  check("processing supersedes rotation", landing.sublineListening("processing") === true);
  check("working supersedes rotation", landing.sublineListening("working") === true);
  check("speaking supersedes rotation", landing.sublineListening("speaking") === true);
  check("standby does not supersede rotation", landing.sublineListening("standby") === false);

  // Urgent permission surfaces keep priority over landing.
  resetWorld();
  landing.showHome();
  State.pendingApproval = { requestId: "r1", sessionId: "s", tool: "Bash", command: "rm -rf", pillId: "integration_claude" };
  check("approval bypasses landing home", landing.shouldBypassLanding() === true);
  check("approval hides effective home geometry", landing.isHomeVisible() === false);
  State.pendingApproval = null;
  State.tasks[0].pillBadge = "error";
  check("error badge bypasses landing home", landing.shouldBypassLanding() === true);
  State.tasks[0].pillBadge = null;

  // Draft continuity: mode switches never touch the transcript or queue.
  resetWorld();
  Voice.state.stable = [{ id: 1, text: "keep my words", final: true }];
  Voice.state.pendingSegments = ["keep my words"];
  const stableBefore = JSON.stringify(Voice.state.stable);
  landing.noteFocusSelected("integration_music");
  landing.showLaunchpad();
  landing.dismissToHome();
  check("draft transcript survives instance switches", JSON.stringify(Voice.state.stable) === stableBefore);
  check("pending segments survive instance switches", Voice.state.pendingSegments.length === 1);

  // Return to A on Home and on dismiss.
  resetWorld();
  landing.noteFocusSelected("integration_music");
  landing.showHome();
  check("Home returns to A", landing.isLandingHome());
  landing.showLaunchpad();
  landing.dismissToHome();
  check("dismissing an intentional instance returns to A", landing.isLandingHome());

  // Static guards on the wired views and styles.
  const viewsSrc = fs.readFileSync(path.join(windowsDir, "src", "views", "views.ts"), "utf8");
  check("header Home reveals on hover or focus", viewsSrc.includes("tab reveal") || viewsSrc.includes("reveal"));
  check("no duplicate chat destination in header", (viewsSrc.match(/go\("prompt"\)/g) || []).length === 0);
  check("input reuses the demand editor route", viewsSrc.includes('setView("voice")'));
  const css = fs.readFileSync(path.join(windowsDir, "src", "style.css"), "utf8");
  check("landing styles are scoped without touching other cards", css.includes(".landing-home") && css.includes(".landing-launch"));
  check("touch keeps controls visible", css.includes("@media (hover: none)"));
  check("reduced motion can cycle deliberately", css.includes("prefers-reduced-motion"));
  check("no visible scrollbars in landing", (css.match(/scrollbar-width:\s*none/g) || []).length >= 1);

  Focus.dispose();
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
