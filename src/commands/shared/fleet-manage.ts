import { dirname, join } from "path";
import { existsSync, renameSync, unlinkSync, readdirSync } from "fs";
import { tmux } from "../../sdk";
import { countDisabledFleetFiles, fleetDirForWrite, loadFleetEntries, getSessionNames, type FleetEntry } from "./fleet-load";
import { UserError } from "../../core/util/user-error";

export interface FleetManageDeps {
  loadFleetEntries: typeof loadFleetEntries;
  getSessionNames: typeof getSessionNames;
  countDisabledFleetFiles: typeof countDisabledFleetFiles;
  readdirSync: typeof readdirSync;
  fleetDir: string;
  writeFile: (path: string, contents: string) => Promise<unknown>;
  renameSync: typeof renameSync;
  existsSync: typeof existsSync;
  unlinkSync: typeof unlinkSync;
  join: typeof join;
  tmuxRun: (...args: string[]) => Promise<string>;
  log: (...args: unknown[]) => void;
}

export interface FleetRenameOptions {
  oldName: string;
  newName: string;
  dryRun?: boolean;
  force?: boolean;
}

function stripJson(name: string): string {
  return name.replace(/\.json$/i, "");
}

function stripNumberPrefix(name: string): string {
  return stripJson(name).replace(/^\d+-/, "");
}

function validateFleetRenameName(label: string, name: string): void {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new UserError(`invalid ${label}: ${JSON.stringify(name)}`);
  }
}

function peerAliases(name: string): Set<string> {
  const clean = stripJson(name);
  const stem = stripNumberPrefix(clean);
  return new Set([clean, stem]);
}

function migrateFleetRefs<T extends { sync_peers?: string[]; budded_from?: string }>(
  session: T,
  aliases: Set<string>,
  newName: string,
): { session: T; changed: boolean } {
  let changed = false;
  const next: T = { ...session };
  if (Array.isArray(session.sync_peers)) {
    const originalPeers = session.sync_peers;
    const syncPeers = originalPeers.map(peer => aliases.has(peer) ? newName : peer);
    changed = changed || syncPeers.some((peer, index) => peer !== originalPeers[index]);
    next.sync_peers = syncPeers;
  }
  if (typeof session.budded_from === "string" && aliases.has(session.budded_from)) {
    next.budded_from = newName;
    changed = true;
  }
  return { session: next, changed };
}

function entryPath(io: FleetManageDeps, entry: FleetEntry): string {
  return entry.path ?? io.join(io.fleetDir, entry.file);
}

function entryDir(io: FleetManageDeps, entry: FleetEntry): string {
  return dirname(entryPath(io, entry));
}

export function fleetManageDeps(overrides: Partial<FleetManageDeps> = {}): FleetManageDeps {
  return {
    loadFleetEntries,
    getSessionNames,
    countDisabledFleetFiles,
    readdirSync,
    fleetDir: fleetDirForWrite(),
    writeFile: Bun.write.bind(Bun) as (path: string, contents: string) => Promise<unknown>,
    renameSync,
    existsSync,
    unlinkSync,
    join,
    tmuxRun: tmux.run.bind(tmux) as (...args: string[]) => Promise<string>,
    log: console.log.bind(console) as (...args: unknown[]) => void,
    ...overrides,
  };
}

function displaySessionName(entry: FleetEntry): string {
  const session = entry.session as unknown as { name?: unknown } | null | undefined;
  return typeof session?.name === "string" && session.name.length > 0
    ? session.name
    : entry.groupName || entry.file.replace(/\.json$/, "") || "(unnamed)";
}

function displayWindowCount(entry: FleetEntry): number {
  const session = entry.session as unknown as { windows?: unknown } | null | undefined;
  return Array.isArray(session?.windows) ? session.windows.length : 0;
}

function isMalformedEntry(entry: FleetEntry): boolean {
  const session = entry.session as unknown as { name?: unknown; windows?: unknown } | null | undefined;
  return typeof session?.name !== "string" || session.name.length === 0 || !Array.isArray(session?.windows);
}

