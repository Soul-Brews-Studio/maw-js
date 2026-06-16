import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type Session = { name: string; windows?: Array<{ index?: number; name?: string }> };

let sessions: Session[] = [];
let hostCommands: string[] = [];
let hostOutput = "captured output";
let resolveResult: string | null = "54-mawjs:7";
let loadFleetCalls = 0;
let resolveCalls: string[] = [];

function parseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg in spec) {
      const kind = spec[arg];
      if (kind === Boolean) out[arg] = true;
      else if (kind === Number) out[arg] = Number(args[++i]);
      else out[arg] = args[++i];
    } else {
      out._.push(arg);
    }
  }
  return out;
}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  hostExec: async (command: string) => {
    hostCommands.push(command);
    return hostOutput;
  },
  listSessions: async () => sessions,
  loadFleetCore: () => {
    loadFleetCalls += 1;
    return [{ name: "54-mawjs", windows: [{ name: "mawjs-oracle" }] }];
  },
  resolvePeekTarget: async (target: string) => {
    resolveCalls.push(target);
    return resolveResult;
  },
  parseFlags,
  tmuxCmd: () => "tmux -L test",
}));

const { command, default: captureHandler } = await import("../../src/vendor/mpr-plugins/capture/index.ts");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  sessions = [{ name: "54-mawjs", windows: [{ index: 7, name: "mawjs-oracle" }] }];
  hostCommands = [];
  hostOutput = "captured output";
  resolveResult = "54-mawjs:7";
  loadFleetCalls = 0;
  resolveCalls = [];
});

describe("capture plugin standalone boundary (#2191)", () => {
  test("uses SDK imports for shared helpers and has no core imports", () => {
    const sources = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/capture", file), "utf8"),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib)\//);
    }
    expect(sources.join("\n")).toContain('from "maw-js/sdk"');
  });

  test("exports command metadata", () => {
    expect(command).toMatchObject({
      name: "capture",
      description: expect.stringContaining("Capture visible pane output"),
    });
  });

  test("CLI target and flags capture the requested pane tail", async () => {
    const result = await captureHandler({ source: "cli", args: ["mawjs", "--pane", "2", "--lines", "12"] } as any);

    expect(result).toEqual({ ok: true, output: "captured output" });
    expect(resolveCalls).toEqual(["mawjs"]);
    expect(loadFleetCalls).toBe(0);
    expect(hostCommands).toEqual(["tmux -L test capture-pane -t '54-mawjs:7.2' -p -S -12"]);
  });

  test("API target supports explicit window suffix and full scrollback", async () => {
    resolveResult = "54-mawjs:3";

    const result = await captureHandler({ source: "api", args: { target: "mawjs:3", full: true } } as any);

    expect(result.ok).toBe(true);
    expect(resolveCalls).toEqual(["mawjs:3"]);
    expect(hostCommands).toEqual(["tmux -L test capture-pane -t '54-mawjs:3' -p -S -"]);
  });

  test("missing target and unresolved sessions return InvokeResult errors", async () => {
    await expect(captureHandler({ source: "api", args: {} } as any)).resolves.toMatchObject({ ok: false, error: "target is required" });

    resolveResult = null;
    const missing = await captureHandler({ source: "cli", args: ["ghost"] } as any);
    expect(missing.ok).toBe(false);
    expect(stripAnsi(missing.error)).toContain("try: maw ls");
    expect(stripAnsi(missing.output)).toContain("try: maw ls");
  });
});
