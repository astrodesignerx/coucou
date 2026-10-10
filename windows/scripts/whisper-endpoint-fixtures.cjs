// Synthetic PCM fixtures for the Whisper endpoint detector.
// 16kHz mono 16-bit WAVs with deterministic content: silence, speech-like
// sine, low noise, and a speech-pause-speech mix. This module only builds
// and validates inputs: every frame-RMS property asserted here mirrors the
// detector contract (100ms frames, speech at RMS 350 or above). The actual
// endpoint decisions are made by the production C# detector through the
// helper test_endpoint command, driven by whisper-endpoint-probe.cjs
// (Codex-run, needs the helper). No microphone anywhere.
//
// Run standalone: node scripts/whisper-endpoint-fixtures.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600;
const SPEECH_RMS = 350;

// Deterministic PRNG so noise fixtures are stable across runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function writeWav(filePath, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

function silence(seconds) {
  return new Array(Math.round(seconds * SAMPLE_RATE)).fill(0);
}

function speech(seconds, freq = 440, amp = 12000) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
      + amp * 0.3 * Math.sin((2 * Math.PI * freq * 2 * i) / SAMPLE_RATE));
  }
  return out;
}

function noise(seconds, amp = 40, seed = 7) {
  const rand = lcg(seed);
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round((rand() * 2 - 1) * amp);
  }
  return out;
}

function frameRms(samples, start) {
  let sum = 0;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const s = samples[start + i] || 0;
    sum += s * s;
  }
  return Math.sqrt(sum / FRAME_SAMPLES);
}

function classify(samples) {
  const frames = Math.floor(samples.length / FRAME_SAMPLES);
  const out = [];
  for (let f = 0; f < frames; f++) {
    out.push(frameRms(samples, f * FRAME_SAMPLES) >= SPEECH_RMS);
  }
  return out;
}

// Builds every fixture into dir and returns name-to-path plus the raw PCM
// so drivers and validators share one source of truth.
function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const built = {};
  const put = (name, samples) => {
    const file = path.join(dir, `${name}.wav`);
    writeWav(file, samples);
    built[name] = { file, samples };
  };
  put("silence-2s", silence(2));
  put("speech-2s", speech(2));
  put("noise-2s", noise(2));
  put("mixed-pause", [...speech(0.8), ...silence(1.2), ...speech(0.8)]);
  return built;
}

// Validates that each fixture actually is what its name claims, frame by
// frame under the detector contract. Throws on mismatch.
function validate(built) {
  const summary = {};
  for (const [name, { samples }] of Object.entries(built)) {
    const frames = classify(samples);
    const speechFrames = frames.filter(Boolean).length;
    summary[name] = { frames: frames.length, speechFrames };
  }
  if (summary["silence-2s"].speechFrames !== 0) throw new Error("silence fixture has speech frames");
  if (summary["silence-2s"].frames !== 20) throw new Error("silence fixture is not 2s");
  if (summary["speech-2s"].speechFrames !== summary["speech-2s"].frames) throw new Error("speech fixture has silent frames");
  if (summary["noise-2s"].speechFrames !== 0) throw new Error("noise fixture crosses the speech threshold");
  const mixed = classify(built["mixed-pause"].samples);
  if (mixed.length !== 28) throw new Error("mixed fixture is not 2.8s");
  for (let f = 0; f < 8; f++) {
    if (!mixed[f]) throw new Error(`mixed fixture frame ${f} should be speech`);
  }
  for (let f = 8; f < 20; f++) {
    if (mixed[f]) throw new Error(`mixed fixture frame ${f} should be silence`);
  }
  for (let f = 20; f < 28; f++) {
    if (!mixed[f]) throw new Error(`mixed fixture frame ${f} should be speech`);
  }
  return summary;
}

if (require.main === module) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "choom-endpoint-fixtures-"));
  try {
    const built = generate(dir);
    const summary = validate(built);
    for (const [name, s] of Object.entries(summary)) {
      console.log(`PASS: fixture ${name}: ${s.frames} frames, ${s.speechFrames} speech`);
    }
    console.log("endpoint fixtures: properties validated under the detector contract");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { generate, validate, writeWav, frameRms, SAMPLE_RATE, FRAME_SAMPLES, SPEECH_RMS };
