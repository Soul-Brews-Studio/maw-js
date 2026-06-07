import { dirname, join } from "path";
import { existsSync, renameSync, unlinkSync, readdirSync } from "fs";
import { tmux } from "../../sdk";
import { countDisabledFleetFiles, fleetDirForWrite, loadFleetEntries, getSessionNames, type FleetEntry } from "./fleet-load";

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
    throw new Error(`invalid ${label}: ${JSON.stringify(name)}`);
  }
}

function peerAliases(name: string): Set<string> {
  const clean = stripJson(name);
  const stem = stripNumberPrefix(clean);
  return new Set([clean, stem]);
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
  // Detect conflicts (duplicate numbers)
  const numCount = new Map<number, string[]>();
  for (const e of entries) {
    const list = numCount.get(e.num) || [];
    list.push(e.groupName);
    numCount.set(e.num, list);
  }

  const conflicts = [...numCount.entries()].filter(([, names]) => names.length > 1);
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
    const isConflict = (numCount.get(e.num)?.length ?? 0) > 1;

    let status = isRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[90mstopped\x1b[0m";
    if (isConflict) status += "  \x1b[31mCONFLICT\x1b[0m";
    if (isMalformedEntry(e)) status += "  \x1b[33mINVALID\x1b[0m";

    lines.push(`  ${numStr}  ${name} ${wins} ${status}`);
  }

  if (conflicts.length > 0) {
    lines.push(`\n  \x1b[31m⚠ ${conflicts.length} conflict(s) found.\x1b[0m Run \x1b[36mmaw fleet renumber\x1b[0m to fix.`);
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
  if (oldName === newName) throw new Error("old and new fleet names are identical");

  const entries = io.loadFleetEntries();
  const target = entries.find(e =>
    stripJson(e.file) === oldName ||
    displaySessionName(e) === oldName ||
    e.groupName === oldName ||
    stripNumberPrefix(displaySessionName(e)) === oldName
  );
  if (!target) throw new Error(`fleet not found: ${oldName}`);

  const existing = entries.find(e => e !== target && (
    stripJson(e.file) === newName ||
    displaySessionName(e) === newName ||
    e.groupName === newName
  ));
  const newFile = `${newName}.json`;
  const targetDir = entryDir(io, target);
  const oldPath = entryPath(io, target);
  const newPath = io.join(targetDir, newFile);
  if (existing || (newPath !== oldPath && io.existsSync(newPath))) throw new Error(`target fleet already exists: ${newName}`);

  const aliases = peerAliases(oldName);
  aliases.add(displaySessionName(target));
  aliases.add(target.groupName);
  const peerRefs = entries
    .filter(e => e !== target)
    .filter(e => (e.session.sync_peers || []).some(peer => aliases.has(peer)));
  if (peerRefs.length > 0 && !options.force) {
    throw new Error(
      `refusing to rename ${oldName}; referenced by sync_peers in ${peerRefs.map(e => e.file).join(", ")} (use --force to break)`,
    );
  }

  const oldSessionName = displaySessionName(target);
  const newSession = { ...target.session, name: newName };
  const runningSessions = await io.getSessionNames();
  const runningMatch = runningSessions.find(s => s === oldSessionName || s === oldName)
    || runningSessions.find(s => stripNumberPrefix(s) === stripNumberPrefix(oldSessionName));

  io.log(`\n  \x1b[36mRenaming fleet...\x1b[0m ${oldSessionName} → ${newName}\n`);
  if (peerRefs.length > 0 && options.force) {
    io.log(`  \x1b[33m⚠\x1b[0m leaving sync_peers references in ${peerRefs.map(e => e.file).join(", ")}`);
  }

  if (options.dryRun) {
    io.log(`  dry-run: would write ${newFile}`);
    if (target.file !== newFile) io.log(`  dry-run: would delete ${target.file}`);
    if (runningMatch && runningMatch !== newName) io.log(`  dry-run: would tmux rename ${runningMatch} → ${newName}`);
    io.log("\n  \x1b[32mDry run complete.\x1b[0m No files changed.\n");
    return;
  }

  const tmpPath = io.join(targetDir, `.tmp-${newFile}`);
  await io.writeFile(tmpPath, JSON.stringify(newSession, null, 2) + "\n");
  io.renameSync(tmpPath, newPath);
  if (target.file !== newFile && io.existsSync(oldPath)) io.unlinkSync(oldPath);

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
  const hasConflicts = [...numCount.values()].some(c => c > 1);

  if (!hasConflicts) {
    io.log("\n  \x1b[32mNo conflicts found.\x1b[0m Fleet numbering is clean.\n");
    return;
  }

  const runningSessions = await io.getSessionNames();

  io.log("\n  \x1b[36mRenumbering fleet...\x1b[0m\n");

  // Sort by current number, then by name for stability
  const sorted = [...entries].sort((a, b) => a.num - b.num || a.groupName.localeCompare(b.groupName));

  // Skip 99-overview from renumbering
  const regular = sorted.filter(e => e.num !== 99);

  let num = 1;
  for (const e of regular) {
    const newNum = String(num).padStart(2, "0");
    const newFile = `${newNum}-${e.groupName}.json`;
    const newName = `${newNum}-${e.groupName}`;
    const oldName = e.session.name;

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

      // Rename running tmux session (#84) — try exact name first, then pattern match
      const runningMatch = runningSessions.find(s => s === oldName)
        || runningSessions.find(s => s.replace(/^\d+-/, "") === e.groupName);
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
    num++;
  }

  io.log(`\n  \x1b[32mDone.\x1b[0m ${regular.length} configs renumbered.\n`);
}
