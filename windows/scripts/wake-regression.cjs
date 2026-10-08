// WakeHold regressions: deliberate hover wake without a hidden poll.
// No dependencies beyond the compiled wake module and stubbed timers.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const windowsDir = path.join(root, "windows");
const out = path.join(root, ".scratch", "wake-regression-built");
execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "src/choom/wake.ts",
    "--outDir", out,
    "--module", "commonjs",
    "--target", "es2020",
    "--lib", "es2020,dom",
    "--skipLibCheck",
  ],
  { cwd: windowsDir, stdio: "inherit" },
);

const { WakeHold } = require(path.join(out, "wake.js"));

let failed = 0;
function check(label, value) {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failed++;
}

// Deterministic timers.
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
let clock = 100000;
const scheduled = new Map();
let timerID = 0;
global.window = {
  setTimeout: (fn, ms) => { const id = ++timerID; scheduled.set(id, { fn, at: clock + ms }); return id; },
  clearTimeout: (id) => { scheduled.delete(id); },
};
function advance(ms) {
  const target = clock + ms;
  for (let n = 0; n < 100000; n++) {
    let id = null;
    let next = null;
    for (const [key, t] of scheduled) {
      if (t.at <= target && (!next || t.at < next.at)) { id = key; next = t; }
    }
    if (!next) break;
    clock = next.at;
    scheduled.delete(id);
    next.fn();
  }
  clock = target;
}
const flush = () => new Promise((r) => realSetTimeout(r));

async function main() {
  // 1: dwell then allowed wakes.
  let woke = 0;
  let hidden = true;
  let allowedResult = true;
  const mk = () => new WakeHold({
    dwellMs: () => 150,
    stillHidden: () => hidden,
    allowed: async () => allowedResult,
    wake: () => { woke++; },
  });
  let h = mk();
  h.enter(0);
  advance(149);
  await flush();
  check("dwell does not fire early", woke === 0);
  advance(1);
  await flush();
  check("dwell plus allowed wakes once", woke === 1);

  // 2: held button cancels and release over the strip rearms without leaving.
  woke = 0;
  h = mk();
  h.enter(1);
  advance(500);
  await flush();
  check("held button never arms", woke === 0);
  h.release();
  advance(150);
  await flush();
  check("release over the strip rearms", woke === 1);

  // 3: press without movement cancels, release recovers.
  woke = 0;
  h = mk();
  h.enter(0);
  h.down(1);
  advance(500);
  await flush();
  check("press cancels the dwell", woke === 0);
  h.release();
  advance(150);
  await flush();
  check("release after press wakes", woke === 1);

  // 4: plain moves never restart the dwell.
  woke = 0;
  h = mk();
  h.enter(0);
  advance(50);
  h.move(0);
  h.move(0);
  advance(100);
  await flush();
  check("moves keep the original dwell", woke === 1);
  // Cursor already over the strip after collapse: first move arms.
  woke = 0;
  h = mk();
  h.move(0);
  advance(150);
  await flush();
  check("first move after collapse arms", woke === 1);

  // 5: drag cancels, release rearms once.
  woke = 0;
  h = mk();
  h.enter(0);
  advance(50);
  h.move(1);
  advance(500);
  await flush();
  check("drag cancels", woke === 0);
  h.move(0);
  advance(150);
  await flush();
  check("end of drag rearms once", woke === 1);

  // 6: leaving invalidates a stale async check.
  woke = 0;
  hidden = true;
  allowedResult = true;
  h = mk();
  let resolveAllowed;
  const gated = new WakeHold({
    dwellMs: () => 10,
    stillHidden: () => hidden,
    allowed: () => new Promise((r) => { resolveAllowed = r; }),
    wake: () => { woke++; },
  });
  gated.enter(0);
  advance(10);
  gated.leave();
  resolveAllowed(true);
  await flush();
  check("exit before the gate resolves never wakes", woke === 0);

  // 7: fullscreen denial and visibility changes never wake.
  woke = 0;
  allowedResult = false;
  h = mk();
  h.enter(0);
  advance(150);
  await flush();
  check("fullscreen denial stays hidden", woke === 0);
  allowedResult = true;
  hidden = false;
  h = mk();
  h.enter(0);
  advance(200);
  await flush();
  check("visible island never rewakes", woke === 0);
  hidden = true;

  // 8: buttons held at fire time never wake.
  woke = 0;
  h = mk();
  h.enter(0);
  h.move(1);
  advance(200);
  await flush();
  check("held button at fire time stays hidden", woke === 0);

  // 9: instant dwell still honours the gate.
  woke = 0;
  const instant = new WakeHold({
    dwellMs: () => 0,
    stillHidden: () => true,
    allowed: async () => true,
    wake: () => { woke++; },
  });
  instant.enter(0);
  advance(0);
  await flush();
  check("instant dwell wakes", woke === 1);

  delete global.window;
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

main().then(
  () => { process.exitCode = failed ? 1 : 0; },
  (err) => { console.error(err); process.exitCode = 1; },
);
