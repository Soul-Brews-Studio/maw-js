/**
 * maw plugin build [dir] [--watch] [--types]
 *
 * Phase B bundler (Wave 1A):
 *   1. Read + validate <dir>/plugin.json (reject target:"wasm" → Phase C).
 *   2. `bun build src/index.ts --outfile dist/index.js --target=bun --format=esm`
 *      (SDK bundled into plugin — no external flag, per sdk-foundation's plan).
 *   3. AST-based capability inference (Phase B default). Regex path kept behind
 *      MAW_PLUGIN_CAP_INFER=regex for rollback. Default: MAW_PLUGIN_CAP_INFER=ast.
 *   4. sha256 of the bundle, prefixed "sha256:" per architect's schema.
 *   5. Emit dist/plugin.json — copy of source manifest with capabilities filled
 *      in and artifact.{path,sha256} rewritten to the built bundle.
 *   6. Pack <dir>/<name>-<version>.tgz (flat: plugin.json + index.js at root).
 *   7. [--types only] Run tsc --emitDeclarationOnly → dist/<name>.d.ts
 *      Phase B Wave 1C (#340): opt-in typed output for plugin authors.
 *
 * Feature flag: MAW_PLUGIN_CAP_INFER=regex|ast (default: ast)
 *   Set to "regex" to fall back to Phase A regex inference if AST hits edge cases.
 *
 * Invariant: AST outputs are equal-or-stricter than regex. Never more permissive.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import { join, resolve, basename } from "path";
import { spawnSync } from "child_process";
import { parseFlags } from "../../../cli/parse-args";
import { inferCapabilitiesAst } from "../../../plugin/cap-infer-ast";

// ─── Capability inference ────────────────────────────────────────────────────

/**
 * Phase A regex rules over source. Kept as fallback behind MAW_PLUGIN_CAP_INFER=regex.
 *
 * Blind spots (all caught by Phase B AST path):
 *   • Destructured usage: `const { identity } = maw; identity()` — escapes `maw\.(\w+)`
 *   • Aliased binding: `const m = maw; m.identity()` — escapes `maw\.` regex
 *   • Bracket access: `maw["wake"]()` — escapes `maw\.\w+` regex
 *   • Dynamic require/import of risky modules not caught by static import regex
 */
