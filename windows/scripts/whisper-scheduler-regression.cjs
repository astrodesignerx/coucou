// Runtime checks against the actual embedded C# scheduler, using loopback inference.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { extractCsharp } = require("./whisper-helper-source.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choom-scheduler-"));
try {
  const framework = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
  const speechRoot = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "assembly", "GAC_MSIL", "System.Speech");
  const speech = fs.readdirSync(speechRoot).map(dir => path.join(speechRoot, dir, "System.Speech.dll")).find(file => fs.existsSync(file));
  assert.ok(speech, "System.Speech is available");
  const cs = path.join(tmp, "Scheduler.cs");
  const exe = path.join(tmp, "Scheduler.exe");
  fs.writeFileSync(cs, extractCsharp() + "\n" + fs.readFileSync(path.join(__dirname, "lib", "whisper-scheduler-tests.cs"), "utf8"));
  const compile = spawnSync(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", `/out:${exe}`, `/r:${speech}`, cs], { encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8", timeout: 20000, env: { ...process.env, CHOOM_VOICE_TEST: "1" } });
  process.stdout.write(run.stdout || "");
  assert.equal(run.status, 0, (run.stderr || "") + (run.error || ""));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
