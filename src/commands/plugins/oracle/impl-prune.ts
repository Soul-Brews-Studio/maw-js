/**
 * maw oracle prune — dry-run by default; retires stale/orphan entries from
 * the oracle registry (oracles.json).
 *
 * Decision criteria (without --stale):
 *   Candidate = no positive signals: empty lineage AND no tmux AND no federation
 *
 * With --stale:
 *   Candidate = STALE or DEAD tier from the alpha.112 classifier (#392)
 *
 * Safety: --force is required to retire entries. Default is always dry-run.
 * "Nothing is Deleted" — retired entries move to retired[] in registry JSON,
 * not deleted. The entry is preserved with a retired_at timestamp.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, listSessions } from "../../../sdk";
import { runStaleScan, type StaleEntry } from "./impl-stale";
import type { OracleEntry } from "../../../sdk";
import { createInterface } from "readline";

const CACHE_FILE = join(CONFIG_DIR, "oracles.json");

export interface PruneOpts {
  stale?: boolean;
  force?: boolean;
  json?: boolean;
}

export interface PruneCandidate {
  entry: OracleEntry;
  reasons: string[];
  tier?: string;
}

export interface RetiredEntry extends OracleEntry {
  retired_at: string;
  retired_reasons: string[];
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function emptyLineage(e: OracleEntry): boolean {
  return !e.has_psi && !e.has_fleet_config && !e.budded_from;
}

export function buildPruneCandidates(
  entries: OracleEntry[],
  awakeSet: Set<string>,
): PruneCandidate[] {
  return entries
    .map((entry) => {
      const awake = awakeSet.has(entry.name);
      const reasons: string[] = [];
      if (emptyLineage(entry)) reasons.push("empty lineage");
      if (!entry.local_path) reasons.push("not cloned");
      if (!awake) reasons.push("no tmux");
      if (!entry.federation_node) reasons.push("no federation");
      // Candidate only if all positive signals are absent
      const isCandidate = emptyLineage(entry) && !awake && !entry.federation_node;
      return isCandidate ? { entry, reasons } : null;
    })
    .filter((x): x is PruneCandidate => x !== null);
}

export function buildStaleCandidates(staleEntries: StaleEntry[]): PruneCandidate[] {
  return staleEntries
    .filter((e) => e.tier === "STALE" || e.tier === "DEAD")
    .map((e) => ({
      entry: {
        org: e.org,
        repo: e.repo,
        name: e.name,
        local_path: e.local_path,
        has_psi: e.has_psi,
        has_fleet_config: false,
        budded_from: null,
        budded_at: null,
        federation_node: null,
        detected_at: "",
      } as OracleEntry,
      reasons: [
        e.tier === "DEAD" ? "DEAD (>90d)" : "STALE (30-90d)",
        e.recommendation,
        ...(!e.awake ? ["no tmux"] : []),
      ],
      tier: e.tier,
    }));
}

// ─── Raw registry I/O ─────────────────────────────────────────────────────────

function readRaw(file: string): Record<string, unknown> {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch { /* fall through */ }
  return {};
}