export function inferCapabilitiesRegex(source: string): string[] {
  const caps = new Set<string>();

  // maw.<verb> — SDK method access
  for (const m of source.matchAll(/\bmaw\.(\w+)\b/g)) {
    caps.add(`sdk:${m[1]}`);
  }

  // node:fs / node:child_process / bun:ffi — known risky imports
  if (/import\s+[^;]*?['"]node:fs(?:\/\w+)?['"]/.test(source)) caps.add("fs:read");
  if (/import\s+[^;]*?['"]node:child_process['"]/.test(source)) caps.add("proc:spawn");
  if (/import\s+[^;]*?['"]bun:ffi['"]/.test(source)) caps.add("ffi:any");

  // global fetch() — not a member access (maw.fetch() is caught by sdk:fetch above)
  if (/(?:^|[^.\w])fetch\s*\(/.test(source)) caps.add("net:fetch");

  return [...caps].sort();
}

/**
 * inferCapabilities — dispatch to AST or regex based on MAW_PLUGIN_CAP_INFER.
 *
 * Default: "ast" (Phase B). Set MAW_PLUGIN_CAP_INFER=regex to fall back to
 * Phase A regex inference.
 *
 * The exported name `inferCapabilities` is kept stable so callers (build,
 * install, check commands) and existing tests don't change.
 */
export function inferCapabilities(source: string, fileName?: string): string[] {
  const mode = process.env.MAW_PLUGIN_CAP_INFER ?? "ast";
  if (mode === "regex") {
    return inferCapabilitiesRegex(source);
  }
  return inferCapabilitiesAst(source, fileName);
}

// ─── Command ─────────────────────────────────────────────────────────────────

interface BuildSummary {
  name: string;
  version: string;
  dir: string;
  bundlePath: string;
  sizeBytes: number;
  elapsedMs: number;
  capabilities: string[];
  inferredOnly: string[];  // inferred but not declared
  declaredOnly: string[];  // declared but not detected
  sha256: string;
  tgzPath: string;
  dtsPath?: string;        // set when --types was passed
}

export async function cmdPluginBuild(args: string[]): Promise<void> {
  const flags = parseFlags(args, { "--watch": Boolean, "--types": Boolean }, 0);
  const dir = resolve(flags._[0] || ".");
  const emitTypes = flags["--types"] === true;

  if (flags["--watch"]) {
    // `--watch` flag: watch mode, threads emitTypes through.
    await runWatch(dir, emitTypes);
    return;
  }

  await runBuild(dir, emitTypes);
}

/**
 * maw plugin dev [dir]
 *
 * First-class DX verb (Phase B6). Equivalent to `build --watch` today;
 * in a future sub-issue it will also `--link` the plugin after each build.
 * Keeping the two paths separate lets us diverge them without touching build.
 */
export async function cmdPluginDev(args: string[]): Promise<void> {
  const flags = parseFlags(args, {}, 0);
  const dir = resolve(flags._[0] || ".");
  const emitTypes = flags["--types"] === true;
  console.log(`\x1b[36mmaw plugin dev\x1b[0m — watch mode (Ctrl-C to stop)`);
  console.log(`  dir: ${dir}`);
  await runWatch(dir, emitTypes);
}

/** Shared watch-mode loop used by both `build --watch` and `dev`. */
async function runWatch(dir: string, emitTypes = false): Promise<void> {
  // One initial build, then rebuild on src change. Tolerate failures.
  await runBuild(dir, emitTypes).catch(() => {});
  console.log(`\n\x1b[36m⧖\x1b[0m watching ${dir}/src for changes (Ctrl-C to stop)...`);
  let building = false;
  const trigger = async () => {
    if (building) return;
    building = true;
    try {
      await runBuild(dir, emitTypes);
    } catch (e: any) {
      console.error(`\x1b[31m✗\x1b[0m rebuild failed: ${e.message}`);
    } finally {
      building = false;
    }
  };
  const srcDir = join(dir, "src");
  if (existsSync(srcDir)) {
    watch(srcDir, { recursive: true }, () => {
      void trigger();
    });
  }
  await new Promise(() => { /* keep alive */ });
}

async function runBuild(dir: string, emitTypes = false): Promise<BuildSummary> {
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no plugin.json in ${dir}`);
  }

  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e: any) {
    throw new Error(`invalid plugin.json: ${e.message}`);
  }

  // --- Target gate (Phase A: js only; wasm → Phase C message) ---
  const target = manifest.target ?? "js";
  if (target === "wasm") {
    throw new Error(`target "wasm" not yet supported (Phase C). Use target "js" for now.`);
  }
  if (target !== "js") {
    throw new Error(`unknown target ${JSON.stringify(target)} (expected "js")`);
  }

  const name = manifest.name;
  const version = manifest.version;
  const entry = manifest.entry || "./src/index.ts";
  const srcPath = join(dir, entry);
  if (!existsSync(srcPath)) {
    throw new Error(`entry not found: ${srcPath}`);
  }

  const distDir = join(dir, "dist");
  mkdirSync(distDir, { recursive: true });
  const outFile = join(distDir, "index.js");

  // --- Bundle with bun build ---
  const t0 = Date.now();
  const build = spawnSync(
    "bun",
    ["build", srcPath, "--outfile", outFile, "--target=bun", "--format=esm"],
    { cwd: dir, encoding: "utf8" },
  );
  const elapsedMs = Date.now() - t0;
  if (build.status !== 0) {
    throw new Error(`bundle failed:\n${build.stderr || build.stdout || "(no output)"}`);
  }

  const bundleBytes = readFileSync(outFile);
  const bundleSource = bundleBytes.toString("utf8");

  // --- Capability inference + declared-diff ---
  // AST mode: scan the pre-bundle source file (structured imports preserved).
  // Regex mode: scan the bundled output (Phase A compatibility — text search).
  const mode = process.env.MAW_PLUGIN_CAP_INFER ?? "ast";
  const scanSource = mode === "regex" ? bundleSource : readFileSync(srcPath, "utf8");
  const inferred = inferCapabilities(scanSource, srcPath);
  const declared = Array.isArray(manifest.capabilities) ? (manifest.capabilities as string[]) : [];
  const declaredSet = new Set(declared);
  const inferredSet = new Set(inferred);
  const inferredOnly = inferred.filter((c) => !declaredSet.has(c));
  const declaredOnly = declared.filter((c) => !inferredSet.has(c));
  const merged = [...new Set([...inferred, ...declared])].sort();

  // --- sha256 ---
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bundleBytes);
  const sha256 = "sha256:" + hasher.digest("hex");

  // --- dist/plugin.json: copy with updated capabilities + artifact ---
  const outManifest: Record<string, unknown> = {
    ...manifest,
    capabilities: merged,
    artifact: { path: "./index.js", sha256 },
    compiledAt: new Date().toISOString(),
  };
  // Built plugin loads via artifact; drop entry (source-only field).
  delete outManifest.entry;
  writeFileSync(join(distDir, "plugin.json"), JSON.stringify(outManifest, null, 2) + "\n");

  // --- Pack tarball (flat: plugin.json + index.js at root) ---
  const tgzName = `${name}-${version}.tgz`;
  const tgzPath = join(dir, tgzName);
  const tar = spawnSync(
    "tar",
    ["-czf", tgzPath, "-C", distDir, "plugin.json", "index.js"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) {
    throw new Error(`tarball packing failed: ${tar.stderr || tar.stdout}`);
  }

  // --- Optional .d.ts generation (Phase B Wave 1C, --types flag) ---
  let dtsPath: string | undefined;
  if (emitTypes) {
    const { generatePluginDts } = await import("./dts-gen");
    const dtsResult = generatePluginDts({
      pluginDir: dir,
      distDir,
      pluginName: name,
      entryPath: srcPath,
    });
    dtsPath = dtsResult.dtsPath;
  }

  // --- Summary ---
  const sizeBytes = bundleBytes.byteLength;
  const sizeKb = (sizeBytes / 1024).toFixed(1);
  const shaShort = sha256.slice(0, 7 + 12); // "sha256:" + 12 hex chars
  console.log(`\x1b[36m⚡\x1b[0m ${name}@${version}`);
  console.log(`  bundle:       ${basename(entry)} → dist/index.js (${sizeKb}kb, ${elapsedMs}ms)`);
  console.log(`  capabilities: [${merged.join(", ")}]`);
  if (inferredOnly.length) {
    console.log(`                \x1b[33m+ inferred (not declared):\x1b[0m ${inferredOnly.join(", ")}`);
  }
  if (declaredOnly.length) {
    console.log(`                \x1b[33m- declared (not detected):\x1b[0m ${declaredOnly.join(", ")}`);
  }
  console.log(`  hash:         ${shaShort}…`);
  console.log(`  packed:       ${tgzName}`);
  if (dtsPath) {
    console.log(`  types:        dist/${name}.d.ts \x1b[2m(--types)\x1b[0m`);
  }
  console.log(`\x1b[32m✓\x1b[0m ready. install with: maw plugin install ./${tgzName}`);

  return {
    name, version, dir, bundlePath: outFile, sizeBytes, elapsedMs,
    capabilities: merged, inferredOnly, declaredOnly, sha256, tgzPath, dtsPath,
  };
}
