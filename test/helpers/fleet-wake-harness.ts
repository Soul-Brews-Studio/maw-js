import { afterAll, afterEach, beforeEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "../..");

export interface FleetWindowFixture {
  name: string;
  repo: string;
}

export interface FleetSessionFixture {
  name: string;
  windows: FleetWindowFixture[];
  skip_command?: boolean;
}

export const fleetDir = mkdtempSync(join(tmpdir(), "maw-fleet-wake-fleet-"));
export const ghqRoot = mkdtempSync(join(tmpdir(), "maw-fleet-wake-ghq-"));

export const state = {
  fleet: [] as FleetSessionFixture[],
  hasSessions: new Set<string>(),
  retried: 0,
  extraWorktrees: 0,
  restoreCounts: new Map<string, number>(),
  restoreThrows: new Map<string, unknown>(),
  newWindowThrows: new Map<string, unknown>(),
  ensureThrows: undefined as unknown | undefined,
  respawnArgs: [] as FleetSessionFixture[][],
  resumeCalls: 0,
  captured: [] as string[],
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
  realSetTimeout(handler, 0, ...args)) as typeof setTimeout;

export function resetState() {
  rmSync(fleetDir, { recursive: true, force: true });
  rmSync(ghqRoot, { recursive: true, force: true });
  mkdirSync(fleetDir, { recursive: true });
  mkdirSync(ghqRoot, { recursive: true });
  state.fleet = [];
  state.hasSessions = new Set();
  state.retried = 0;
  state.extraWorktrees = 0;
  state.restoreCounts = new Map();
  state.restoreThrows = new Map();
  state.newWindowThrows = new Map();
  state.ensureThrows = undefined;
  state.respawnArgs = [];
  state.resumeCalls = 0;
  state.captured = [];
}

export function addRepo(repo: string) {
  mkdirSync(join(ghqRoot, repo), { recursive: true });
}

mock.module(join(root, "src/sdk"), () => ({
  get FLEET_DIR() { return fleetDir; },
  tmux: {
    hasSession: async (name: string) => {
      state.captured.push(`hasSession ${name}`);
      return state.hasSessions.has(name);
    },
    newSession: async (name: string, opts: { window?: string; cwd?: string } = {}) => {
      state.captured.push(`newSession ${name} ${opts.window ?? ""} ${opts.cwd ?? ""}`);
      state.hasSessions.add(name);
    },
    newWindow: async (session: string, name: string, opts: { cwd?: string } = {}) => {
      state.captured.push(`newWindow ${session}:${name} ${opts.cwd ?? ""}`);
      const thrown = state.newWindowThrows.get(`${session}:${name}`);
      if (thrown) throw thrown;
    },
    setEnvironment: async (session: string, key: string, value: string) => {
      state.captured.push(`setEnvironment ${session} ${key}=${value}`);
    },
    sendText: async (target: string, text: string) => {
      state.captured.push(`sendText ${target} ${text}`);
    },
    selectWindow: async (target: string) => {
      state.captured.push(`selectWindow ${target}`);
    },
    killSession: async (name: string) => {
      state.captured.push(`killSession ${name}`);
      if (!state.hasSessions.delete(name)) throw new Error("missing session");
    },
  },
  saveTabOrder: async (name: string) => {
    state.captured.push(`saveTabOrder ${name}`);
  },
  restoreTabOrder: async (name: string) => {
    state.captured.push(`restoreTabOrder ${name}`);
    const thrown = state.restoreThrows.get(name);
    if (thrown) throw thrown;
    return state.restoreCounts.get(name) ?? 0;
  },
}));

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("./mock-config");
  return {
    ...mockConfigModule(() => ({ node: "test-node", commands: {} })),
    buildCommand: (name: string) => `run ${name}`,
    getEnvVars: () => ({ MAW_TEST_ENV: "yes" }),
  };
});

mock.module(join(root, "src/config/ghq-root"), () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module(join(root, "src/commands/shared/fleet-load"), () => ({
  loadFleet: () => state.fleet,
  loadFleetEntries: () => [],
  getSessionNames: async () => state.fleet.map(s => s.name),
}));

mock.module(join(root, "src/commands/shared/wake"), () => ({
  ensureSessionRunning: async (name: string) => {
    state.captured.push(`ensureSessionRunning ${name}`);
    if (state.ensureThrows) throw state.ensureThrows;
    return state.retried;
  },
}));

mock.module(join(root, "src/commands/shared/fleet-resume"), () => ({
  respawnMissingWorktrees: async (sessions: FleetSessionFixture[]) => {
    state.captured.push(`respawnMissingWorktrees ${sessions.map(s => s.name).join(",")}`);
    state.respawnArgs.push(sessions);
    return state.extraWorktrees;
  },
  resumeActiveItems: async () => {
    state.captured.push("resumeActiveItems");
    state.resumeCalls++;
  },
}));

mock.module(join(root, "src/commands/shared/wake-pane-size"), () => ({
  pinSessionWide: async (session: string) => {
    state.captured.push(`pinSessionWide ${session}`);
  },
  pinWindowWide: async (target: string) => {
    state.captured.push(`pinWindowWide ${target}`);
  },
}));

export const { cmdSleep, cmdWakeAll } = await import("../../src/commands/shared/fleet-wake");
export const { HostExecError } = await import("../../src/core/transport/ssh");

beforeEach(resetState);

afterEach(() => {
  rmSync(fleetDir, { recursive: true, force: true });
  rmSync(ghqRoot, { recursive: true, force: true });
});

afterAll(() => {
  globalThis.setTimeout = realSetTimeout;
});
