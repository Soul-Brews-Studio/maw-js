import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
// Namespace import + lazy defaults: the SDK bindings are resolved when a default
// is CALLED, not when this module loads, so a test that mocks "maw-js/sdk" with
// only the exports it exercises (hostExec, say) can still import the done
// lifecycle without a missing-export SyntaxError for tmux/takeSnapshot/etc.
import * as sdk from "maw-js/sdk";
import { getGhqRoot } from "maw-js/config/ghq-root";
import { loadConfig } from "maw-js/config";
import type { MawConfig } from "maw-js/config/types";
import { fleetDirsForRead } from "maw-js/commands/shared/fleet-load";
import { mawDataPath } from "../../../core/xdg";
import type { FleetEntry } from "../../../core/fleet/fleet-load-core";
// reunion-impl / soul-sync-impl / wake-session are loaded LAZILY (on first call):
// they carry named `tmux`/`listSessions` SDK imports that would otherwise be
// resolved at module load and break tests which mock "maw-js/sdk" partially
// (same class of problem fleet-load.ts solved with its namespace import).

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
  /** Live config, so a custom engine key is classified by its declared process family (#8). */
  loadConfig?: () => Partial<MawConfig>;
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
    listSessions: deps.listSessions ?? (() => (sdk.listSessions as unknown as () => Promise<SessionInfo[]>)()),
    hostExec: deps.hostExec ?? ((command: string) => sdk.hostExec(command)),
    tmux: {
      run: deps.tmux?.run ?? ((subcommand: string, ...args: (string | number)[]) => sdk.tmux.run(subcommand, ...args)),
      killWindow: deps.tmux?.killWindow ?? ((target: string) => sdk.tmux.killWindow(target)),
      sendText: deps.tmux?.sendText ?? ((target: string, text: string) => sdk.tmux.sendText(target, text)),
    },
    fleetDir: deps.fleetDir,
    fleetDirs: deps.fleetDirs ?? (deps.fleetDir ? [deps.fleetDir] : undefined),
    ghqRoot: deps.ghqRoot ?? getGhqRoot(),
    homeDir,
    inboxDir: deps.inboxDir ?? mawDataPath("inbox"),
    takeSnapshot: deps.takeSnapshot ?? ((trigger: string) => sdk.takeSnapshot(trigger)),
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
    loadConfig: deps.loadConfig ?? (() => loadConfig() as Partial<MawConfig>),
    loadFleetEntries: deps.loadFleetEntries ?? (() => sdk.loadFleetEntries()),
    readWorktreeEngineFile: deps.readWorktreeEngineFile
      ?? ((wtPath: string) => (require("../../../commands/shared/wake-session") as typeof import("../../../commands/shared/wake-session")).readWorktreeEngineFile(wtPath)),
    reunion: deps.reunion ?? (async (windowName: string) => (await import("./internal/reunion-impl")).cmdReunion(windowName)),
    soulSync: deps.soulSync ?? (async (arg: undefined, opts: { cwd?: string }) =>
      (await import("./internal/soul-sync-impl")).cmdSoulSync(arg as any, opts)),
  };
}

export type ResolvedDoneDeps = ReturnType<typeof doneDeps>;

/** Fleet-config files to scan, honoring an injected fleetDir/fleetDirs override. */
export function doneFleetDirs(d: ResolvedDoneDeps): string[] {
  if (d.fleetDirs?.length) return d.fleetDirs;
  if (d.fleetDir) return [d.fleetDir];
  return fleetDirsForRead();
}