export function renderFleetLs(entries: FleetEntry[], disabled: number, runningSessions: string[]): string[] {
  // Detect conflicts (duplicate numbers or duplicate fleet names)
  const numCount = new Map<number, string[]>();
  const groupCount = new Map<string, string[]>();
  for (const e of entries) {
    const numList = numCount.get(e.num) || [];
    numList.push(e.groupName);
    numCount.set(e.num, numList);

    const groupList = groupCount.get(e.groupName) || [];
    groupList.push(e.file);
    groupCount.set(e.groupName, groupList);
  }

  const numberConflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);
  const nameConflicts = [...groupCount.entries()].filter(([, files]) => files.length > 1);
  const conflictCount = numberConflicts.length + nameConflicts.length;
  const lines: string[] = [];

  lines.push(`\n  \x1b[36mFleet Configs\x1b[0m (${entries.length} active, ${disabled} disabled)\n`);
  lines.push(`  ${"#".padEnd(4)} ${"Session".padEnd(20)} ${"Win".padEnd(5)} Status`);
  lines.push(`  ${"─".repeat(4)} ${"─".repeat(20)} ${"─".repeat(5)} ${"─".repeat(20)}`);

  for (const e of entries) {
    const numStr = String(e.num).padStart(2, "0");
    const sessionName = displaySessionName(e);
    const name = sessionName.padEnd(20);
    const wins = String(displayWindowCount(e)).padEnd(5);
    const isRunning = runningSessions.includes(sessionName);
    const isConflict = (numCount.get(e.num)?.length ?? 0) > 1 || (groupCount.get(e.groupName)?.length ?? 0) > 1;

    let status = isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[90mstopped\x1b[0m";
    if (isConflict) status += "  \x1b[31mCONFLICT\x1b[0m";
    if (isMalformedEntry(e)) status += "  \x1b[33mINVALID\x1b[0m";

    lines.push(`  ${numStr}  ${name} ${wins} ${status}`);
  }

  if (conflictCount > 0) {
    const numberHint = numberConflicts.length > 0 ? `Run \x1b[36mmaw fleet renumber\x1b[0m for duplicate numbers.` : "";
    const nameHint = nameConflicts.length > 0 ? "Rename or remove duplicate fleet names first." : "";
    lines.push(`\n  \x1b[31m⚠ ${conflictCount} conflict(s) found.\x1b[0m ${[numberHint, nameHint].filter(Boolean).join(" ")}`);
  }
  lines.push("");
  return lines;
}

export async function cmdFleetLs(deps: Partial<FleetManageDeps> = {}) {
  const io = fleetManageDeps(deps);
  const entries = io.loadFleetEntries();
  const disabled = io.countDisabledFleetFiles();

  const runningSessions = await io.getSessionNames();
  for (const line of renderFleetLs(entries, disabled, runningSessions)) io.log(line);
}

export async function cmdFleetRename(
  options: FleetRenameOptions,
  deps: Partial<FleetManageDeps> = {},
) {
  const io = fleetManageDeps(deps);
  const oldName = stripJson(options.oldName);
  const newName = stripJson(options.newName);
  validateFleetRenameName("old fleet name", oldName);
  validateFleetRenameName("new fleet name", newName);
  if (oldName === newName) throw new UserError("old and new fleet names are identical");

  const entries = io.loadFleetEntries();
  const target = entries.find(e =>
    stripJson(e.file) === oldName ||
    displaySessionName(e) === oldName ||
    e.groupName === oldName ||
    stripNumberPrefix(displaySessionName(e)) === oldName
  );
  if (!target) throw new UserError(`fleet not found: ${oldName}`);

  const existing = entries.find(e => e !== target && (
    stripJson(e.file) === newName ||
    displaySessionName(e) === newName ||
    e.groupName === newName
  ));
  const newFile = `${newName}.json`;
  const targetDir = entryDir(io, target);
  const oldPath = entryPath(io, target);
  const newPath = io.join(targetDir, newFile);
  if (existing || (newPath !== oldPath && io.existsSync(newPath))) throw new UserError(`target fleet already exists: ${newName}`);

  const aliases = peerAliases(oldName);
  aliases.add(displaySessionName(target));
  aliases.add(target.groupName);
  const refUpdates = entries
    .map(entry => ({ entry, ...migrateFleetRefs(entry.session, aliases, newName) }))
    .filter(update => update.entry !== target && update.changed);

  const oldSessionName = displaySessionName(target);
  const newSession = { ...target.session, name: newName };
  const runningSessions = await io.getSessionNames();
  const runningMatch = runningSessions.find(s => s === oldSessionName || s === oldName)
    || runningSessions.find(s => stripNumberPrefix(s) === stripNumberPrefix(oldSessionName));

  io.log(`\n  \x1b[36mRenaming fleet...\x1b[0m ${oldSessionName} → ${newName}\n`);
  if (refUpdates.length > 0) {
    io.log(`  updating fleet references in ${refUpdates.map(({ entry }) => entry.file).join(", ")}`);
  }

  if (options.dryRun) {
    io.log(`  dry-run: would write ${newFile}`);
    for (const { entry } of refUpdates) io.log(`  dry-run: would update refs in ${entry.file}`);
    if (target.file !== newFile) io.log(`  dry-run: would delete ${target.file}`);
    if (runningMatch && runningMatch !== newName) io.log(`  dry-run: would tmux rename ${runningMatch} → ${newName}`);
    io.log("\n  \x1b[32mDry run complete.\x1b[0m No files changed.\n");
    return;
  }

  const migratedTarget = migrateFleetRefs(newSession, aliases, newName).session;
  const tmpPath = io.join(targetDir, `.tmp-${newFile}`);
  await io.writeFile(tmpPath, JSON.stringify(migratedTarget, null, 2) + "\n");
  io.renameSync(tmpPath, newPath);
  if (target.file !== newFile && io.existsSync(oldPath)) io.unlinkSync(oldPath);

  for (const { entry, session } of refUpdates) {
    const dir = entryDir(io, entry);
    const tmpRefPath = io.join(dir, `.tmp-${entry.file}`);
    const refPath = entryPath(io, entry);
    await io.writeFile(tmpRefPath, JSON.stringify(session, null, 2) + "\n");
    io.renameSync(tmpRefPath, refPath);
    io.log(`  ${entry.file.padEnd(28)} refs updated`);
  }

  if (runningMatch && runningMatch !== newName) {
    try {
      await io.tmuxRun("rename-session", "-t", runningMatch, newName);
      io.log(`  ${target.file.padEnd(28)} → ${newFile}  (tmux: ${runningMatch} → ${newName})`);
    } catch {
      io.log(`  ${target.file.padEnd(28)} → ${newFile}  (tmux rename failed: ${runningMatch})`);
    }
  } else {
    io.log(`  ${target.file.padEnd(28)} → ${newFile}`);
  }

  io.log("\n  \x1b[32mDone.\x1b[0m Run \x1b[36mmaw fleet doctor\x1b[0m to validate.\n");
}

export async function cmdFleetRenumber(deps: Partial<FleetManageDeps> = {}) {
  const io = fleetManageDeps(deps);
  const entries = io.loadFleetEntries();

  // Check for conflicts first
  const numCount = new Map<number, number>();
  for (const e of entries) numCount.set(e.num, (numCount.get(e.num) || 0) + 1);
  const groupFiles = new Map<string, string[]>();
  for (const e of entries) {
    const files = groupFiles.get(e.groupName) || [];
    files.push(e.file);
    groupFiles.set(e.groupName, files);
  }
  const duplicateFleetNames = [...groupFiles.entries()].filter(([, files]) => files.length > 1);
  const hasConflicts = [...numCount.values()].some(c => c > 1) || duplicateFleetNames.length > 0;

  if (!hasConflicts) {
    io.log("\n  \x1b[32mNo conflicts found.\x1b[0m Fleet numbering is clean.\n");
    return;
  }

  if (duplicateFleetNames.length > 0) {
    const details = duplicateFleetNames
      .map(([name, files]) => `${name} (${files.join(", ")})`)
      .join(", ");
    throw new UserError(`duplicate fleet name(s): ${details}; renumber cannot safely merge duplicate fleets`);
  }

  const runningSessions = await io.getSessionNames();

  io.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");

  // Sort by current number, then by name for stability
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));

  // Skip 99-overview from renumbering
  const regular = sorted.filter(e => e.num !== 99);

  const plans = regular.map((e, index) => {
    const num = index + 1;
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;
    const exactRunning = runningSessions.find(s => s === oldName) ?? null;
    const sameFleetRunning = runningSessions.find(s => stripNumberPrefix(s) === e.groupName && s !== oldName);
    if (sameFleetRunning) {
      throw new UserError(`fleet '${e.groupName}' already running as ${sameFleetRunning}; refusing to renumber ${oldName} → ${newName}`);
    }
    return { e, newFile, newName, oldName, runningMatch: exactRunning };
  });

  for (const { e, newFile, newName, oldName, runningMatch } of plans) {

    if (newFile !== e.file) {
      // Update config.name in JSON — write to temp file then atomically rename
      e.session.name = newName;
      const sourceDir = entryDir(io, e);
      const tmpPath = io.join(sourceDir, `.tmp-${newFile}`);
      await io.writeFile(tmpPath, JSON.stringify(e.session, null, 2) + "\n");
      io.renameSync(tmpPath, io.join(sourceDir, newFile));

      // Remove old file (only if name changed)
      const oldPath = entryPath(io, e);
      if (io.existsSync(oldPath) && newFile !== e.file) {
        io.unlinkSync(oldPath);
      }

      // Rename only the exact running tmux session. A different numbered
      // session with the same fleet name is a collision, not a safe fallback.
      if (runningMatch && runningMatch !== newName) {
        try {
          await io.tmuxRun("rename-session", "-t", runningMatch, newName);
          io.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux: ${runningMatch} → ${newName})`);
        } catch {
          io.log(`  ${e.file.padEnd(28)} → ${newFile}  (tmux rename failed: ${runningMatch})`);
        }
      } else {
        io.log(`  ${e.file.padEnd(28)} → ${newFile}`);
      }
    } else {
      io.log(`  ${e.file.padEnd(28)}   (unchanged)`);
    }
  }

  io.log(`\n  \x1b[32mDone.\x1b[0m ${regular.length} configs renumbered.\n`);
}
