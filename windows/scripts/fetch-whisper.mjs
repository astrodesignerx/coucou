// Puts the offline Whisper runtime in windows/voice-runtime/whisper, which the
// installer bundles (see tauri.conf.json resources). The binaries are too big
// for git, so this fetches the official upstream files and checks every one
// against a pinned SHA-256. Files that already match are left alone, so it is
// a no-op on a machine that already has them.
//
//   node scripts/fetch-whisper.mjs          fetch whatever is missing
//   node scripts/fetch-whisper.mjs --check  only report, never download

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "voice-runtime", "whisper");

// whisper.cpp b5454 (packaged with v1.9.5), Windows x64 CPU build.
const ARCHIVE = {
  url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
  sha256: "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
};

// Multilingual Base weights from the official whisper.cpp model repository.
const MODEL = {
  name: "ggml-base.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
};

// Files taken from the archive. The LICENSE files are committed to git.
const FROM_ARCHIVE = {
  "whisper-cli.exe": "331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366",
  "whisper.dll": "034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674",
  "ggml.dll": "31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e",
  "ggml-base.dll": "bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0",
  "ggml-cpu-alderlake.dll": "d8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603",
  "ggml-cpu-cannonlake.dll": "74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507",
  "ggml-cpu-cascadelake.dll": "4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e",
  "ggml-cpu-haswell.dll": "1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b",
  "ggml-cpu-icelake.dll": "2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40",
  "ggml-cpu-sandybridge.dll": "04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e",
  "ggml-cpu-skylakex.dll": "1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be",
  "ggml-cpu-sse42.dll": "f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a",
  "ggml-cpu-x64.dll": "4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3",
};

const checkOnly = process.argv.includes("--check");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function matches(name, expected) {
  const path = join(target, name);
  return existsSync(path) && sha256(path) === expected;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry === name) {
      return path;
    }
  }
  return null;
}

async function main() {
  const missingBinaries = Object.entries(FROM_ARCHIVE).filter(([name, hash]) => !matches(name, hash));
  const modelMissing = !matches(MODEL.name, MODEL.sha256);

  if (missingBinaries.length === 0 && !modelMissing) {
    console.log("whisper runtime: all files present and verified");
    return;
  }
  const missing = [...missingBinaries.map(([name]) => name), ...(modelMissing ? [MODEL.name] : [])];
  if (checkOnly) {
    console.error(`whisper runtime: missing or changed: ${missing.join(", ")}`);
    console.error("Run: node scripts/fetch-whisper.mjs");
    process.exit(1);
  }

  mkdirSync(target, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "choom-whisper-"));
  try {
    if (missingBinaries.length > 0) {
      const zip = join(work, "whisper-bin-x64.zip");
      console.log(`downloading ${ARCHIVE.url}`);
      await download(ARCHIVE.url, zip);
      if (sha256(zip) !== ARCHIVE.sha256) throw new Error("Archive checksum mismatch, refusing to use it.");
      const unpacked = join(work, "unpacked");
      execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force`,
      ], { stdio: "inherit" });
      for (const [name, hash] of missingBinaries) {
        const source = findFile(unpacked, name);
        if (!source) throw new Error(`${name} is not in the archive.`);
        if (sha256(source) !== hash) throw new Error(`${name} checksum mismatch.`);
        copyFileSync(source, join(target, name));
        console.log(`  ${name} ok`);
      }
    }
    if (modelMissing) {
      const model = join(work, MODEL.name);
      console.log(`downloading ${MODEL.url}`);
      await download(MODEL.url, model);
      if (sha256(model) !== MODEL.sha256) throw new Error("Model checksum mismatch, refusing to use it.");
      copyFileSync(model, join(target, MODEL.name));
      console.log(`  ${MODEL.name} ok`);
    }
    console.log("whisper runtime: ready");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`whisper runtime: ${err.message}`);
  process.exit(1);
});
