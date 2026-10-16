// Compile check for the C# embedded in windows/voice-runtime/choom-voice.ps1.
//
// This does NOT run the production helper: it extracts the embedded block and
// compiles it with the .NET Framework compiler the same way PowerShell's
// Add-Type does, purely to prove the source type-checks. The helper process
// itself is Codex-run only, and this script never spawns it.
//
// CODEX AND BUILDER RUNNABLE: no helper process, no microphone, no model.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractCsharp } = require("./whisper-helper-source.cjs");

const CANDIDATES = [
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

// System.Speech and System.Web.Extensions are GAC assemblies, so they are
// resolved from the GAC folders rather than from the compiler directory.
// Resolved by search rather than hard-coded, so a different Windows build
// still works.
function gacAssembly(name) {
  const file = `${name}.dll`;
  const roots = [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "assembly"),
    path.join(process.env.WINDIR || "C:\\Windows", "assembly"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === file) return full;
      }
    }
  }
  return null;
}

const failures = [];
const check = (label, value) => {
  console.log(`${value ? "PASS" : "FAIL"}: ${label}`);
  if (!value) failures.push(label);
};

function findCompiler() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const compiler = findCompiler();
  if (!compiler) {
    console.log("SKIP: no .NET Framework C# compiler found; helper compile check not run.");
    console.log("helper compile: 0 checks run, nothing claimed");
    process.exitCode = 2;
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-helper-csc-"));
  try {
    const cs = path.join(tmp, "ChoomVoice.cs");
    const dll = path.join(tmp, "ChoomVoice.dll");
    fs.writeFileSync(cs, extractCsharp(), "utf8");

    const refs = [];
    for (const name of ["System.dll", "System.Core.dll"]) {
      const ref = path.join(path.dirname(compiler), name);
      if (fs.existsSync(ref)) refs.push(`/r:${ref}`);
    }
    // System.Speech is not referenced by default, so it is added by path.
    // System.Web.Extensions already sits in the compiler folder and is
    // referenced by default; naming it twice is a duplicate identity error,
    // so it is only added when the default set does not already carry it.
    const speech = gacAssembly("System.Speech");
    if (speech) refs.push(`/r:${speech}`);
    if (!fs.existsSync(path.join(path.dirname(compiler), "System.Web.Extensions.dll"))) {
      const web = gacAssembly("System.Web.Extensions");
      if (web) refs.push(`/r:${web}`);
    }

    const result = spawnSync(compiler, [
      "/nologo", "/target:library", "/platform:x64", "/optimize-", "/warnaserror-",
      `/out:${dll}`,
      ...refs,
      cs,
    ], { encoding: "utf8", timeout: 180000 });

    const log = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    check("embedded C# compiles with the .NET Framework compiler", result.status === 0);
    if (log) console.log(log.split("\n").slice(0, 40).join("\n"));
    // Errors are surfaced even when the compile succeeded, so a warning
    // cannot hide a real problem behind a zero exit code.
    const errors = (log.match(/error CS\d+/g) || []).length;
    check("no compiler errors reported", errors === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    failures.length === 0
      ? "helper compile: all assertions passed"
      : `helper compile: ${failures.length} FAILURES`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

main();