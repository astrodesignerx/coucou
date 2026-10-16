// Extracts the embedded C# from windows/voice-runtime/choom-voice.ps1 into a
// .cs file so it can be compiled on its own. Shared by the continuous
// regression and the helper compile check; never edits the helper.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "voice-runtime", "choom-voice.ps1");

/** The C# between the `$csharp = @"` and the closing `"@` here-string. */
function extractCsharp(helperPath = HELPER) {
  const source = fs.readFileSync(helperPath, "utf8");
  const open = source.indexOf('$csharp = @"');
  if (open < 0) throw new Error("choom-voice.ps1: embedded C# block not found");
  const bodyAt = open + '$csharp = @"'.length;
  const close = source.indexOf('\n"@', bodyAt);
  if (close < 0) throw new Error("choom-voice.ps1: embedded C# block is not closed");
  return source.slice(bodyAt, close);
}

/** The whole helper, for structural assertions about the PowerShell command
 * surface. The test-mode gate is declared above the embedded C# block, so
 * anything that needs to see it must read the whole file. */
function extractPowerShell(helperPath = HELPER) {
  return fs.readFileSync(helperPath, "utf8");
}

/** Every C# method body between two markers, as one string. Used to assert
 * that a callback region really contains no file, process or driver work. */
function region(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`region start not found: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`region end not found: ${endMarker}`);
  return text.slice(start, end + endMarker.length);
}

module.exports = { extractCsharp, extractPowerShell, region, HELPER, ROOT };