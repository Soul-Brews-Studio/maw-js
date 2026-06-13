import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import pkg from "../../../package.json" with { type: "json" };
import { mawDataPath } from "../../core/xdg";

export const STANDARD_PLUGIN_MIN_COUNT = 50;
export const STANDARD_PLUGIN_CRITICAL_COUNT = 10;

export interface StandardPluginHealth {
  pluginDir: string;
  count: number;
  broken: string[];
  status: "ok" | "missing" | "low";
  minExpected: number;
}

export interface StandardPluginInstallOptions {
  pluginDir?: string;
  sourceRoot?: string;
  ref?: string;
  force?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
  fetch?: boolean;
}

export interface StandardPluginInstallResult {
  pluginDir: string;
  sourceRoot: string;
  installed: number;
  replaced: number;
  skipped: number;
  totalStandard: number;
  dryRun: boolean;
}

type PluginCandidate = { name: string; dir: string };

function defaultPluginDir(): string {
  return process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
}

function readJson(path: string): any | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function isMawJsRoot(root: string | undefined): boolean {
  if (!root) return false;
  const manifest = readJson(join(root, "package.json"));
  return manifest?.name === "maw-js";
}

function standardRoots(root: string): string[] {
  return [
    join(root, "src", "commands", "plugins"),
    join(root, "src", "vendor", "mpr-plugins"),
    join(root, "src", "vendor-plugins"),
  ].filter((dir) => existsSync(dir));
}

function refLooksVersioned(ref: string | undefined): boolean {
  return Boolean(ref && /^v?\d+\.\d+\.\d+/.test(ref));
}

function sourceMatchesRef(root: string, ref: string | undefined): boolean {
  if (!refLooksVersioned(ref)) return true;
  const manifest = readJson(join(root, "package.json"));
  const version = typeof manifest?.version === "string" ? manifest.version : "";
  return version === ref!.replace(/^v/, "");
}

function hasStandardPluginSources(root: string | undefined, ref?: string): root is string {
  if (!root || !isMawJsRoot(root)) return false;
  if (!sourceMatchesRef(root, ref)) return false;
  return collectStandardPlugins(root).length >= STANDARD_PLUGIN_MIN_COUNT;
}

function rootFromCliPath(path: string): string | undefined {
  const real = realpathSync(path);
  const normalized = real.replace(/\\/g, "/");
  if (normalized.endsWith("/src/cli.ts")) return dirname(dirname(real));
  if (normalized.endsWith("/dist/maw")) return dirname(dirname(real));
  return undefined;
}

