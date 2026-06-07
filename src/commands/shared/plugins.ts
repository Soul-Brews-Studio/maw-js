/**
 * maw plugins ls/info/install/remove
 * User-facing CLI for managing installed plugin packages.
 *
 * Subcommands:
 *   plugins / plugins ls      — compact summary by default; -v table: name | version | surfaces | dir
 *   plugins info <name>       — full manifest + resolved paths, warn if wasm missing
 *   plugins install <path>    — validate via parseManifest, copy to ~/.maw/plugins/<name>/
 *   plugins remove <name>     — archive to /tmp/maw-plugin-<name>-<ts>/ (Nothing Deleted)
 *
 * MAW_PLUGIN_HOME env var overrides install destination (useful for tests).
 */

import type { LoadedPlugin } from "../../plugin/types";
import { discoverPackages } from "../../plugin/registry";
import { doLs, doInfo, type PluginLsOptions } from "./plugins-ls-info";
import { doInstall, doRemove } from "./plugins-install";
import { doProfile, doNuke } from "./plugins-profile";
import { doEnable, doDisable } from "./plugins-toggle";

export { doLs, doInfo } from "./plugins-ls-info";
export { doInstall, doRemove } from "./plugins-install";
export { doProfile, doNuke } from "./plugins-profile";
export { doEnable, doDisable } from "./plugins-toggle";
export { archiveToTmp, surfaces, shortenHome, printTable } from "./plugins-ui";

type Flags = {
  _: string[];
  "--json"?: boolean;
  "--force"?: boolean;
  "--all"?: boolean;
  "--verbose"?: boolean;
  "-v"?: boolean;
  "--core"?: boolean;
  "--standard"?: boolean;
  "--extra"?: boolean;
  "--api"?: boolean;
  [key: string]: unknown;
};

function lsOptions(flags: Flags): PluginLsOptions {
  const tiers: NonNullable<PluginLsOptions["tiers"]> = [];
  if (flags["--core"]) tiers.push("core");
  if (flags["--standard"]) tiers.push("standard");
  if (flags["--extra"]) tiers.push("extra");
  return {
    verbose: !!(flags["--verbose"] || flags["-v"]),
    tiers,
    apiOnly: !!flags["--api"],
  };
}

/**
 * Entry point for `maw plugins <sub> [args] [flags]`.
 * @param discover - injectable for tests; defaults to discoverPackages
 */
export async function cmdPlugins(
  sub: string,
  _rawArgs: string[],
  flags: Flags,
  discover: () => LoadedPlugin[] = discoverPackages,
): Promise<void> {
  const name = flags._[0];
  switch (sub) {
    case "ls":
    case "list":
      return doLs(flags["--json"] ?? false, flags["--all"] ?? false, discover, undefined, lsOptions(flags));
    case "info":
      if (!name) {
        console.error("usage: maw plugins info <name>");
        process.exit(1);
      }
      return doInfo(name, discover);
    case "install":
      if (!name) {
        console.error("usage: maw plugins install <path> [--force]");
        process.exit(1);
      }
      return doInstall(name, flags["--force"] ?? false);
    case "remove":
    case "uninstall":
    case "rm":
      if (!name) {
        console.error("usage: maw plugins remove <name>");
        process.exit(1);
      }
      return doRemove(name, discover);
    case "enable": {
      if (!name) { console.error("usage: maw plugin enable <name> [more...]"); process.exit(1); }
      return doEnable(flags._);
    }
    case "disable": {
      if (!name) { console.error("usage: maw plugin disable <name>"); process.exit(1); }
      return doDisable(name);
    }
    case "lean":
      return doProfile("core", discover);
    case "standard":
      return doProfile("standard", discover);
    case "full":
      return doProfile("full", discover);
    case "nuke":
      return doNuke();
    default:
      return doLs(flags["--json"] ?? false, flags["--all"] ?? false, discover, undefined, lsOptions(flags));
  }
}
