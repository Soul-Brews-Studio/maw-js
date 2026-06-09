import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statfsSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { loadPeers } from "./internal/peers-store";
import { findDuplicateIdentities, formatDuplicate } from "./internal/duplicate-detect";
import {
  C,
  invalidateManifest,
  isMawXdgEnabled,
  legacyMawPath,
  loadConfig,
  loadManifestCached,
  mawCacheDir,
  mawConfigDir,
  mawDataDir,
  mawDataPath,
  mawStateDir,
  mawStatePath,
} from "maw-js/sdk";
import { findGaps, summarizeGaps } from "./cross-source-detect";
import { checkMawJsBranch } from "./internal/maw-js-branch-check";
import { checkStillbornWorktrees } from "./internal/stillborn-worktrees";
import { checkStalePeers, cmdFixStalePeers } from "./internal/stale-peers";
import { detectBunLinkedCheckout } from "./internal/bun-link-detect";
import { fixDoubledGithubSessions } from "./internal/fix-sessions";

export type DoctorSeverity = "info" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  details?: unknown;
  severity?: DoctorSeverity;
  fix?: string[];
}

export interface DoctorComparison {
  name: string;
  before: string;
  after: string;
  status: "fixed" | "regressed" | "changed" | "unchanged";
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  comparison?: DoctorComparison[];
}

export async function cmdDoctor(args: string[] = []): Promise<DoctorResult> {
  const parsed = parseDoctorArgs(args);
  const flags = parsed.flags;
  const positional = parsed.positional;
  const only = positional[0];
  const json = flags.has("--json");
  const capture = flags.has("--capture");
  const noPrompt = flags.has("--no-prompt") || Boolean(process.env.MAW_TEST_MODE);
  const forwardTarget = parsed.values["--forward"];
  const allowDrift = flags.has("--allow-drift");
  const smoke = flags.has("--smoke") || only === "smoke";
  const xdgMigrate = flags.has("--migrate") || flags.has("--fix-xdg");
  const xdgDryRun = flags.has("--dry-run") || flags.has("--plan");
  const checks: DoctorResult["checks"] = [];
  const previous = loadLastDoctorRun();
  const pipedInput = await readPipedDoctorInput();
  const captured = capture ? captureTmuxPane(30) : undefined;

  // #1238 — `maw doctor --fix-stale` short-circuits the normal check
  // suite: this is a destructive sweep, not a diagnostic. Returns the
  // fix result directly so index.ts surfaces it unchanged.
  if (flags.has("--fix-stale")) {
    return await cmdFixStalePeers();
  }

  if (flags.has("--fix-sessions")) {
    const result = await fixDoubledGithubSessions({ dryRun: flags.has("--dry-run") || flags.has("--plan") });
    if (json) renderFixSessionsJson(result);
    else renderFixSessionsResult(result);
    return { ok: result.ok, checks: result.checks };
  }

  const renderLog = console.log;
  if (json) console.log = () => {};

  if (pipedInput) {
    checks.push(diagnosePipedInput(pipedInput, captured));
  } else if (smoke) {
    const smokeChecks = await runSmokeTests();
    for (const c of smokeChecks) checks.push(c);
  } else {
    if (!only || only === "serve") {
      checks.push(await checkServeHealth());
    }
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
    if (!only || only === "plugins") {
      checks.push(checkPluginHealth());
    }
    if (!only || only === "peers" || only === "all") {
      checks.push(checkPeerDuplicates());
      checks.push(checkStalePeers());
    }
    if (!only || only === "hub") {
      checks.push(checkHubWorkspaceConfig());
    }
    if (!only || only === "scout") {
      checks.push(checkScoutStatus());
    }
    if (!only || only === "federation") {
      checks.push(checkFederationReachability());
    }
    if (!only || only === "disk") {
      checks.push(checkDiskSpace());
    }
    if (!only || only === "manifest" || only === "all") {
      checks.push(checkCrossSourceConsistency({ silent: json }));
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
  const comparison = compareDoctorRuns(previous, checks);
  persistDoctorRun(checks);
  if (json) console.log = renderLog;
  const interactivePrompt = !json && !noPrompt && !forwardTarget && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const forwardResult = await maybeForwardDoctorReport({ checks, comparison, captured, explicitTarget: forwardTarget, prompt: interactivePrompt });
  if (forwardResult) checks.push(forwardResult);
  if (json) renderJsonResults(checks, ok, comparison);
  else renderResults(checks, ok, comparison);
  return { ok, checks, comparison };
}


function renderFixSessionsResult(result: Awaited<ReturnType<typeof fixDoubledGithubSessions>>): void {
  console.log("");
  console.log(`  ${result.ok ? C.green + "✓" : C.red + "✗"} maw doctor --fix-sessions${C.reset}`);
  console.log(`    ${result.dryRun ? "dry-run" : "applied"}: ${result.pairs.length} doubled github.com/github.com dir${result.pairs.length === 1 ? "" : "s"}`);
  console.log(`    ${C.gray}quarantine: ${result.quarantineRoot}${C.reset}`);
  for (const pair of result.pairs) {
    const status = pair.outcome === "error" ? C.red + "✗" : pair.outcome === "done" ? C.green + "✓" : C.yellow + "•";
    console.log(`    ${status}${C.reset} ${pair.action} sessions=${pair.sessionCount} canonical=${pair.canonicalExists ? "yes" : "missing"}`);
    console.log(`       doubled:   ${pair.doubled}`);
    console.log(`       canonical: ${pair.canonical}`);
    console.log(`       cleanup:   mv ${shellQuote(pair.doubled)} ${shellQuote(pair.cleanupTarget)}`);
    for (const message of pair.messages) console.log(`       ${C.gray}${message}${C.reset}`);
  }
  if (result.dryRun) console.log(`    ${C.gray}rerun without --dry-run to remap sessions and quarantine doubled dirs with mv${C.reset}`);
  console.log("");
}

function renderFixSessionsJson(result: Awaited<ReturnType<typeof fixDoubledGithubSessions>>): void {
  console.log(JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    quarantineRoot: result.quarantineRoot,
    pairs: result.pairs,
    checks: result.checks.map(c => ({
      name: c.name,
      ok: c.ok,
      severity: severityFor(c),
      message: c.message,
      ...(c.details === undefined ? {} : { details: c.details }),
    })),
  }, null, 2));
}

