// Transpiles the relative imports of already-chosen test sources, so a test
// harness follows the app's real import tree (JSON included) instead of a
// hand-kept file list. Files already in place are left alone.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;

/** base: source folder; out: mirror folder; rels: .ts paths relative to base. */
function compileDeps(base, out, rels) {
  const seen = new Set();
  const queue = [...rels];
  while (queue.length) {
    const rel = queue.pop().split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const srcPath = path.join(base, rel);
    const dest = path.join(out, rel.endsWith(".json") ? rel : rel.replace(/\.ts$/, ".js"));
    const source = fs.readFileSync(srcPath, "utf8");
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (rel.endsWith(".json")) fs.copyFileSync(srcPath, dest);
      else {
        fs.writeFileSync(dest, ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
          fileName: rel,
        }).outputText);
      }
    }
    if (rel.endsWith(".json")) continue;
    for (const m of source.matchAll(IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      for (const cand of [`${target}.ts`, target, `${target}/index.ts`]) {
        const full = path.join(base, cand);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          if (cand.endsWith(".css")) break;
          queue.push(cand);
          break;
        }
      }
    }
  }
}

module.exports = { compileDeps };
