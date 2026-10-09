// Tools frontend regression test. Compiles the real island modules with the
// project's TypeScript and asserts validation, paging, guard and card-copy
// behaviour. No new dependencies: only node and the project's typescript.
// Run from windows/: node scripts/tools-selftest.cjs (or npm run selftest).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["src/choom/tools.ts", "src/core/state.ts", "src/core/layout.ts"];

function compile(tmp) {
  for (const rel of SOURCES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: rel,
    }).outputText;
    const dest = path.join(tmp, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
  }
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-tools-test-"));
  try {
    compile(tmp);
    const T = require(path.join(tmp, "src/choom/tools.js"));
    const { State } = require(path.join(tmp, "src/core/state.js"));

    // normalizeHex mirrors the backend.
    assert.equal(T.normalizeHex("#1ed760"), "#1ED760");
    assert.equal(T.normalizeHex("1ED760"), "#1ED760");
    assert.equal(T.normalizeHex("#abc"), "#AABBCC");
    assert.equal(T.normalizeHex("  #AbC  "), "#AABBCC");
    for (const bad of ["", "#", "#12", "#1234", "red", "gggggg", "##123", "#12 34"]) {
      assert.equal(T.normalizeHex(bad), null, JSON.stringify(bad));
    }

    // addColour dedupes case-insensitively and caps at 24.
    let colours = [];
    ({ colours } = T.addColour(colours, "#1ED760"));
    ({ colours } = T.addColour(colours, "1ed760"));
    assert.deepEqual(colours, ["#1ED760"]);
    for (let i = 0; i < 30; i++) ({ colours } = T.addColour(colours, `#${i.toString(16).padStart(6, "0")}`));
    assert.equal(colours.length, 24);
    assert.equal(colours[0], "#00001D");
    assert.ok(!colours.includes("#1ED760"));
    assert.equal(T.addColour(colours, "nope").error, "Enter a HEX colour like #1ED760 or 1ED760.");

    // validateShortcutShape mirrors the backend shape rules, executables only.
    assert.equal(T.validateShortcutShape("app", "C:\\Tools\\app.exe"), null);
    assert.equal(T.validateShortcutShape("app", "C:\\Tools\\APP.EXE"), null);
    assert.equal(T.validateShortcutShape("folder", "C:\\Tools"), null);
    assert.equal(T.validateShortcutShape("app", "C:\\Tools\\run.bat"), "Pick an .exe file for an app shortcut.");
    assert.equal(T.validateShortcutShape("app", "C:\\Tools\\run.cmd"), "Pick an .exe file for an app shortcut.");
    assert.equal(T.validateShortcutShape("app", "C:\\Tools\\run.ps1"), "Pick an .exe file for an app shortcut.");
    assert.ok(T.validateShortcutShape("link", "C:\\x.exe"));
    assert.ok(T.validateShortcutShape("app", ""));
    assert.ok(T.validateShortcutShape("app", "relative\\x.exe"));
    assert.ok(T.validateShortcutShape("app", "https://example.com/x.exe"));

    // filter + paginate drive the searchable, paged lists.
    const shortcuts = [
      { id: "a", name: "Code", kind: "app", target: "C:\\a\\code.exe" },
      { id: "b", name: "Notes", kind: "folder", target: "D:\\notes" },
      { id: "c", name: "Code Review", kind: "app", target: "C:\\a\\review.exe" },
    ];
    assert.equal(T.filterShortcuts(shortcuts, "code").length, 2);
    assert.equal(T.filterShortcuts(shortcuts, "d:\\notes").length, 1);
    const page = T.paginate([1, 2, 3, 4, 5], 0, 4);
    assert.deepEqual([page.items.length, page.pages, page.total], [4, 2, 5]);
    assert.deepEqual(T.paginate([1, 2, 3], 9, 2).items, [3]);

    // resolveRoutineSteps + routinesUsing back the pre-Run preview and confirms.
    State.settings.tools = {
      version: 1, colours: [],
      shortcuts,
      routines: [{ id: "r1", name: "Ship", steps: ["a", "ghost"] }],
    };
    const resolved = T.resolveRoutineSteps(State.settings.tools.routines[0]);
    assert.equal(resolved[0].name, "Code");
    assert.equal(resolved[1].missing, true);
    assert.deepEqual(T.routinesUsing("a").map((r) => r.id), ["r1"]);
    assert.deepEqual(T.routinesUsing("zzz"), []);

    // Run guard prevents duplicate concurrent runs.
    assert.equal(T.getRunningRoutineId(), null);
    assert.equal(T.beginRoutine("r1"), true);
    assert.equal(T.beginRoutine("r1"), false);
    T.finishRoutine("other");
    assert.equal(T.getRunningRoutineId(), "r1");
    T.finishRoutine("r1");
    assert.equal(T.getRunningRoutineId(), null);

    // Pill sync creates the quiet pill without touching focus.
    State.tasks = [{ id: "integration_claude", name: "VS Code", color: "#F5F6F8", state: "idle", stepIndex: 0, steps: [], source: "claudeCode", isIntegration: true }];
    State.focusId = "integration_claude";
    T.syncToolsPill();
    assert.ok(State.tasks.some((t) => t.id === "utility_tools"));
    assert.equal(State.focusId, "integration_claude");

    // makeId produces backend-valid ids.
    assert.ok(/^[a-z0-9][a-z0-9-]{0,31}$/.test(T.makeId("sc")));
    assert.ok(T.isValidId("ship-it-2") && !T.isValidId("Ship it"));

    // Static card guards: hidden panels stay hidden, empty swatches span.
    const css = fs.readFileSync(path.join(ROOT, "src/choom/choom.css"), "utf8");
    assert.ok(css.includes(".tools-panel[hidden]"), "panel hidden rule present");
    assert.ok(css.includes(".tools-swatches > .tools-empty"), "empty swatch span present");

    // No banned sentence connectors in the new Tools copy.
    for (const rel of ["src-tauri/src/choom/tools.rs", "src/choom/tools.ts", "src/choom/toolsSection.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(!text.includes("\u2014"), `${rel} must not contain em dashes`);
      assert.ok(!text.includes("\u2013"), `${rel} must not contain en dashes`);
    }

    console.log("tools self-test: all assertions passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
