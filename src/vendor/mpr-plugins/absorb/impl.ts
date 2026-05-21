import { existsSync } from "fs";
import { join } from "path";
import { FLEET_DIR, hostExec } from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { loadFleetEntries, type FleetEntry } from "maw-js/commands/shared/fleet-load";
import { cmdArchive } from "../archive/impl";
import { resolveOraclePath } from "../soul-sync/resolve";
import { syncOracleVaults } from "../soul-sync/sync-helpers";

export interface AbsorbOptions {
  dryRun?: boolean;
}

function stripSessionPrefix(name: string) {
  return name.replace(/^\d+-/, "");
}

function stripOracleSuffix(name: string) {
  return name.replace(/-oracle$/, "");
}

function normalizeName(name: string) {
  return stripOracleSuffix(stripSessionPrefix(name)).toLowerCase();
}

function repoName(repoSlug: string | undefined) {
  return (repoSlug || "").split("/").filter(Boolean).pop() || "";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function entryNames(entry: FleetEntry): string[] {
  const sessionName = stripSessionPrefix(entry.session.name);
  const groupName = stripSessionPrefix(entry.groupName);
  const windowNames = entry.session.windows.flatMap(win => [win.name, repoName(win.repo)]);
  return [entry.session.name, sessionName, groupName, ...windowNames].filter(Boolean);
}

export function findAbsorbFleetEntry(entries: FleetEntry[], query: string): FleetEntry | undefined {
  const raw = query.toLowerCase();
  const normalized = normalizeName(query);
  return entries.find(entry => entryNames(entry).some(name => {
    const candidate = name.toLowerCase();
    return candidate === raw || normalizeName(name) === normalized;
  }));
}

async function resolveEntryPath(entry: FleetEntry, displayName: string): Promise<string | null> {
  const resolved = await resolveOraclePath(displayName);
  if (resolved) return resolved;

  const repo = entry.session.windows[0]?.repo;
  if (!repo) return null;

  const fallback = join(getGhqRoot(), "github.com", repo);
  return existsSync(fallback) ? fallback : null;
}

function formatSyncSummary(synced: Record<string, number>) {
  return Object.entries(synced).map(([dir, count]) => `${count} ${dir.split("/").pop()}`).join(", ");
}

async function switchToReceiver(sessionName: string, opts: AbsorbOptions) {
  const command = `tmux switch-client -t ${shellQuote(sessionName)}`;
  if (opts.dryRun) {
    console.log(`  [dry-run] would switch client: ${command}`);
    return;
  }

  if (!process.env.TMUX) {
    console.log(`  [info] not inside tmux; run manually: ${command}`);
    return;
  }

  try {
    await hostExec(command);
    console.log(`  [ok] switched client to ${sessionName}`);
  } catch (e: any) {
    console.log(`  [warn] could not switch to receiver: ${e.message || e}`);
    console.log(`  [hint] run manually: ${command}`);
  }
}

/**
 * maw absorb <donor> --into <receiver>
 *
 * Lifecycle wrap:
 *   1. Copy new donor psi memory into the receiver using the soul-sync primitive.
 *   2. Archive the donor using the existing archive primitive.
 *   3. Switch the active tmux client to the receiver session.
 */
export async function cmdAbsorb(donor: string, receiver: string, opts: AbsorbOptions = {}) {
  const entries = loadFleetEntries();
  const donorEntry = findAbsorbFleetEntry(entries, donor);
  if (!donorEntry) throw new Error(`donor oracle '${donor}' not found in fleet config`);

  const receiverEntry = findAbsorbFleetEntry(entries, receiver);
  if (!receiverEntry) throw new Error(`receiver oracle '${receiver}' not found in fleet config`);

  const donorName = stripSessionPrefix(donorEntry.session.name);
  const receiverName = stripSessionPrefix(receiverEntry.session.name);
  const receiverSession = receiverEntry.session.name;

  if (donorEntry.file === receiverEntry.file || normalizeName(donorName) === normalizeName(receiverName)) {
    throw new Error("donor and receiver must be different oracles");
  }

  const donorPath = await resolveEntryPath(donorEntry, donorName);
  if (!donorPath) throw new Error(`could not resolve donor oracle path for '${donorName}'`);

  const receiverPath = await resolveEntryPath(receiverEntry, receiverName);
  if (!receiverPath) throw new Error(`could not resolve receiver oracle path for '${receiverName}'`);

  console.log(`\n  Absorbing ${donorName} -> ${receiverName}\n`);

  if (opts.dryRun) {
    console.log(`  [dry-run] would sync psi memory: ${donorPath} -> ${receiverPath}`);
    console.log(`  [dry-run] would archive donor via: maw archive ${donorName}`);
  } else {
    const result = syncOracleVaults(donorPath, receiverPath, donorName, receiverName);
    if (result.total === 0) {
      console.log(`  [ok] psi memory sync complete: nothing new`);
    } else {
      console.log(`  [ok] psi memory sync complete: ${formatSyncSummary(result.synced)}`);
    }

    await cmdArchive(donorName, { dryRun: false });
  }

  await switchToReceiver(receiverSession, opts);

  if (opts.dryRun) {
    console.log(`\n  [dry-run] absorb preview complete; no files, fleet entries, repos, or tmux clients changed.\n`);
  } else {
    const disabledFile = join(FLEET_DIR, `${donorEntry.file}.disabled`);
    const archived = existsSync(disabledFile) ? "archived" : "archive attempted";
    console.log(`\n  ${donorName} absorbed into ${receiverName}; donor ${archived}.\n`);
  }
}
