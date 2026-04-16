/**
 * `maw ui` — pure helper functions (testable without side-effects).
 *
 * Covers: peer resolution, URL building, SSH tunnel command building,
 * dev-server discovery, and dist-install detection.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "../../../config";
import { ghqFindSync } from "../../../core/ghq";

// ---- Constants -----------------------------------------------------------

export const LENS_PORT = 5173;
export const MAW_PORT = 3456;
export const LENS_PAGE_2D = "federation_2d.html";
export const LENS_PAGE_3D = "federation.html";

// ---- Types ---------------------------------------------------------------

export interface UiOptions {
  peer?: string;
  tunnel?: boolean;
  dev?: boolean;
  threeD?: boolean;
  install?: boolean;
  installVersion?: string;
  /** Positional subcommand: "install" | "status" */
  subcommand?: "install" | "status";
  /** --version flag for `maw ui install --version v1.x.x` */
  version?: string;
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

/** Check if maw-ui dist is installed at ~/.maw/ui/dist/ */
export function isUiDistInstalled(): boolean {
  const distDir = join(homedir(), ".maw", "ui", "dist");
  return existsSync(join(distDir, "index.html"));
}

/** Find the maw-ui source directory for dev mode. */
export function findMawUiSrcDir(): string | null {
  // Try ghq path first (the standard oracle convention)
  const ghqPath = ghqFindSync("/maw-ui");
  if (ghqPath && existsSync(join(ghqPath, "package.json"))) return ghqPath;

  // Try sibling of maw-js
  const mawJsDir = join(__dirname, "..", "..");
  const sibling = join(mawJsDir, "..", "maw-ui");
  if (existsSync(join(sibling, "package.json"))) return sibling;

  // Try env override
  if (process.env.MAW_UI_SRC && existsSync(join(process.env.MAW_UI_SRC, "package.json"))) {
    return process.env.MAW_UI_SRC;
  }

  return null;
}

/** Build the dev server start command. */
export function buildDevCommand(mawUiDir: string): string {
  return `cd ${mawUiDir} && bun run dev`;
}

/** Build the lens URL the user should open in their browser. */
export function buildLensUrl(opts: {
  remoteHost?: string;
  threeD?: boolean;
  port?: number;
}): string {
  const port = opts.port ?? LENS_PORT;
  const page = opts.threeD ? LENS_PAGE_3D : LENS_PAGE_2D;
  const base = `http://localhost:${port}/${page}`;
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
