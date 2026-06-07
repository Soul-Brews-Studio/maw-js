import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { loadPeers } from "./internal/peers-store";
import { findDuplicateIdentities, formatDuplicate } from "./internal/duplicate-detect";
import { loadConfig } from "maw-js/config";
import { C } from "maw-js/commands/shared/fleet-doctor-fixer";
import {
  isMawXdgEnabled,
  mawCacheDir,
  mawConfigDir,
  mawDataDir,
  mawDataPath,
  mawStateDir,
  legacyMawPath,
} from "../../../core/xdg";
import { loadManifestCached, invalidateManifest } from "maw-js/lib/oracle-manifest";
import { findGaps, summarizeGaps } from "./cross-source-detect";
import { checkMawJsBranch } from "./internal/maw-js-branch-check";
import { checkStillbornWorktrees } from "./internal/stillborn-worktrees";
import { checkStalePeers, cmdFixStalePeers } from "./internal/stale-peers";
import { detectBunLinkedCheckout } from "./internal/bun-link-detect";

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message: string; details?: unknown }>;
}

export async function cmdDoctor(args: string[] = []): Promise<DoctorResult> {
  const flags = new Set(args.filter(a => a.startsWith("--")));
  const positional = args.filter(a => !a.startsWith("--"));
  const only = positional[0];
  const allowDrift = flags.has("--allow-drift");
  const json = flags.has("--json");
  const smoke = flags.has("--smoke") || only === "smoke";
  const xdgMigrate = flags.has("--migrate") || flags.has("--fix-xdg");
  const xdgDryRun = flags.has("--dry-run") || flags.has("--plan");
  const checks: DoctorResult["checks"] = [];

  // #1238 — `maw doctor --fix-stale` short-circuits the normal check
  // suite: this is a destructive sweep, not a diagnostic. Returns the
  // fix result directly so index.ts surfaces it unchanged.
  if (flags.has("--fix-stale")) {
    return await cmdFixStalePeers();
  }

  if (smoke) {
    const smokeChecks = await runSmokeTests();
    for (const c of smokeChecks) checks.push(c);
  } else {
    if (!only || only === "install" || only === "all") {
      checks.push(await checkInstall());
    }
    if (only === "xdg" || only === "all") {
      checks.push(xdgMigrate ? migrateXdgLayout({ dryRun: xdgDryRun }) : checkXdgLayout());
    }
    if (!only || only === "version" || only === "all") {
      const vChecks = await checkVersionDrift();
      for (const c of vChecks) checks.push(c);
    }
    if (!only || only === "peers" || only === "all") {
      checks.push(checkPeerDuplicates());
      checks.push(checkStalePeers());
    }
    if (!only || only === "manifest" || only === "all") {
      checks.push(checkCrossSourceConsistency());
    }
    if (!only || only === "maw-js" || only === "all") {
      checks.push(await checkMawJsBranch());
    }
    if (!only || only === "worktrees" || only === "all") {
      checks.push(checkStillbornWorktrees());
    }
  }

  const hardOk = checks.every(c => c.ok);
  const onlyDriftFails = !hardOk && checks.every(c => c.ok || c.name.startsWith("version:"));
  const ok = hardOk || (allowDrift && onlyDriftFails);
  if (json) renderJsonResults(checks, ok);
  else renderResults(checks, ok);
  return { ok, checks };
}

async function checkInstall(): Promise<{ name: string; ok: boolean; message: string }> {
  const binPath = join(homedir(), ".bun/bin/maw");
  const exists = existsSync(binPath);
  if (!exists) {
    console.log(`  ${C.yellow}⚠${C.reset} maw binary missing at ${binPath}`);
    // #1281 — Skip auto-reinstall when maw-js is bun-linked to a local dev
    // checkout. `bun add -g github:…` would silently replace the symlink
    // with a fresh clone, blowing away the dev workflow. Tell the operator
    // how to restore the link instead.
    const localCheckout = detectBunLinkedCheckout();
    if (localCheckout) {
      console.log(`  ${C.yellow}⚠${C.reset} maw is bun-linked to dev checkout: ${localCheckout}`);
      console.log(`  ${C.gray}run: cd ${localCheckout} && bun link${C.reset}`);
      return {
        name: "install",
        ok: false,
        message: `dev bun-link at ${localCheckout} — run bun link to restore`,
      };
    }
    console.log(`  ${C.gray}attempting reinstall…${C.reset}`);
    try {
      execSync("bun add -g github:Soul-Brews-Studio/maw-js", { stdio: "inherit" });
      const nowExists = existsSync(binPath);
      return {
        name: "install",
        ok: nowExists,
        message: nowExists
          ? "reinstalled from github:Soul-Brews-Studio/maw-js"
          : "reinstall did not produce the binary — manual intervention needed",
      };
    } catch (e: any) {
      return { name: "install", ok: false, message: `reinstall failed: ${e.message || e}` };
    }
  }
  try {
    const link = readlinkSync(binPath);
    const abs = link.startsWith("/") ? link : resolve(dirname(binPath), link);
    if (!existsSync(abs)) {
      return { name: "install", ok: false, message: `binary is a broken symlink → ${abs}` };
    }
  } catch { /* not a symlink — that's fine */ }
  return { name: "install", ok: true, message: "maw binary present and resolvable" };
}