function safeRefSegment(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function standardPluginCacheRoot(ref: string): string {
  return join(process.env.MAW_STANDARD_PLUGIN_CACHE_DIR || mawDataPath("standard-plugin-source"), safeRefSegment(ref));
}

function bunGlobalRoot(): string | undefined {
  try {
    const proc = Bun.spawnSync(["bun", "pm", "bin", "-g"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return undefined;
    const bin = new TextDecoder().decode(proc.stdout).trim();
    if (!bin) return undefined;
    const mawBin = join(bin, "maw");
    if (!existsSync(mawBin)) return undefined;
    return rootFromCliPath(mawBin);
  } catch {
    return undefined;
  }
}

function candidateSourceRoots(explicit?: string, ref?: string): string[] {
  const roots = [
    explicit,
    process.env.MAW_STANDARD_PLUGIN_SOURCE_ROOT,
    process.env.MAW_JS_PATH,
    resolve(import.meta.dir, "..", "..", ".."),
    bunGlobalRoot(),
    join(process.env.HOME || "", ".bun", "install", "global", "node_modules", "maw-js"),
  ].filter(Boolean) as string[];
  return [...new Set(roots.map((root) => resolve(root)))];
}

function defaultRef(): string {
  return process.env.MAW_STANDARD_PLUGIN_REF || `v${pkg.version}`;
}

function standardPluginGitUrl(): string {
  return process.env.MAW_STANDARD_PLUGIN_GIT_URL || "https://github.com/Soul-Brews-Studio/maw-js.git";
}

function hasInstalledNodeModules(root: string): boolean {
  return existsSync(join(root, "node_modules"));
}

function ensureFetchedSourceDependencies(root: string, log: (line: string) => void): void {
  if (hasInstalledNodeModules(root)) return;
  log(`→ installing standard plugin source dependencies: bun install (${root})`);
  const proc = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    throw new Error(stderr || stdout || `bun install exited ${proc.exitCode}`);
  }
}

function fetchMawJsSource(ref: string, log: (line: string) => void): string {
  const candidates = [ref, "alpha"].filter((value, index, arr) => value && arr.indexOf(value) === index);
  let last = "";
  for (const candidate of candidates) {
    const dest = standardPluginCacheRoot(candidate);
    try {
      if (hasStandardPluginSources(dest, candidate)) {
        ensureFetchedSourceDependencies(dest, log);
        return dest;
      }
      try { rmSync(dest, { recursive: true, force: true }); } catch {}
      mkdirSync(dirname(dest), { recursive: true });
      const url = standardPluginGitUrl();
      log(`→ fetching standard plugin source: git clone --depth 1 -b ${candidate} ${url} ${dest}`);
      const proc = Bun.spawnSync(["git", "clone", "--depth", "1", "--branch", candidate, url, dest], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0 || !hasStandardPluginSources(dest, candidate)) {
        const stderr = new TextDecoder().decode(proc.stderr).trim();
        const stdout = new TextDecoder().decode(proc.stdout).trim();
        throw new Error(stderr || stdout || `git clone exited ${proc.exitCode}`);
      }
      ensureFetchedSourceDependencies(dest, log);
      return dest;
    } catch (err: any) {
      last = err?.message || String(err);
      log(`  ! fetch failed for ${candidate}: ${last}`);
      try { rmSync(dest, { recursive: true, force: true }); } catch {}
    }
  }
  throw new Error(`failed to fetch maw-js standard plugin source (${last || "unknown error"})`);
}

export function resolveStandardPluginSourceRoot(options: { sourceRoot?: string; ref?: string; fetch?: boolean; log?: (line: string) => void } = {}): string {
  for (const root of candidateSourceRoots(options.sourceRoot, options.ref || defaultRef())) {
    if (hasStandardPluginSources(root, options.ref)) return root;
  }
  if (options.fetch === false) {
    throw new Error("standard plugin source not found; run from a maw-js checkout or allow fetching with git clone");
  }
  const fetched = fetchMawJsSource(options.ref || defaultRef(), options.log ?? console.log);
  if (hasStandardPluginSources(fetched, undefined)) return fetched;
  throw new Error("standard plugin source fetch completed, but no maw-js plugin sources were found");
}

export function collectStandardPlugins(sourceRoot: string): PluginCandidate[] {
  const plugins: PluginCandidate[] = [];
  const seen = new Set<string>();
  for (const root of standardRoots(sourceRoot)) {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      const manifest = readJson(join(dir, "plugin.json"));
      const name = typeof manifest?.name === "string" ? manifest.name : undefined;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      plugins.push({ name, dir });
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

function isBrokenSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && !existsSync(path); } catch { return false; }
}

function pathExistsOrSymlink(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function validInstalledPlugin(path: string): boolean {
  return existsSync(join(path, "plugin.json"));
}

function relativeSymlinkTarget(dest: string, src: string): string {
  let base = dirname(dest);
  try { base = realpathSync(base); } catch {}
  const rel = relative(base, src);
  return rel || ".";
}

export function inspectStandardPluginHealth(pluginDir = defaultPluginDir(), minExpected = STANDARD_PLUGIN_MIN_COUNT): StandardPluginHealth {
  try {
    const entries = readdirSync(pluginDir).filter((entry) => !entry.startsWith("."));
    const broken = entries.filter((entry) => isBrokenSymlink(join(pluginDir, entry)));
    const count = entries.filter((entry) => validInstalledPlugin(join(pluginDir, entry))).length;
    const status = count === 0 ? "missing" : count < minExpected ? "low" : "ok";
    return { pluginDir, count, broken, status, minExpected };
  } catch {
    return { pluginDir, count: 0, broken: [], status: "missing", minExpected };
  }
}

export function standardPluginHealthMessage(health: StandardPluginHealth): string | undefined {
  if (health.status === "ok" && health.broken.length === 0) return undefined;
  const loaded = `${health.count} loaded`;
  const expected = `expected at least ${health.minExpected}`;
  const broken = health.broken.length ? `, ${health.broken.length} broken symlink${health.broken.length === 1 ? "" : "s"}` : "";
  return `standard plugins ${health.status === "missing" ? "missing" : "low"}: ${loaded}${broken} (${expected})`;
}

export async function installStandardPlugins(options: StandardPluginInstallOptions = {}): Promise<StandardPluginInstallResult> {
  const pluginDir = options.pluginDir || defaultPluginDir();
  const log = options.log ?? console.log;
  const sourceRoot = resolveStandardPluginSourceRoot({ sourceRoot: options.sourceRoot, ref: options.ref, fetch: options.fetch, log });
  const plugins = collectStandardPlugins(sourceRoot);
  if (plugins.length < STANDARD_PLUGIN_MIN_COUNT) {
    throw new Error(`standard plugin source is incomplete: found ${plugins.length}, expected at least ${STANDARD_PLUGIN_MIN_COUNT}`);
  }

  let installed = 0;
  let replaced = 0;
  let skipped = 0;
  if (!options.dryRun) mkdirSync(pluginDir, { recursive: true });

  for (const plugin of plugins) {
    const dest = join(pluginDir, plugin.name);
    let replace = false;
    if (pathExistsOrSymlink(dest)) {
      if (isBrokenSymlink(dest) || !validInstalledPlugin(dest)) replace = true;
      else if (options.force && lstatSync(dest).isSymbolicLink()) replace = true;
      else {
        skipped++;
        continue;
      }
    }
    if (options.dryRun) {
      if (replace) replaced++; else installed++;
      continue;
    }
    if (replace) {
      try { unlinkSync(dest); } catch {
        throw new Error(`cannot replace existing non-symlink plugin '${plugin.name}' at ${dest}; remove it or pass a clean plugin dir`);
      }
      replaced++;
    } else {
      installed++;
    }
    symlinkSync(relativeSymlinkTarget(dest, plugin.dir), dest, "dir");
  }

  log(`${options.dryRun ? "would install" : "installed"} standard plugins: ${installed} new, ${replaced} replaced, ${skipped} kept → ${pluginDir}`);
  log(`source: ${sourceRoot}`);
  return { pluginDir, sourceRoot, installed, replaced, skipped, totalStandard: plugins.length, dryRun: !!options.dryRun };
}

export function formatStandardPluginHint(): string {
  return "Run: maw plugin install --standard  (or: maw wtf --fix)";
}
