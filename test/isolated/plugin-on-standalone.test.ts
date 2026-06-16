import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
let config: Record<string, any> = {};
let savedConfigs: Record<string, any>[] = [];

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  loadConfig: () => config,
  saveConfig: (next: Record<string, any>) => {
    savedConfigs.push(next);
    config = { ...config, ...next };
  },
}));

const { command, default: onHandler } = await import("../../src/vendor/mpr-plugins/on/index.ts?plugin-on-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  config = {};
  savedConfigs = [];
});

describe("on plugin standalone boundary (#2113)", () => {
  test("uses SDK/plugin imports and no maw private imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/on/index.ts"), "utf8");

    expect(source).toContain('from "@maw-js/sdk/plugin"');
    expect(source).toContain('import("maw-js/sdk")');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("exports command metadata and usage output", async () => {
    expect(command).toMatchObject({
      name: "on",
      description: expect.stringContaining("event triggers"),
    });

    const result = await onHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain('Usage: maw on <oracle> <event> [--once] [--timeout N] "<action>"');
    expect(output).toContain("agent-idle, agent-wake, agent-crash");
    expect(savedConfigs).toEqual([]);
  });

  test("adds a trigger using only SDK config helpers", async () => {
    config = { triggers: [{ name: "existing", on: "agent-idle", repo: "old", timeout: 5, action: "noop" }] };

    const result = await onHandler({
      source: "cli",
      args: ["neo", "idle", "--once", "--timeout", "9", "maw", "hey", "homekeeper", "neo done"],
    } as any);

    expect(result.ok).toBe(true);
    expect(savedConfigs).toEqual([
      {
        triggers: [
          { name: "existing", on: "agent-idle", repo: "old", timeout: 5, action: "noop" },
          {
            on: "agent-idle",
            repo: "neo",
            timeout: 9,
            action: "maw hey homekeeper neo done",
            name: "on-neo-idle",
            once: true,
          },
        ],
      },
    ]);
    expect(stripAnsi(result.output)).toContain("trigger added: on neo idle [once] → maw hey homekeeper neo done");
  });

  test("returns save errors as InvokeResult failures", async () => {
    savedConfigs = [];
    config = { triggers: [] };
    mock.module("maw-js/sdk", () => ({
  ...realSdk,
      loadConfig: () => config,
      saveConfig: () => {
        throw new Error("disk full");
      },
    }));
    const { default: failingHandler } = await import("../../src/vendor/mpr-plugins/on/index.ts?plugin-on-standalone-fail");

    const result = await failingHandler({ source: "cli", args: ["neo", "wake", "maw", "peek", "neo"] } as any);

    expect(result).toMatchObject({ ok: false, error: "disk full" });
  });
});