function checkXdgLayout(): DoctorResult["checks"][number] {
  const legacyRuntime = legacyMawPath();
  const legacyRuntimeState = existsSync(legacyRuntime) ? "present" : "missing";
  const configRuntimeArtifacts = existingXdgArtifacts(mawConfigDir(), CONFIG_RUNTIME_ARTIFACTS);
  const legacyRuntimeArtifacts = existingXdgArtifacts(legacyRuntime, LEGACY_RUNTIME_ARTIFACTS);
  const mode = process.env.MAW_HOME
    ? `MAW_HOME=${process.env.MAW_HOME}`
    : isMawXdgEnabled()
      ? "MAW_XDG=on"
      : "MAW_XDG=off";
  const nextAction = xdgNextAction(configRuntimeArtifacts, legacyRuntimeArtifacts);
  const details = {
    mode,
    paths: {
      config: mawConfigDir(),
      state: mawStateDir(),
      data: mawDataDir(),
      cache: mawCacheDir(),
      legacyRuntime,
    },
    legacyRuntimeState,
    artifacts: {
      configRuntime: configRuntimeArtifacts,
      legacyRuntime: legacyRuntimeArtifacts,
    },
    nextAction,
  };

  return {
    name: "xdg:paths",
    ok: true,
    message: [
      mode,
      `config=${mawConfigDir()}`,
      `state=${mawStateDir()}`,
      `data=${mawDataDir()}`,
      `cache=${mawCacheDir()}`,
      `legacy ~/.maw ${legacyRuntimeState}`,
      artifactSummary("config-runtime", configRuntimeArtifacts),
      artifactSummary("legacy-runtime", legacyRuntimeArtifacts),
      `action=${nextAction}`,
    ].join("; "),
    details,
  };
}

const CONFIG_RUNTIME_ARTIFACTS = [
  "audit.jsonl",
  "fleet-resume.log",
  "snapshots",
  "fleet",
  "teams",
  "workspaces",
  "tab-order",
  "message-ledger.sqlite",
  "oracle-births.json",
  "oracles.json",
  "peer-key",
  "auth-secret",
  "session-warnings.state",
  "pending",
  "parked",
  "trust.json",
  "consent-pending",
] as const;

const LEGACY_RUNTIME_ARTIFACTS = [
  "plugins",
  "node_modules",
  "sessions",
  "state",
  "inbox",
  "schedules",
  "teams",
  "peers.json",
  "audit.jsonl",
  "artifacts",
  "inst",
  "ui",
  "message-ledger.sqlite",
  "nicknames.json",
] as const;

function existingXdgArtifacts(base: string, names: readonly string[]): string[] {
  return names.filter((name) => existsSync(join(base, name)));
}

function artifactSummary(label: string, names: string[]): string {
  if (names.length === 0) return `${label}=0`;
  const preview = names.slice(0, 8).join(",");
  const suffix = names.length > 8 ? `,+${names.length - 8}` : "";
  return `${label}=${names.length} [${preview}${suffix}]`;
}

