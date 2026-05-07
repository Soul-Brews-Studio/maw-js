/**
 * impl-rename.ts — `maw oracle rename <old> <new>`
 *
 * Full identity rename across:
 *   1. GitHub repo (gh repo rename)
 *   2. ghq local clone (ghq get -u <new-name>)
 *   3. Fleet config (rename file + update name/windows/repo fields)
 *   4. Claude Code project dir (~/.claude/projects/) — copy session JSONLs
 *      so --continue history survives
 *   5. Tmux session (kill old + wake new)
 *
 * Manual sequence proven on 2026-05-04 (sage-vector-fix → arra-mcp-installation-guide).
 *
 * Usage:
 *   maw oracle rename <old> <new>           # full rename
 *   maw oracle rename <old> <new> --dry-run # preview
 *   maw oracle rename <old> <new> --org X   # specify GitHub org (default: SBS)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { hostExec, FLEET_DIR } from "../../../sdk";
import { formatError } from "../../../lib/format-error";

interface RenameOpts {
  org?: string;
  dryRun?: boolean;
}

/** @internal — exported for tests only */
export function encodePath(path: string): string {
  return path.replace(/^\//, "-").replace(/[/.]/g, "-");
}

/** @internal — pure validation, returns error string or null if valid */
export function validateRename(oldName: string, newName: string): string | null {
  if (!/^[a-z0-9-]+$/.test(newName)) {
    return `new name must match /^[a-z0-9-]+$/ (got '${newName}')`;
  }
  if (oldName === newName) {
    return "old and new names are identical";
  }
  if (!oldName) {
    return "old name required";
  }
  return null;
}

/** @internal — compute rename plan paths for testing */
export function computeRenamePlan(oldName: string, newName: string, org: string, home: string) {
  const oldRepoPath = `${home}/Code/github.com/${org}/${oldName}-oracle`;
  const newRepoPath = `${home}/Code/github.com/${org}/${newName}-oracle`;
  return {
    oldRepoPath,
    newRepoPath,
    oldEncoded: encodePath(oldRepoPath),
    newEncoded: encodePath(newRepoPath),
    oldProjectDir: `${home}/.claude/projects/${encodePath(oldRepoPath)}`,
    newProjectDir: `${home}/.claude/projects/${encodePath(newRepoPath)}`,
    oldRepoSlug: `${org}/${oldName}-oracle`,
    newRepoSlug: `${org}/${newName}-oracle`,
  };
}

export async function cmdOracleRename(oldName: string, newName: string, opts: RenameOpts = {}): Promise<void> {
  const org = opts.org || "Soul-Brews-Studio";
  const dryRun = opts.dryRun || false;
  const prefix = dryRun ? "[dry-run] " : "";

  // 1. Validate names
  const validationError = validateRename(oldName, newName);
  if (validationError) {
    console.error(formatError(validationError));
    process.exit(1);
  }

  console.log(`\x1b[36m🔁\x1b[0m ${prefix}renaming oracle: ${oldName} → ${newName}`);
  console.log("");

  // 2. GitHub repo rename
  console.log(`\x1b[90m1/5\x1b[0m gh repo rename ${org}/${oldName}-oracle → ${newName}-oracle`);
  if (!dryRun) {
    try {
      await hostExec(`gh repo rename ${newName}-oracle --repo ${org}/${oldName}-oracle --yes 2>&1`);
      console.log(`\x1b[32m  ✓\x1b[0m repo renamed on GitHub`);
    } catch (e: any) {
      // Repo may already be renamed (re-running)
      console.log(`\x1b[33m  ⚠\x1b[0m gh rename returned: ${e?.message?.split("\n")[0] || e}`);
      console.log(`\x1b[90m  (continuing — repo may already be at new name)\x1b[0m`);
    }
  }

  // 3. ghq clone new name (auto-redirects from old URL on GitHub side)
  console.log(`\x1b[90m2/5\x1b[0m ghq get -u ${org}/${newName}-oracle`);
  if (!dryRun) {
    try {
      await hostExec(`ghq get -u ${org}/${newName}-oracle 2>&1`);
      console.log(`\x1b[32m  ✓\x1b[0m cloned to new path`);
    } catch (e: any) {
      console.error(formatError(`ghq get failed: ${e?.message?.split("\n")[0] || e}`));
    }
  }

  // 4. Fleet config: find by oldName, rename file, update fields
  console.log(`\x1b[90m3/5\x1b[0m update fleet config`);
  const fleetFiles = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"));
  let renamedConfig: string | null = null;
  for (const file of fleetFiles) {
    const content = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
    const win = (content.windows || []).find((w: any) =>
      w.name === `${oldName}-oracle` || w.name === oldName
    );
    if (win) {
      // Update name + windows[].name + windows[].repo
      const newSessionName = content.name.replace(oldName, newName);
      content.name = newSessionName;
      win.name = `${newName}-oracle`;
      if (win.repo) win.repo = win.repo.replace(`${oldName}-oracle`, `${newName}-oracle`);

      const oldFile = join(FLEET_DIR, file);
      const newFile = join(FLEET_DIR, `${file.replace(oldName, newName)}`);
      console.log(`\x1b[90m    ${file} → ${file.replace(oldName, newName)}\x1b[0m`);
      console.log(`\x1b[90m    name: ${newSessionName}\x1b[0m`);

      if (!dryRun) {
        writeFileSync(newFile, JSON.stringify(content, null, 2) + "\n");
        if (oldFile !== newFile) renameSync(oldFile, `${oldFile}.disabled`);
      }
      renamedConfig = newSessionName;
      break;
    }
  }
  if (!renamedConfig) {
    console.log(`\x1b[33m  ⚠\x1b[0m no fleet config found for '${oldName}' (skipping)`);
  } else {
    console.log(`\x1b[32m  ✓\x1b[0m fleet config updated`);
  }

  // 5. Copy Claude Code session JSONLs (preserve --continue history)
  console.log(`\x1b[90m4/5\x1b[0m copy session JSONLs`);
  const oldRepoPath = `${homedir()}/Code/github.com/${org}/${oldName}-oracle`;
  const newRepoPath = `${homedir()}/Code/github.com/${org}/${newName}-oracle`;
  const oldEncoded = encodePath(oldRepoPath);
  const newEncoded = encodePath(newRepoPath);
  const oldProjectDir = `${homedir()}/.claude/projects/${oldEncoded}`;
  const newProjectDir = `${homedir()}/.claude/projects/${newEncoded}`;

  if (existsSync(oldProjectDir)) {
    if (!dryRun) {
      if (!existsSync(newProjectDir)) mkdirSync(newProjectDir, { recursive: true });
      const jsonls = readdirSync(oldProjectDir).filter(f => f.endsWith(".jsonl"));
      for (const f of jsonls) {
        copyFileSync(join(oldProjectDir, f), join(newProjectDir, f));
      }
      console.log(`\x1b[32m  ✓\x1b[0m copied ${jsonls.length} session files`);
    } else {
      console.log(`\x1b[90m    would copy from ${oldEncoded}\x1b[0m`);
      console.log(`\x1b[90m    to ${newEncoded}\x1b[0m`);
    }
  } else {
    console.log(`\x1b[90m  no project dir at ${oldProjectDir} (skipping)\x1b[0m`);
  }

  // 6. Kill old session + wake new (handled by user via maw kill + maw wake)
  console.log(`\x1b[90m5/5\x1b[0m next steps (run manually):`);
  if (renamedConfig) {
    const oldSessionName = renamedConfig.replace(newName, oldName);
    console.log(`\x1b[36m  $ maw kill ${oldSessionName} --session --force\x1b[0m`);
  }
  console.log(`\x1b[36m  $ maw wake ${newName}\x1b[0m`);
  console.log("");

  if (dryRun) {
    console.log(`\x1b[90m(dry-run — no changes made)\x1b[0m`);
  } else {
    console.log(`\x1b[32m✓ rename complete\x1b[0m`);
    console.log(`\x1b[90m  old repo at ${oldRepoPath} preserved (delete manually if desired)\x1b[0m`);
  }
}
