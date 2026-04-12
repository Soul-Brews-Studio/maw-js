/**
 * `maw ui` — print the URL (and SSH command if needed) to open the federation
 * lens. **Transparent by design** — this command never spawns SSH, never opens
 * a browser, never backgrounds a process. It just prints what the user should
 * run, and the user runs it.
 *
 * Why transparent: the wrapper version had to manage SSH ControlMaster sockets,
 * detect port conflicts, fork to background, and handle browser-open across
 * three platforms. All of that is process plumbing the user can do better with
 * their eyeballs and one paste. Print the command, get out of the way.
 *
 * ## Usage
 *
 *   maw ui                       — print local lens URL
 *   maw ui <peer>                — print local lens URL with ?host=<peer>
 *   maw ui --tunnel <peer>       — print SSH dual-port tunnel command + URL
 *   maw ui --3d                  — use federation.html (3D) instead of 2D
 *
 * ## Output is structured for copy-paste
 *
 *   $ maw ui
 *   http://localhost:5173/federation_2d.html
 *
 *   $ maw ui white
 *   http://localhost:5173/federation_2d.html?host=10.20.0.7%3A3456
 *
 *   $ maw ui --tunnel oracle-world
 *   # Run this on your local machine:
 *   ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 neo@10.20.0.16
 *
 *   # Then open:
 *   http://localhost:5173/federation_2d.html
 *
 * The output is shell-safe: comments start with `#`, the SSH command and the
 * URL each live on their own line, and there are no ANSI escapes around the
 * load-bearing text. You can pipe `maw ui --tunnel oracle-world` into a
 * script if you want.
 */

import { loadConfig } from "../config";

// ---- Constants -----------------------------------------------------------

const LENS_PORT = 5173;
const MAW_PORT = 3456;
const LENS_PAGE_2D = "federation_2d.html";
const LENS_PAGE_3D = "federation.html";

// ---- Types ---------------------------------------------------------------

export interface UiOptions {
  peer?: string;
  tunnel?: boolean;
  threeD?: boolean;
}

// ---- Pure helpers (testable) ---------------------------------------------

/**
 * Resolve a peer name to a host[:port]. Returns null if unknown. Accepts:
 *   - A bare named peer from `config.namedPeers`
 *   - A literal `host:port`
 *   - A literal hostname
 */
export function resolvePeerHostPort(peer: string): string | null {
  const trimmed = peer.trim();
  if (!trimmed) return null;

  const config = loadConfig() as any;
  const namedPeers: Array<{ name: string; url: string }> = config?.namedPeers ?? [];
  const named = namedPeers.find((p) => p.name === trimmed);
  if (named) {
    return named.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  if (/^[a-zA-Z0-9][a-zA-Z0-9.\-]*(?::\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/** Pull just the hostname from a host[:port] string. */
export function justHost(hostPort: string): string {
  return hostPort.split(":")[0];
}

/** Build the lens URL the user should open in their browser. */
export function buildLensUrl(opts: {
  remoteHost?: string;
  threeD?: boolean;
}): string {
  const page = opts.threeD ? LENS_PAGE_3D : LENS_PAGE_2D;
  const base = `http://localhost:${LENS_PORT}/${page}`;
  if (!opts.remoteHost) return base;
  return `${base}?host=${encodeURIComponent(opts.remoteHost)}`;
}

/**
 * Build the SSH dual-port forward command as a single shell-paste-ready
 * string. Forwards BOTH the lens port (5173) and the maw-js API port
 * (3456) so the user can hit both `http://localhost:5173/federation_2d.html`
 * AND run `maw <cmd>` against the remote backend transparently.
 *
 * Uses `-N` (no remote command) but NOT `-f` — the user runs this in a
 * foreground terminal and Ctrl+C kills the tunnel. Transparent lifecycle.
 */
export function buildTunnelCommand(args: { user: string; host: string }): string {
  return (
    `ssh -N ` +
    `-L ${LENS_PORT}:localhost:${LENS_PORT} ` +
    `-L ${MAW_PORT}:localhost:${MAW_PORT} ` +
    `${args.user}@${args.host}`
  );
}

/**
 * Render the full output that `maw ui` prints, given the parsed options.
 * Returns a single string with newlines so tests can assert on it without
 * having to capture stdout. The CLI just prints this verbatim.
 */
export function renderUiOutput(opts: UiOptions): string {
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
    const url = buildLensUrl({ threeD: opts.threeD });
    return [
      `# Run this on your local machine to forward both lens (${LENS_PORT}) and maw-js (${MAW_PORT}):`,
      sshCmd,
      ``,
      `# Then open in your browser:`,
      url,
      ``,
      `# Stop the tunnel with Ctrl+C in the SSH terminal.`,
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
    return buildLensUrl({ remoteHost: hostPort, threeD: opts.threeD });
  }

  return buildLensUrl({ threeD: opts.threeD });
}

// ---- Arg parser ----------------------------------------------------------

export function parseUiArgs(args: string[]): UiOptions {
  const opts: UiOptions = {};
  for (const a of args) {
    if (a === "--tunnel") opts.tunnel = true;
    else if (a === "--3d") opts.threeD = true;
    else if (!a.startsWith("--") && !opts.peer) opts.peer = a;
  }
  return opts;
}

// ---- Public entry --------------------------------------------------------

export async function cmdUi(args: string[]): Promise<void> {
  const opts = parseUiArgs(args);
  console.log(renderUiOutput(opts));
}
