const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const ts = require("typescript");
const path = require("node:path");

const calls = [];
let failure = null;
const source = fs.readFileSync(path.join(__dirname, "../src/core/bridge.ts"), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exportsObject = {};
vm.runInNewContext(code, {
  exports: exportsObject,
  window: { __TAURI_INTERNALS__: {} },
  console,
  require(name) {
    if (name === "@tauri-apps/api/core") return {
      async invoke(command, args) {
        calls.push({ command, args });
        if (failure) throw failure;
      },
    };
    return {};
  },
});

(async () => {
  const bridge = exportsObject.Bridge;
  failure = new Error("Audio device unavailable");
  await assert.rejects(bridge.voiceSpeak("Result", 42), /Audio device unavailable/);
  await assert.rejects(bridge.voiceAudition(), /Audio device unavailable/);
  failure = null;
  await bridge.voiceAudition();
  const sample = calls.at(-1);
  assert.equal(sample.command, "voice_speak");
  assert.equal(sample.args.audition, true);
  assert.equal(sample.args.generation, undefined);
  await bridge.voiceSpeak("Result", 42);
  assert.equal(calls.at(-1).args.generation, 42);
  console.log("PASS: talkback failures propagate; audition uses native state; results retain turn fencing.");
})().catch(error => { console.error(error); process.exitCode = 1; });