function parseDoctorArgs(args: string[]): { flags: Set<string>; values: Record<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--forward") {
      flags.add(arg);
      values[arg] = args[++i] || "doctor";
    } else if (arg.startsWith("--forward=")) {
      flags.add("--forward");
      values["--forward"] = arg.slice("--forward=".length) || "doctor";
    } else if (arg.startsWith("--")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  return { flags, values, positional };
}

async function readPipedDoctorInput(): Promise<string | undefined> {
  if (process.env.MAW_TEST_MODE || process.env.NODE_ENV === "test" || process.env.BUN_TEST || process.argv.join(" ").includes("bun test")) return undefined;
  if (process.stdin.isTTY !== false) return undefined;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 25)),
    ]);
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function diagnosePipedInput(input: string, captured?: string): DoctorCheck {
  const first = input.split(/\r?\n/).find((line) => line.trim())?.trim() || "stdin error report";
  return {
    name: "diagnose:error",
    ok: false,
    severity: "error",
    message: first.length > 120 ? `${first.slice(0, 117)}…` : first,
    fix: ["maw doctor --forward doctor --capture"],
    details: { stdin: input, captured },
  };
}

function captureTmuxPane(lines = 30): string | undefined {
  try {
    return execSync(`tmux capture-pane -p -S -${Math.max(1, Math.floor(lines))}`, { encoding: "utf-8" }).trimEnd();
  } catch {
    return undefined;
  }
}

async function maybeForwardDoctorReport(opts: {
  checks: DoctorCheck[];
  comparison: DoctorComparison[];
  captured?: string;
  explicitTarget?: string;
  prompt: boolean;
}): Promise<DoctorCheck | undefined> {
  const issues = opts.checks.filter((check) => !check.ok);
  if (issues.length === 0 && !opts.explicitTarget) return undefined;
  let target = opts.explicitTarget;
  if (!target && opts.prompt) {
    const answer = (globalThis as any).prompt?.("Forward doctor report? [Y/n] ");
    if (String(answer ?? "y").trim().toLowerCase().startsWith("n")) return undefined;
    target = doctorForwardTarget();
  }
  if (!target) return undefined;
  const message = formatForwardMessage(opts.checks, opts.comparison, opts.captured ?? captureTmuxPane(30));
  try {
    const proc = Bun.spawn(["maw", "hey", target, message], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code === 0) return { name: "forward", ok: true, severity: "info", message: `forwarded doctor report to ${target}` };
    const stderr = await new Response(proc.stderr).text();
    return { name: "forward", ok: false, severity: "warn", message: `forward failed: ${stderr.trim() || `exit ${code}`}`, fix: [`maw hey ${target} '<doctor report>'`] };
  } catch (e: any) {
    return { name: "forward", ok: false, severity: "warn", message: `forward failed: ${e?.message || e}`, fix: [`maw hey ${target} '<doctor report>'`] };
  }
}

function doctorForwardTarget(): string {
  try {
    const cfg: any = loadConfig();
    return cfg?.errorForward?.target || "doctor";
  } catch {
    return "doctor";
  }
}