function writeRaw(file: string, data: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export async function runPrune(
  opts: PruneOpts = {},
  deps: {
    readEntries?: () => OracleEntry[];
    listAwake?: () => Promise<Set<string>>;
    runStale?: typeof runStaleScan;
    promptConfirm?: (msg: string) => Promise<boolean>;
    readRawCache?: () => Record<string, unknown>;
    writeRawCache?: (data: Record<string, unknown>) => void;
    now?: () => Date;
  } = {},
): Promise<PruneCandidate[]> {
  const readRawCache = deps.readRawCache ?? (() => readRaw(CACHE_FILE));
  const writeRawCache = deps.writeRawCache ?? ((data) => writeRaw(CACHE_FILE, data));

  const rawCache = readRawCache();
  const entries: OracleEntry[] = (rawCache.oracles as OracleEntry[] | undefined) ?? [];

  let candidates: PruneCandidate[];

  if (opts.stale) {
    const staleRun = deps.runStale ?? runStaleScan;
    const staleEntries = await staleRun({ all: false }, {
      readEntries: deps.readEntries ? () => deps.readEntries!() : undefined,
      listAwake: deps.listAwake,
      now: deps.now,
    });
    candidates = buildStaleCandidates(staleEntries);
  } else {
    const listAwake = deps.listAwake ?? (async () => {
      const sessions = await listSessions().catch(() => []);
      const awake = new Set<string>();
      for (const s of sessions) {
        for (const w of s.windows) {
          if (w.name.endsWith("-oracle")) awake.add(w.name.replace(/-oracle$/, ""));
        }
      }
      return awake;
    });
    const awakeSet = await listAwake();
    candidates = buildPruneCandidates(entries, awakeSet);
  }

  return candidates;
}

export async function cmdOraclePrune(
  opts: PruneOpts = {},
  deps: {
    readEntries?: () => OracleEntry[];
    listAwake?: () => Promise<Set<string>>;
    runStale?: typeof runStaleScan;
    promptConfirm?: (msg: string) => Promise<boolean>;
    readRawCache?: () => Record<string, unknown>;
    writeRawCache?: (data: Record<string, unknown>) => void;
    now?: () => Date;
  } = {},
): Promise<void> {
  const readRawCache = deps.readRawCache ?? (() => readRaw(CACHE_FILE));
  const writeRawCache = deps.writeRawCache ?? ((data) => writeRaw(CACHE_FILE, data));

  const candidates = await runPrune(opts, deps);

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, count: candidates.length, dry_run: !opts.force, candidates }, null, 2));
    return;
  }

  if (candidates.length === 0) {
    console.log(`\n  \x1b[32m✓\x1b[0m No prune candidates — registry is clean.\n`);
    return;
  }

  const dryTag = opts.force ? "" : "  \x1b[90m[dry-run — use --force to retire]\x1b[0m";
  console.log(`\n  \x1b[36mPrune candidates\x1b[0m (${candidates.length})${dryTag}\n`);

  for (const c of candidates) {
    const tier = c.tier ? `\x1b[${c.tier === "DEAD" ? 31 : 33}m${c.tier.padEnd(6)}\x1b[0m` : "      ";
    const why = c.reasons.join(", ");
    console.log(`  ${tier}  ${c.entry.name.padEnd(24)} \x1b[90m${why}\x1b[0m`);
  }

  if (!opts.force) {
    console.log(`\n  Run with \x1b[36m--force\x1b[0m to retire these entries (moves to retired[] — reversible).\n`);
    return;
  }

  // --force: prompt for confirmation, then retire
  const promptConfirm = deps.promptConfirm ?? defaultPromptConfirm;
  const confirmed = await promptConfirm(
    `\n  Retire ${candidates.length} oracle(s)? This moves them to retired[] in the registry (reversible).`,
  );

  if (!confirmed) {
    console.log(`  \x1b[33mAborted.\x1b[0m\n`);
    return;
  }

  const retiredNames = new Set(candidates.map((c) => c.entry.name));
  const rawCache = readRawCache();
  const oracles: OracleEntry[] = (rawCache.oracles as OracleEntry[] | undefined) ?? [];
  const existingRetired: RetiredEntry[] = (rawCache.retired as RetiredEntry[] | undefined) ?? [];
  const now = new Date().toISOString();

  const toRetire: RetiredEntry[] = candidates.map((c) => ({
    ...c.entry,
    retired_at: now,
    retired_reasons: c.reasons,
  }));

  rawCache.oracles = oracles.filter((e) => !retiredNames.has(e.name));
  rawCache.retired = [...existingRetired, ...toRetire];

  writeRawCache(rawCache);

  console.log(`\n  \x1b[32m✓\x1b[0m Retired ${toRetire.length} oracle(s) → retired[] in registry.\n`);
  for (const r of toRetire) {
    console.log(`    \x1b[90m→ ${r.name}\x1b[0m`);
  }
  console.log();
}

async function defaultPromptConfirm(msg: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${msg} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}
