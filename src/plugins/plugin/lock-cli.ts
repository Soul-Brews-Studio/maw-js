/**
 * CLI verbs for plugins.lock (#487 Option A).
 *   maw plugin pin <name> <tarball> [--version X.Y.Z] [--signer <id>]...
 *   maw plugin unpin <name>
 */

import { resolve } from "path";
import { parseFlags } from "../../../cli/parse-args";
import { pinPlugin, unpinPlugin } from "./lock";

export async function cmdPluginPin(args: string[]): Promise<void> {
  const flags = parseFlags(
    args,
    { "--version": String, "--signer": [String] },
    0,
  );
  const name = flags._[0];
  const source = flags._[1];
  if (!name || !source) {
    throw new Error("usage: maw plugin pin <name> <tarball-path> [--version X.Y.Z] [--signer <id>]");
  }

  const resolvedSource = resolve(source);
  const version = flags["--version"] as string | undefined;
  const signers = (flags["--signer"] as string[] | undefined) ?? undefined;
  const { entry, previous } = pinPlugin(name, resolvedSource, { version, signers });

  if (previous) {
    console.log(`\x1b[32m✓\x1b[0m re-pinned ${name}`);
    if (previous.version !== entry.version) console.log(`  version: ${previous.version} → ${entry.version}`);
    if (previous.sha256 !== entry.sha256)   console.log(`  sha256:  ${previous.sha256} → ${entry.sha256}`);
    if (previous.source !== entry.source)   console.log(`  source:  ${previous.source} → ${entry.source}`);
  } else {
    console.log(`\x1b[32m✓\x1b[0m pinned ${name}@${entry.version}`);
    console.log(`  sha256: ${entry.sha256}`);
    console.log(`  source: ${entry.source}`);
  }
}

export async function cmdPluginUnpin(args: string[]): Promise<void> {
  const flags = parseFlags(args, {}, 0);
  const name = flags._[0];
  if (!name) throw new Error("usage: maw plugin unpin <name>");
  const { removed } = unpinPlugin(name);
  if (removed) {
    console.log(`\x1b[32m✓\x1b[0m unpinned ${name} (was ${removed.version}, ${removed.sha256})`);
  } else {
    console.log(`${name}: not in plugins.lock — nothing to do`);
  }
}
