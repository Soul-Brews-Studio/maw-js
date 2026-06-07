import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const statusCalls: string[] = [];
let statusError: Error | null = null;

mock.module(import.meta.resolve("../../src/commands/shared/transport.ts"), () => ({
  cmdTransportStatus: async () => {
    statusCalls.push("status");
    if (statusError) throw statusError;
    console.log("Transport Status  (node: local)");
    console.log("  1. ●  tmux               connected  (local)");
  },
}));

mock.module("../../src/commands/shared/transport", () => ({
  cmdTransportStatus: async () => {
    statusCalls.push("status");
    if (statusError) throw statusError;
    console.log("Transport Status  (node: local)");
    console.log("  1. ●  tmux               connected  (local)");
  },
}));

const { command, default: transportHandler } = await import("../../src/commands/plugins/transport/index.ts");

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importFrom, importFn]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) specs.add(match[1]);
  }
  return [...specs];
}

beforeEach(() => {
  statusCalls.length = 0;
  statusError = null;
});

describe("transport command plugin standalone boundary (#2289)", () => {
  test("uses only command-local imports and no private maw package imports", () => {
    const source = readFileSync(join(root, "src/commands/plugins/transport/index.ts"), "utf8");
    const imports = parseImportSpecs(source);

    expect(command).toMatchObject({
      name: ["transport", "tp"],
      description: "Transport layer status and diagnostics",
    });
    expect(imports).toEqual(["../../../plugin/types", "../../shared/transport"]);
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin|sdk)(?:\/|")/);
    expect(source).not.toMatch(/@maw-js\/sdk/);
  });

  test("CLI default and explicit status invoke transport status", async () => {
    const defaultResult = await transportHandler({ source: "cli", args: [] } as any);
    const explicitResult = await transportHandler({ source: "cli", args: ["status"] } as any);

    expect(defaultResult.ok).toBe(true);
    expect(defaultResult.output).toContain("Transport Status");
    expect(explicitResult.ok).toBe(true);
    expect(explicitResult.output).toContain("tmux");
    expect(statusCalls).toEqual(["status", "status"]);
  });

  test("API and peer sources default to status unless sub is provided", async () => {
    const apiResult = await transportHandler({ source: "api", args: {} } as any);
    const peerResult = await transportHandler({ source: "peer", args: { sub: "status" } } as any);

    expect(apiResult.ok).toBe(true);
    expect(peerResult.ok).toBe(true);
    expect(statusCalls).toEqual(["status", "status"]);
  });

  test("unknown subcommands return usage errors without invoking status", async () => {
    const result = await transportHandler({ source: "cli", args: ["debug"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown subcommand: debug");
    expect(statusCalls).toEqual([]);
  });

  test("status failures are surfaced through InvokeResult", async () => {
    statusError = new Error("router unavailable");

    const result = await transportHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("router unavailable");
    expect(statusCalls).toEqual(["status"]);
  });
});
