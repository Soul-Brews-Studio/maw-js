#!/usr/bin/env bun
process.env.MAW_CLI = "1";

// #566: apply --as <name> BEFORE any state-touching import (paths.ts evaluates
// MAW_HOME at module load). Must be the first side effect.
import { applyInstancePreset } from "./cli/instance-preset";
applyInstancePreset();

import { logAudit } from "./core/fleet/audit";
import { usage } from "./cli/usage";
import { scanCommands } from "./cli/command-registry";
import { setVerbosityFlags } from "./cli/verbosity";
import { getVersionString } from "./cli/cmd-version";
import { runUpdate } from "./cli/cmd-update";
import { runBootstrap, resolveBundledPath } from "./cli/plugin-bootstrap";
import { maybeAutoRestore } from "./cli/auto-restore";
import { dispatchCommand } from "./cli/dispatch";
import { handleTopLevelError } from "./cli/error-handler";
import { DEFAULT_TIER } from "./plugin/manifest-constants";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Strip verbosity flags up-front so they don't collide with cmd detection or
// leak into plugin argv. Task #3 will flip call sites to honor these.
const VERBOSITY_FLAGS = new Set(["--quiet", "-q", "--silent", "-s"]);
const rawArgs = process.argv.slice(2);
const verbosity: { quiet?: boolean; silent?: boolean } = {};
if (rawArgs.some(a => a === "--quiet" || a === "-q")) verbosity.quiet = true;
if (rawArgs.some(a => a === "--silent" || a === "-s")) verbosity.silent = true;
setVerbosityFlags(verbosity);
const args = rawArgs.filter(a => !VERBOSITY_FLAGS.has(a));
const cmd = args[0]?.toLowerCase();

logAudit(cmd || "", args);

async function main(): Promise<void> {
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(getVersionString());
    return;
  }
  if (cmd === "update" || cmd === "upgrade") {
    await runUpdate(args);
    return;
  }

  // Auto-bootstrap: if ~/.maw/plugins/ is empty, symlink bundled + install from pluginSources.
  // import.meta.dir must resolve to src/ — keep the call here, not in a child module.
  const pluginDir = join(homedir(), ".maw", "plugins");
  await runBootstrap(pluginDir, import.meta.dir);

  // #1316 — startup integrity check: warn loudly if any core-tier bundled
  // plugin is missing from pluginDir after bootstrap. Catches the silent
  // "unknown command" failure mode when symlinks have drifted or never
  // landed (e.g. partially-healed install).
  try {
    const linked = new Set(readdirSync(pluginDir));
    const bundledRoot = await resolveBundledPath(import.meta.dir);
    const expectedCore = bundledRoot
      ? readdirSync(bundledRoot).filter(d => {
          const m = join(bundledRoot, d, "plugin.json");
          if (!existsSync(m)) return false;
          try {
            const j = JSON.parse(readFileSync(m, "utf-8"));
            return (j.tier ?? DEFAULT_TIER) === "core";
          } catch { return false; }
        })
      : [];
    const missing = expectedCore.filter(n => !linked.has(n));
    if (missing.length) {
      console.warn(`[maw] core plugins missing from ${pluginDir}: ${missing.join(", ")}`);
      console.warn(`[maw] run 'maw plugins doctor --heal' to relink, or rm -rf ${pluginDir} && maw --version`);
    }
  } catch {}

  // Load plugins from ~/.maw/plugins/ — the single source of truth
  await scanCommands(pluginDir, "user");

  await maybeAutoRestore(cmd);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  await dispatchCommand(cmd, args);
}

main().catch((e: unknown) => handleTopLevelError(e, args));