function xdgNextAction(configRuntimeArtifacts: string[], legacyRuntimeArtifacts: string[]): string {
  if (configRuntimeArtifacts.length > 0 && legacyRuntimeArtifacts.length > 0) {
    return "mixed-runtime-state: run 'maw doctor xdg --migrate --dry-run', then 'maw doctor xdg --migrate'";
  }
  if (configRuntimeArtifacts.length > 0) {
    return "config-runtime-state: run 'maw doctor xdg --migrate' to copy runtime/cache/data artifacts out of config dir";
  }
  if (legacyRuntimeArtifacts.length > 0 && isMawXdgEnabled()) {
    return "legacy-runtime-state: run 'maw doctor xdg --migrate' while read-through fallback is active";
  }
  return "ok";
}

type XdgBucket = "state" | "data" | "cache";
type XdgMigrationSource = "config" | "legacy";
type XdgMigrationOutcome = "copied" | "dry-run" | "missing" | "exists" | "same" | "error";

interface XdgMigrationItem {
  sourceKind: XdgMigrationSource;
  name: string;
  bucket: XdgBucket;
  source: string;
  destination: string;
  outcome?: XdgMigrationOutcome;
  message?: string;
}

const CONFIG_MIGRATION_TARGETS: Record<(typeof CONFIG_RUNTIME_ARTIFACTS)[number], XdgBucket> = {
  "audit.jsonl": "state",
  "fleet-resume.log": "state",
  snapshots: "state",
  fleet: "state",
  teams: "state",
  workspaces: "data",
  "tab-order": "state",
  "message-ledger.sqlite": "data",
  "oracle-births.json": "cache",
  "oracles.json": "cache",
  "peer-key": "state",
  "auth-secret": "state",
  "session-warnings.state": "state",
  pending: "state",
  parked: "state",
  "trust.json": "state",
  "consent-pending": "state",
};

const LEGACY_MIGRATION_TARGETS: Record<(typeof LEGACY_RUNTIME_ARTIFACTS)[number], XdgBucket> = {
  plugins: "data",
  node_modules: "cache",
  sessions: "state",
  state: "state",
  inbox: "data",
  schedules: "state",
  teams: "state",
  "peers.json": "state",
  "audit.jsonl": "state",
  artifacts: "cache",
  inst: "data",
  ui: "data",
  "message-ledger.sqlite": "data",
  "nicknames.json": "cache",
};

function absoluteXdgEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.startsWith("/") ? value : null;
}

function xdgSpecBase(envName: string, ...fallback: string[]): string {
  return absoluteXdgEnv(envName) ?? join(homedir(), ...fallback);
}

function xdgMigrationDir(bucket: XdgBucket): string {
  if (process.env.MAW_HOME) return process.env.MAW_HOME;
  if (bucket === "state") return process.env.MAW_STATE_DIR || join(xdgSpecBase("XDG_STATE_HOME", ".local", "state"), "maw");
  if (bucket === "data") return process.env.MAW_DATA_DIR || join(xdgSpecBase("XDG_DATA_HOME", ".local", "share"), "maw");
  return process.env.MAW_CACHE_DIR || join(xdgSpecBase("XDG_CACHE_HOME", ".cache"), "maw");
}

function xdgMigrationDestination(bucket: XdgBucket, name: string): string {
  return join(xdgMigrationDir(bucket), name);
}

function buildXdgMigrationPlan(): XdgMigrationItem[] {
  const configBase = mawConfigDir();
  const legacyBase = legacyMawPath();
  const items: XdgMigrationItem[] = [];

  for (const name of CONFIG_RUNTIME_ARTIFACTS) {
    const bucket = CONFIG_MIGRATION_TARGETS[name];
    items.push({
      sourceKind: "config",
      name,
      bucket,
      source: join(configBase, name),
      destination: xdgMigrationDestination(bucket, name),
    });
  }

  for (const name of LEGACY_RUNTIME_ARTIFACTS) {
    const bucket = LEGACY_MIGRATION_TARGETS[name];
    items.push({
      sourceKind: "legacy",
      name,
      bucket,
      source: join(legacyBase, name),
      destination: xdgMigrationDestination(bucket, name),
    });
  }

  return items;
}