function formatForwardMessage(checks: DoctorCheck[], comparison: DoctorComparison[], captured?: string): string {
  const issues = checks.filter((check) => !check.ok);
  const lines = [
    `maw doctor report: ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    ...issues.map((check) => `- ${check.name}: ${check.message}`),
  ];
  const changed = comparison.filter((item) => item.status !== "unchanged").slice(0, 6);
  if (changed.length) lines.push("changes:", ...changed.map((item) => `- ${item.name}: ${item.before} -> ${item.after} (${item.status})`));
  if (captured) lines.push("capture:", captured.split(/\r?\n/).slice(-30).join("\n"));
  return lines.join("\n");
}

async function checkServeHealth(): Promise<DoctorCheck> {
  const port = defaultPort();
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) {
      return { name: "serve", ok: false, severity: "warn", message: `health endpoint returned HTTP ${res.status} on :${port}`, fix: ["maw serve"] };
    }
    let version = "";
    try {
      const info = await fetch(`http://localhost:${port}/info`, { signal: AbortSignal.timeout(700) });
      if (info.ok) {
        const body: any = await info.json();
        if (typeof body?.version === "string") version = ` (${body.version})`;
      }
    } catch { /* best-effort */ }
    return { name: "serve", ok: true, severity: "info", message: `running${version} on :${port}` };
  } catch {
    return { name: "serve", ok: false, severity: "warn", message: `not reachable on :${port}`, fix: ["maw serve"] };
  }
}

function checkPluginHealth(): DoctorCheck {
  const dir = doctorPluginDir();
  try {
    const entries = readdirSync(dir);
    const broken = entries.filter((entry) => {
      const path = join(dir, entry);
      try { return lstatSync(path).isSymbolicLink() && !existsSync(path); } catch { return false; }
    });
    return {
      name: "plugins",
      ok: broken.length === 0,
      severity: broken.length === 0 ? "info" : "warn",
      message: `${entries.length} loaded (0 shadows, ${broken.length} errors)`,
      ...(broken.length ? { fix: ["maw plugin ls --errors"] } : {}),
      details: { dir, broken },
    };
  } catch (e: any) {
    return { name: "plugins", ok: false, severity: "warn", message: `plugin dir unreadable: ${e?.message || e}`, fix: ["maw plugin ls --errors"] };
  }
}

function checkHubWorkspaceConfig(): DoctorCheck {
  const dir = mawDataPath("workspaces");
  const placeholders: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      const text = readFileSync(path, "utf-8");
      if (/hub\.example\.test|example\.com|placeholder|localhost:0/i.test(text)) placeholders.push(path);
    }
  } catch {
    return { name: "hub", ok: true, severity: "info", message: "no workspace config or unreadable workspace dir — skipped" };
  }
  if (placeholders.length === 0) return { name: "hub", ok: true, severity: "info", message: "workspace configs do not point to placeholder URLs" };
  return {
    name: "hub",
    ok: false,
    severity: "warn",
    message: `${placeholders.length} workspace config${placeholders.length === 1 ? "" : "s"} point to placeholder URLs`,
    fix: placeholders.map((path) => `rm ${shellQuote(path)}`),
    details: { placeholders },
  };
}

function checkScoutStatus(): DoctorCheck {
  return { name: "scout", ok: true, severity: "info", message: "multicast listener not probed in local doctor mode (expected 224.0.0.224:31746)" };
}

function checkFederationReachability(): DoctorCheck {
  let count = 0;
  try { count = Object.keys(loadPeers().peers).length; } catch { /* ignore */ }
  return { name: "federation", ok: true, severity: "info", message: count === 0 ? "no cached peers to ping" : `${count}/${count} cached peer${count === 1 ? "" : "s"} assumed reachable (active ping deferred)`, fix: ["maw peers list"] };
}

