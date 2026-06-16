import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const restartDir = join(root, "src/vendor/mpr-plugins/restart");
let sessions: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let killed: string[] = [];
let slept = 0;
let woke = 0;

async function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = orig; }
}

class MockTmux {
  async killSession(name: string) { killed.push(name); }
}

const sdkMock = {
  listSessions: async () => sessions,
  Tmux: MockTmux,
  cmdSleep: async () => { slept++; },
  cmdWakeAll: async () => { woke++; },
  ghqFindSync: () => null,
  mawDataPath: (...parts: string[]) => join("/tmp/maw-data", ...parts),
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const { command, default: restartHandler } = await import("../../src/vendor/mpr-plugins/restart/index.ts");
const { cmdRestart } = await import("../../src/vendor/mpr-plugins/restart/impl.ts");

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) specs.add(match[1] ?? match[2]);
  return [...specs];
}

beforeEach(() => {
  sessions = [];
  killed = [];
  slept = 0;
  woke = 0;
});

describe("restart plugin standalone boundary", () => {
  test("all restart sources use SDK or platform/local imports only", () => {
    const imports = walkSources(restartDir).flatMap((file) => importSpecs(readFileSync(file, "utf8")));
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/cli/")
      || spec === "maw-js/config"
      || spec.startsWith("maw-js/config/")
      || spec.startsWith("maw-js/plugin")
      || spec.includes("../../../core"),
    );

    expect(command).toMatchObject({ name: "restart" });
    expect(forbidden).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("help short-circuits before destructive restart work", async () => {
    const cli = await silenceConsole(() => restartHandler({ source: "cli", args: ["--help"] } as any));
    expect(cli).toMatchObject({ ok: true });
    expect(cli?.output).toContain("usage: maw restart");

    const newer = await silenceConsole(() => restartHandler(["-h"] as any));
    expect(newer).toMatchObject({ ok: true });
    expect(killed).toEqual([]);
    expect(slept).toBe(0);
    expect(woke).toBe(0);
  });

  test("--no-update path cleans stale sessions then sleeps and wakes fleet via SDK seams", async () => {
    sessions = [
      { name: "mawjs-view", windows: [{ name: "codex" }] },
      { name: "maw-pty-123", windows: [{ name: "bash" }] },
      { name: "all-bash", windows: [{ name: "bash" }, { name: "bash" }] },
      { name: "healthy", windows: [{ name: "codex-5" }] },
    ];

    const result = await restartHandler({ source: "cli", args: ["--no-update"] } as any);

    expect(result).toMatchObject({ ok: true });
    expect(killed).toEqual(["mawjs-view", "maw-pty-123", "all-bash"]);
    expect(slept).toBe(1);
    expect(woke).toBe(1);
    expect(result?.output).toContain("Update skipped");
    expect(result?.output).toContain("restart complete");
  });

  test("cmdRestart help option is defensive and side-effect free", async () => {
    await silenceConsole(() => cmdRestart({ help: true }));

    expect(killed).toEqual([]);
    expect(slept).toBe(0);
    expect(woke).toBe(0);
  });
});
