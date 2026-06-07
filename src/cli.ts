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
import { runBootstrap } from "./cli/plugin-bootstrap";
import { maybeAutoRestore } from "./cli/auto-restore";
import { dispatchCommand } from "./cli/dispatch";
import { handleTopLevelError } from "./cli/error-handler";
import { mawDataPath } from "./core/xdg";

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

  // Auto-bootstrap: if the XDG data plugin dir is empty, symlink bundled +
  // install from pluginSources. In legacy mode this still resolves to
  // ~/.maw/plugins; in MAW_XDG=1 it resolves to ~/.local/share/maw/plugins.
  // import.meta.dir must resolve to src/ — keep the call here, not in a child module.
  const pluginDir = process.env.MAW_PLUGINS_DIR || mawDataPath("plugins");
  await runBootstrap(pluginDir, import.meta.dir);

  // Load plugins from the resolved data plugin dir — the single source of truth.
  await scanCommands(pluginDir, "user");

  await maybeAutoRestore(cmd);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  await dispatchCommand(cmd, args);
}

main().catch((e: unknown) => handleTopLevelError(e, args));