function checkDiskSpace(): DoctorCheck {
  try {
    mkdirSync(mawStateDir(), { recursive: true });
    const stats = statfsSync(mawStateDir());
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGiB = freeBytes / (1024 ** 3);
    const ok = freeBytes >= 1024 ** 3;
    return {
      name: "disk",
      ok,
      severity: ok ? "info" : "warn",
      message: `${freeGiB.toFixed(1)} GiB free at ${mawStateDir()}`,
      ...(ok ? {} : { fix: [`du -sh ${shellQuote(mawStateDir())}/* | sort -h`] }),
      details: { path: mawStateDir(), freeBytes },
    };
  } catch (e: any) {
    return { name: "disk", ok: true, severity: "info", message: `disk space unavailable (${e?.message || e}) — skipped` };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
function checkCrossSourceConsistency(opts: { silent?: boolean } = {}): DoctorResult["checks"][number] {
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
  if (!opts.silent) {
    for (const line of lines) {
      console.log(`    ${C.yellow}⚠${C.reset} ${line}`);
    }
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

interface DoctorSnapshot {
  timestamp: string;
  checks: Record<string, string>;
}

function doctorLastPath(): string {
  return mawStatePath("doctor-last.json");
}

function checkStatus(check: DoctorCheck): string {
  return check.ok ? "ok" : (severityFor(check) === "error" ? "error" : "issue");
}

function loadLastDoctorRun(): DoctorSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(doctorLastPath(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || !parsed.checks || typeof parsed.checks !== "object") return null;
    return { timestamp: String(parsed.timestamp || ""), checks: parsed.checks as Record<string, string> };
  } catch {
    return null;
  }
}

function persistDoctorRun(checks: DoctorCheck[]): void {
  try {
    mkdirSync(dirname(doctorLastPath()), { recursive: true });
    const snapshot: DoctorSnapshot = {
      timestamp: new Date().toISOString(),
      checks: Object.fromEntries(checks.map((check) => [check.name, checkStatus(check)])),
    };
    writeFileSync(doctorLastPath(), `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    // Doctor should report health, not fail because state persistence is blocked.
  }
}

function compareDoctorRuns(previous: DoctorSnapshot | null, checks: DoctorCheck[]): DoctorComparison[] {
  if (!previous) return [];
  const current = Object.fromEntries(checks.map((check) => [check.name, checkStatus(check)]));
  const names = [...new Set([...Object.keys(previous.checks), ...Object.keys(current)])].sort();
  return names.map((name) => {
    const before = previous.checks[name] ?? "missing";
    const after = current[name] ?? "missing";
    let status: DoctorComparison["status"] = before === after ? "unchanged" : "changed";
    if (before !== "ok" && after === "ok") status = "fixed";
    else if (before === "ok" && after !== "ok") status = "regressed";
    return { name, before, after, status };
  });
}

function severityFor(check: DoctorCheck): DoctorSeverity {
  if (check.severity) return check.severity;
  if (check.ok) return "info";
  if (check.name.startsWith("version:") && check.message.startsWith("drift")) return "warn";
  return "error";
}

function iconForSeverity(severity: DoctorSeverity): string {
  if (severity === "info") return C.green + "✓";
  if (severity === "warn") return C.yellow + "⚠";
  return C.red + "✗";
}

function fixesFor(check: DoctorCheck): string[] {
  if (check.fix?.length) return check.fix;
  if (check.ok) return [];
  if (check.name === "install") return ["bun add -g github:Soul-Brews-Studio/maw-js"];
  if (check.name === "peers:duplicates") return ["maw peers list"];
  if (check.name === "peers:stale") return ["maw doctor --fix-stale"];
  if (check.name === "worktrees:stillborn") return ["maw done <name>"];
  if (check.name.startsWith("version:")) return ["maw serve restart"];
  return [];
}

function issueCount(checks: DoctorCheck[]): number {
  return checks.filter((check) => !check.ok || severityFor(check) === "warn").length;
}

function renderResults(checks: DoctorResult["checks"], ok: boolean, comparison: DoctorComparison[] = []): void {
  console.log("");
  console.log(`  ${ok ? C.green + "✓" : C.red + "✗"} maw doctor${C.reset}`);
  for (const c of checks) {
    const severity = severityFor(c);
    const icon = iconForSeverity(severity);
    console.log(`    ${icon} ${c.name}${C.reset}: ${c.message}`);
    for (const fix of fixesFor(c)) console.log(`       ${C.gray}→ ${fix}${C.reset}`);
  }
  if (comparison.length > 0) {
    console.log("");
    console.log(`  ${C.gray}─── Before / After (since last doctor run) ───${C.reset}`);
    for (const item of comparison.filter((entry) => entry.status !== "unchanged").slice(0, 12)) {
      const icon = item.status === "fixed" ? C.green + "✓" : item.status === "regressed" ? C.red + "✗" : C.yellow + "↔";
      console.log(`    ${item.name}: ${item.before} → ${item.after} ${icon}${C.reset}`);
    }
  }
  const remaining = issueCount(checks);
  if (remaining > 0) {
    console.log("");
    console.log(`  ${remaining} issue${remaining === 1 ? "" : "s"} remaining. Run suggested commands above to resolve.`);
  }
  console.log("");
}

function renderJsonResults(checks: DoctorResult["checks"], ok: boolean, comparison: DoctorComparison[] = []): void {
  console.log(JSON.stringify({
    ok,
    checks: checks.map(c => ({
      name: c.name,
      ok: c.ok,
      severity: severityFor(c),
      message: c.message,
      fix: fixesFor(c),
      ...(c.details === undefined ? {} : { details: c.details }),
    })),
    comparison,
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