function copyXdgArtifact(item: XdgMigrationItem, dryRun: boolean): XdgMigrationItem {
  if (!existsSync(item.source)) return { ...item, outcome: "missing" };
  if (resolve(item.source) === resolve(item.destination)) return { ...item, outcome: "same" };
  if (existsSync(item.destination)) return { ...item, outcome: "exists" };
  if (dryRun) return { ...item, outcome: "dry-run" };

  try {
    const stat = lstatSync(item.source);
    mkdirSync(dirname(item.destination), { recursive: true });
    cpSync(item.source, item.destination, {
      recursive: stat.isDirectory(),
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    return { ...item, outcome: "copied" };
  } catch (e: any) {
    return { ...item, outcome: "error", message: e?.message || String(e) };
  }
}

function summarizeMigration(items: XdgMigrationItem[]): Record<XdgMigrationOutcome, number> {
  const summary: Record<XdgMigrationOutcome, number> = {
    copied: 0,
    "dry-run": 0,
    missing: 0,
    exists: 0,
    same: 0,
    error: 0,
  };
  for (const item of items) summary[item.outcome || "missing"]++;
  return summary;
}

function migrateXdgLayout(opts: { dryRun: boolean }): DoctorResult["checks"][number] {
  const planned = buildXdgMigrationPlan().map(item => copyXdgArtifact(item, opts.dryRun));
  const summary = summarizeMigration(planned);
  const actionable = planned.filter(item => item.outcome === "copied" || item.outcome === "dry-run" || item.outcome === "error");
  const preview = actionable
    .slice(0, 8)
    .map(item => `${item.sourceKind}:${item.name}->${item.bucket}:${item.outcome}`)
    .join(", ");
  const suffix = actionable.length > 8 ? `,+${actionable.length - 8}` : "";
  const mode = opts.dryRun ? "dry-run" : "apply";
  const ok = summary.error === 0;
  return {
    name: "xdg:migrate",
    ok,
    message: [
      mode,
      `copied=${summary.copied}`,
      `planned=${summary["dry-run"]}`,
      `exists=${summary.exists}`,
      `missing=${summary.missing}`,
      `same=${summary.same}`,
      `errors=${summary.error}`,
      preview ? `[${preview}${suffix}]` : "no actionable artifacts",
    ].join("; "),
    details: {
      mode,
      targets: {
        state: xdgMigrationDir("state"),
        data: xdgMigrationDir("data"),
        cache: xdgMigrationDir("cache"),
      },
      summary,
      items: planned,
      note: "safe copy-forward only: existing destinations are preserved and legacy sources are not deleted",
    },
  };
}

/**
 * Version drift: compare source package.json version to each running maw
 * process's `/info` endpoint version (#638). MVP covers pm2 only.
 *
 * Returns a list (one per running maw, or a single synthetic entry when
 * pm2/source lookup fails). Drift → ok:false; exit code gating lives in
 * cmdDoctor via the --allow-drift flag.
 */
async function checkVersionDrift(): Promise<DoctorResult["checks"]> {
  const source = readSourceVersion();
  if (!source) {
    return [{ name: "version:source", ok: false, message: "could not read package.json version" }];
  }

  const procs = listPm2MawProcs();
  if (procs === null) {
    return [{ name: "version:pm2", ok: true, message: `pm2 unavailable — source ${source} (no running maw to compare)` }];
  }
  if (procs.length === 0) {
    return [{ name: "version:pm2", ok: true, message: `no running maw — source ${source}` }];
  }

  const results: DoctorResult["checks"] = [];
  for (const p of procs) {
    const port = p.port ?? defaultPort();
    const label = `version:${p.name}${p.pmId != null ? `#${p.pmId}` : ""}`;
    try {
      const running = await fetchInfoVersion(port);
      if (running === null) {
        results.push({ name: label, ok: false, message: `unreachable at :${port} — source ${source}` });
      } else if (running === source) {
        results.push({ name: label, ok: true, message: `aligned (${source}) :${port}` });
      } else {
        results.push({ name: label, ok: false, message: `drift — running ${running}, source ${source} :${port}` });
      }
    } catch (e: any) {
      results.push({ name: label, ok: false, message: `probe failed: ${e?.message || e} :${port}` });
    }
  }
  return results;
}

function readSourceVersion(): string | null {
  // Resolve via Bun's module resolver so we always land on the installed
  // maw-js (sibling repo, linked node_modules, or npm install). The old
  // ../../../../package.json walk assumed this plugin still lived inside
  // maw-js/src/commands/plugins/doctor — extracting it to its own repo
  // pointed the walk at ~/Code/github.com/package.json instead.
  try {
    const pkgPath = Bun.resolveSync("maw-js/package.json", import.meta.dir);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function defaultPort(): number {
  const envPort = Number(process.env.MAW_PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3456;
}

interface Pm2Proc {
  name: string;
  pmId?: number;
  port?: number;
}

function listPm2MawProcs(): Pm2Proc[] | null {
  let raw: string;
  try {
    raw = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return null;
  }
  let procs: any[];
  try {
    procs = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(procs)) return [];
  const out: Pm2Proc[] = [];
  for (const p of procs) {
    if (!p || typeof p.name !== "string") continue;
    if (p.name !== "maw" && !p.name.startsWith("maw-")) continue;
    const env = p.pm2_env?.env || p.pm2_env || {};
    const envPort = Number(env?.MAW_PORT ?? env?.PORT);
    out.push({
      name: p.name,
      pmId: typeof p.pm_id === "number" ? p.pm_id : undefined,
      port: Number.isFinite(envPort) && envPort > 0 ? envPort : undefined,
    });
  }
  return out;
}

/**
 * Peer cache duplicate `<oracle>:<node>` check (#804 Step 3).
 *
 * Loads `~/.maw/peers.json` (or `$PEERS_FILE` in tests) plus the local
 * `(oracle, node)` from config and reports any collisions. This is a
 * read-only check — duplicates surface as a `peers:duplicates` line with
 * `ok:false` so the doctor exits non-zero, but we never auto-prune.
 *
 * Empty cache, missing-identity peers, and zero-collisions all return
 * `ok:true`. Any peer without an `identity` field is silently skipped (legacy
 * peers from pre-Step-3 captures — re-probing them via `maw peers probe`
 * will populate identity and bring them under the dedup umbrella).
 */
function checkPeerDuplicates(): DoctorResult["checks"][number] {
  let peers: Record<string, import("./internal/peers-store").Peer> = {};
  try {
    peers = loadPeers().peers;
  } catch (e: any) {
    return {
      name: "peers:duplicates",
      ok: true,
      message: `peer cache unreadable (${e?.message || e}) — skipping dedup check`,
    };
  }

  let local: { oracle: string; node: string } | undefined;
  try {
    const cfg = loadConfig();
    if (cfg.node) {
      local = { oracle: cfg.oracle ?? "mawjs", node: cfg.node };
    }
  } catch {
    // Config unreadable in this environment — skip the local-vs-cache check
    // but still scan peer-vs-peer collisions below.
  }

  const dups = findDuplicateIdentities(peers, local);
  if (dups.length === 0) {
    const n = Object.keys(peers).length;
    return {
      name: "peers:duplicates",
      ok: true,
      message: n === 0
        ? "no peers cached"
        : `no <oracle>:<node> collisions across ${n} peer${n === 1 ? "" : "s"}`,
    };
  }
  return {
    name: "peers:duplicates",
    ok: false,
    message: dups.map(formatDuplicate).join("; "),
  };
}

/**
 * Cross-source consistency via OracleManifest (Sub-PR 2 of #841).
 *
 * Loads the unified manifest (#838 — fleet, sessions, agents, oracles.json)
 * and runs `findGaps()` over it to surface inconsistencies between the
 * registries. All gaps are warnings, never hard failures: operators
 * legitimately keep registries partly aligned during migrations, so
 * gating exit codes on these would force `--allow-drift` for normal
 * mid-flight states. Surface as `ok:true` with a message body that
 * counts the gaps and breaks them down by kind; the per-gap detail
 * lines are written to console for human inspection.
 *
 * Uses `loadManifestCached()` so this check shares the in-process
 * manifest with any other consumer running in the same `maw doctor`
 * invocation. We invalidate first to avoid serving a stale view if
 * `loadConfig`-touching work happened earlier in the same process.
 */
function checkCrossSourceConsistency(): DoctorResult["checks"][number] {
  let gaps: ReturnType<typeof findGaps>;
  try {
    invalidateManifest();
    const manifest = loadManifestCached();
    gaps = findGaps(manifest);
  } catch (e: any) {
    return {
      name: "manifest:cross-source",
      ok: true,
      message: `manifest unreadable (${e?.message || e}) — skipping cross-source check`,
    };
  }

  const { headline, lines } = summarizeGaps(gaps);
  for (const line of lines) {
    console.log(`    ${C.yellow}⚠${C.reset} ${line}`);
  }
  return {
    name: "manifest:cross-source",
    ok: true,
    message: headline,
  };
}

async function fetchInfoVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/info`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body: any = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function renderResults(checks: DoctorResult["checks"], ok: boolean): void {
  console.log("");
  console.log(`  ${ok ? C.green + "✓" : C.red + "✗"} maw doctor${C.reset}`);
  for (const c of checks) {
    const icon = iconFor(c);
    console.log(`    ${icon} ${c.name}${C.reset}: ${c.message}`);
  }
  console.log("");
}

function renderJsonResults(checks: DoctorResult["checks"], ok: boolean): void {
  console.log(JSON.stringify({
    ok,
    checks: checks.map(c => ({
      name: c.name,
      ok: c.ok,
      message: c.message,
      ...(c.details === undefined ? {} : { details: c.details }),
    })),
  }, null, 2));
}

function iconFor(c: { name: string; ok: boolean; message: string }): string {
  if (c.ok) return C.green + "✓";
  if (c.name.startsWith("version:") && c.message.startsWith("drift")) return C.yellow + "⚠";
  return C.red + "✗";
}

// ─── Smoke tests ────────────────────────────────────────────────────────────

type SmokeCheck = { name: string; ok: boolean; message: string };

async function runSmokeTests(): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const t0 = Date.now();

  checks.push(await smokeCmd("ls", ["ls"]));
  checks.push(await smokeCmd("oracle ls", ["oracle", "ls", "--json"]));
  checks.push(await smokeCmd("oracle search", ["oracle", "search", "maw"]));
  checks.push(await smokeCmd("--version", ["--version"]));
  checks.push(await smokeCmd("fleet ls", ["fleet", "ls"]));
  checks.push(smokePluginCount());
  checks.push(smokeBrokenSymlinks());

  const elapsed = Date.now() - t0;
  const pass = checks.filter(c => c.ok).length;
  console.log(`\n  ${C.gray}${pass}/${checks.length} passed in ${elapsed}ms${C.reset}`);
  return checks;
}

async function smokeCmd(label: string, args: string[]): Promise<SmokeCheck> {
  try {
    const proc = Bun.spawn(["maw", ...args], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, MAW_TEST_MODE: "1" },
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (code === 0) {
      const lines = stdout.trim().split("\n").length;
      return { name: `smoke:${label}`, ok: true, message: `exit 0 (${lines} lines)` };
    }
    const err = (stderr || stdout).trim().split("\n")[0] || `exit ${code}`;
    return { name: `smoke:${label}`, ok: false, message: err };
  } catch (e: any) {
    return { name: `smoke:${label}`, ok: false, message: e?.message || String(e) };
  }
}

function doctorPluginDir(): string {
  return process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
}

function smokePluginCount(): SmokeCheck {
  const { readdirSync, lstatSync } = require("fs");
  const { join } = require("path");
  const dir = doctorPluginDir();
  try {
    const entries = readdirSync(dir) as string[];
    const broken = entries.filter((e: string) => {
      const p = join(dir, e);
      try { return lstatSync(p).isSymbolicLink() && !existsSync(p); } catch { return false; }
    });
    if (broken.length > 0) {
      return { name: "smoke:plugins", ok: false, message: `${broken.length} broken symlink${broken.length === 1 ? "" : "s"} in ${dir}` };
    }
    return { name: "smoke:plugins", ok: true, message: `${entries.length} plugins loaded (0 broken)` };
  } catch (e: any) {
    return { name: "smoke:plugins", ok: false, message: e?.message || String(e) };
  }
}

function smokeBrokenSymlinks(): SmokeCheck {
  const { readdirSync, lstatSync } = require("fs");
  const { join } = require("path");
  const dir = doctorPluginDir();
  try {
    const entries = readdirSync(dir) as string[];
    const broken: string[] = [];
    for (const e of entries) {
      const p = join(dir, e);
      try {
        if (lstatSync(p).isSymbolicLink() && !existsSync(p)) broken.push(e);
      } catch {}
    }
    if (broken.length > 0) {
      return { name: "smoke:symlinks", ok: false, message: `broken: ${broken.slice(0, 5).join(", ")}${broken.length > 5 ? ` (+${broken.length - 5} more)` : ""}` };
    }
    return { name: "smoke:symlinks", ok: true, message: "no broken symlinks" };
  } catch (e: any) {
    return { name: "smoke:symlinks", ok: false, message: e?.message || String(e) };
  }
}
