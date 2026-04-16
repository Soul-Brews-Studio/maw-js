/**
 * `maw ui` — output rendering, argument parsing, and CLI dispatcher.
 */

import {
  LENS_PORT,
  MAW_PORT,
  type UiOptions,
  isUiDistInstalled,
  findMawUiSrcDir,
  buildDevCommand,
  buildLensUrl,
  resolvePeerHostPort,
  justHost,
  buildTunnelCommand,
} from "./impl-helpers";
import { parseFlags } from "../../../cli/parse-args";

/**
 * Render the full output that `maw ui` prints, given the parsed options.
 * Returns a single string with newlines so tests can assert on it without
 * having to capture stdout. The CLI just prints this verbatim.
 */
export function renderUiOutput(opts: UiOptions): string {
  // Detect Shape A: if dist is installed, use maw-js port (3456) instead of vite (5173)
  const distInstalled = isUiDistInstalled();
  const lensPort = distInstalled ? MAW_PORT : LENS_PORT;

  // --dev mode: print the vite dev server command
  if (opts.dev) {
    const srcDir = findMawUiSrcDir();
    if (!srcDir) {
      return [
        `# maw-ui source not found. Searched:`,
        `#   - ghq list (no match for /maw-ui)`,
        `#   - sibling directory of maw-js`,
        `#   - $MAW_UI_SRC env var`,
        `#`,
        `# Clone it: ghq get https://github.com/Soul-Brews-Studio/maw-ui`,
        `# Or set: export MAW_UI_SRC=/path/to/maw-ui`,
      ].join("\n");
    }
    const devCmd = buildDevCommand(srcDir);
    const url = buildLensUrl({ threeD: opts.threeD, port: LENS_PORT });
    return [
      `# Start vite dev server (HMR on :${LENS_PORT}, proxy /api → maw serve on :${MAW_PORT}):`,
      devCmd,
      ``,
      `# Then open:`,
      url,
      ``,
      `# Requires maw serve running on :${MAW_PORT} for API/WS proxy.`,
      `# Edit files in ${srcDir} — vite hot-reloads instantly.`,
      `# Ctrl+C stops the dev server. Static :${MAW_PORT} keeps serving if installed.`,
    ].join("\n");
  }

  // --tunnel mode
  if (opts.tunnel) {
    if (!opts.peer) {
      return [
        "# usage: maw ui --tunnel <peer>",
        "# example: maw ui --tunnel oracle-world",
      ].join("\n");
    }
    const hostPort = resolvePeerHostPort(opts.peer);
    if (!hostPort) {
      return [
        `# unknown peer: ${opts.peer}`,
        `# expected a named peer (config.namedPeers) or literal host:port`,
      ].join("\n");
    }
    const host = justHost(hostPort);
    const user = process.env.USER || "neo";
    const sshCmd = buildTunnelCommand({ user, host });
    const url = buildLensUrl({ threeD: opts.threeD, port: lensPort });
    return [
      `# Run this on your local machine to forward both lens (${lensPort}) and maw-js (${MAW_PORT}):`,
      sshCmd,
      ``,
      `# Then open in your browser:`,
      url,
      ``,
      `# Stop the tunnel with Ctrl+C in the SSH terminal.`,
      ...(distInstalled ? [``, `# (Shape A — maw-ui dist served from maw-js on port ${MAW_PORT})`] : []),
    ].join("\n");
  }

  // Bare or <peer> mode — just print the URL
  if (opts.peer) {
    const hostPort = resolvePeerHostPort(opts.peer);
    if (!hostPort) {
      return [
        `# unknown peer: ${opts.peer}`,
        `# expected a named peer (config.namedPeers) or literal host:port`,
      ].join("\n");
    }
    return buildLensUrl({ remoteHost: hostPort, threeD: opts.threeD, port: lensPort });
  }

  return buildLensUrl({ threeD: opts.threeD, port: lensPort });
}

// ---- Arg parser ----------------------------------------------------------

const UI_SUBCOMMANDS = ["install", "status"] as const;
type UiSubcommand = typeof UI_SUBCOMMANDS[number];

export function parseUiArgs(args: string[]): UiOptions {
  // Detect positional subcommand as first arg (before any flags)
  const firstArg = args[0];
  const subcommand = UI_SUBCOMMANDS.includes(firstArg as UiSubcommand)
    ? (firstArg as UiSubcommand)
    : undefined;
  const restArgs = subcommand ? args.slice(1) : args;

  const flags = parseFlags(restArgs, {
    "--install": Boolean,
    "--tunnel": Boolean,
    "--dev": Boolean,
    "--3d": Boolean,
    "--version": String,
  }, 0);

  // permissive mode puts unknown flags into _ too;
  // peer must be first non-flag positional
  const peer = flags._.find((a: string) => !a.startsWith("--"));

  return {
    peer,
    install: flags["--install"],
    tunnel: flags["--tunnel"],
    dev: flags["--dev"],
    threeD: flags["--3d"],
    subcommand,
    version: flags["--version"],
  };
}

// ---- Public entry --------------------------------------------------------

export async function cmdUi(args: string[]): Promise<void> {
  const opts = parseUiArgs(args);

  if (opts.subcommand === "install" || opts.install) {
    const { cmdUiInstall } = await import("./ui-install");
    // --version takes precedence; fall back to peer (backward compat with --install <version>)
    await cmdUiInstall(opts.version ?? opts.peer);
    return;
  }

  if (opts.subcommand === "status") {
    const { cmdUiStatus } = await import("./ui-install");
    await cmdUiStatus();
    return;
  }

  console.log(renderUiOutput(opts));
}
