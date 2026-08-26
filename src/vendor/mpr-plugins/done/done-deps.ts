import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { hostExec, listSessions, tmux, takeSnapshot, loadFleetEntries } from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { fleetDirsForRead } from "maw-js/commands/shared/fleet-load";
import { mawDataPath } from "../../../core/xdg";
import { readWorktreeEngineFile } from "../../../commands/shared/wake-session";
import type { FleetEntry } from "../../../core/fleet/fleet-load-core";
import { cmdReunion } from "./internal/reunion-impl";
import { cmdSoulSync } from "./internal/soul-sync-impl";

/** Session shape the done lifecycle reads (a subset of `maw ls`). */
export type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

type DoneFs = {
  appendFileSync: typeof appendFileSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
};

type DoneLogger = Pick<typeof console, "error" | "log">;

/**
 * Injectable dependencies for the `done` lifecycle. Every field is optional and
 * defaults to the real runtime binding, so production callers pass nothing and
 * tests inject only what they exercise. This is the single DI seam for the
 * canonical vendor `done` path (`src/commands/shared/done.ts` re-exports it).
 */
export interface DoneDeps {
  listSessions?: () => Promise<SessionInfo[]>;
  hostExec?: (command: string) => Promise<string>;
  tmux?: {
    run?: (subcommand: string, ...args: (string | number)[]) => Promise<string>;
    killWindow?: (target: string) => Promise<unknown>;
    sendText?: (target: string, text: string) => Promise<unknown>;
  };
  fleetDir?: string;
  fleetDirs?: string[];
  ghqRoot?: string;
  homeDir?: string;
  inboxDir?: string;
  takeSnapshot?: (trigger: string) => Promise<unknown>;
  branchBase?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fs?: Partial<DoneFs>;
  logger?: DoneLogger;
  /** Authoritative fleet records, for D3 engine-aware retro resolution. */
  loadFleetEntries?: () => FleetEntry[];
  /** Reads a worktree's `.maw-engine` marker; may throw on an invalid marker. */
  readWorktreeEngineFile?: (wtPath: string) => string | undefined;
  /** Post-done reunion step (vendor feature). */
  reunion?: (windowName: string) => Promise<unknown>;
  /** Post-done soul-sync step (vendor feature). */
  soulSync?: (arg: undefined, opts: { cwd?: string }) => Promise<unknown>;
}

export function doneDeps(deps: DoneDeps = {}) {
  const homeDir = deps.homeDir ?? homedir();
  return {
    listSessions: deps.listSessions ?? (listSessions as () => Promise<SessionInfo[]>),
    hostExec: deps.hostExec ?? hostExec,
    tmux: {
      run: deps.tmux?.run ?? tmux.run.bind(tmux),
      killWindow: deps.tmux?.killWindow ?? tmux.killWindow,
      sendText: deps.tmux?.sendText ?? tmux.sendText,
    },
    fleetDir: deps.fleetDir,
    fleetDirs: deps.fleetDirs ?? (deps.fleetDir ? [deps.fleetDir] : undefined),
    ghqRoot: deps.ghqRoot ?? getGhqRoot(),
    homeDir,
    inboxDir: deps.inboxDir ?? mawDataPath("inbox"),
    takeSnapshot: deps.takeSnapshot ?? takeSnapshot,
    branchBase: deps.branchBase,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    fs: {
      appendFileSync: deps.fs?.appendFileSync ?? appendFileSync,
      mkdirSync: deps.fs?.mkdirSync ?? mkdirSync,
      readdirSync: deps.fs?.readdirSync ?? readdirSync,
      readFileSync: deps.fs?.readFileSync ?? readFileSync,
      writeFileSync: deps.fs?.writeFileSync ?? writeFileSync,
    },
    logger: deps.logger ?? console,
    loadFleetEntries: deps.loadFleetEntries ?? loadFleetEntries,
    readWorktreeEngineFile: deps.readWorktreeEngineFile ?? readWorktreeEngineFile,
    reunion: deps.reunion ?? cmdReunion,
    soulSync: deps.soulSync ?? (cmdSoulSync as (arg: undefined, opts: { cwd?: string }) => Promise<unknown>),
  };
}

export type ResolvedDoneDeps = ReturnType<typeof doneDeps>;

/** Fleet-config files to scan, honoring an injected fleetDir/fleetDirs override. */
export function doneFleetDirs(d: ResolvedDoneDeps): string[] {
  if (d.fleetDirs?.length) return d.fleetDirs;
  if (d.fleetDir) return [d.fleetDir];
  return fleetDirsForRead();
}
