import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const pluginDir = join(root, "src/vendor/mpr-plugins/send-enter");
let enterCalls: Array<{ target: string; key: string }> = [];
let result: any = { type: "local", target: "mawjs:codex-5" };

const sdkMock = {
  loadConfig: () => ({}),
  listSessions: async () => [{ name: "mawjs", windows: [{ name: "codex-5" }] }],
  resolveTarget: () => result,
  resolveOraclePane: async (target: string) => `${target}.pane`,
  tmux: { sendKeys: async (target: string, key: string) => { enterCalls.push({ target, key }); } },
  Tmux: class {},
  curlFetch: async () => ({ ok: true, data: { ok: true } }),
};
mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/send-enter/index.ts");
const { parseSendEnterArgs } = await import("../../src/vendor/mpr-plugins/send-enter/impl.ts");

function importsOf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...importsOf(full));
    else if (entry.name.endsWith(".ts")) {
      const source = readFileSync(full, "utf8");
      const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) out.push(match[1] ?? match[2]);
    }
  }
  return out;
}

beforeEach(() => {
  enterCalls = [];
  result = { type: "local", target: "mawjs:codex-5" };
});

describe("send-enter plugin standalone boundary", () => {
  test("uses SDK or local/platform imports only", () => {
    const imports = importsOf(pluginDir);
    expect(command).toMatchObject({ name: "send-enter" });
    expect(imports).toContain("maw-js/sdk");
    expect(imports.filter((spec) =>
      spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/plugin") || spec.startsWith("maw-js/config"),
    )).toEqual([]);
  });

  test("parses target and count forms", () => {
    expect(parseSendEnterArgs(["pane"])).toEqual({ target: "pane", count: 1 });
    expect(parseSendEnterArgs(["--N", "3", "pane"])).toEqual({ target: "pane", count: 3 });
    expect(parseSendEnterArgs(["pane", "--N=2"])).toEqual({ target: "pane", count: 2 });
    let thrown: unknown;
    try {
      parseSendEnterArgs(["--N", "0", "pane"]);
    } catch (err) {
      thrown = err;
    }
    expect(realSdk.isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("--N requires a positive integer");
  });

  test("local API invocation sends N enters through tmux", async () => {
    const r = await handler({ source: "api", args: { target: "codex-5", count: 2 } } as any);
    expect(r.ok).toBe(true);
    expect(enterCalls).toEqual([
      { target: "mawjs:codex-5.pane", key: "Enter" },
      { target: "mawjs:codex-5.pane", key: "Enter" },
    ]);
    expect(r.output).toContain("2 Enters");
  });

  test("peer targets remain explicitly unsupported", async () => {
    result = { type: "peer", node: "remote", target: "sess:win" };
    const r = await handler({ source: "cli", args: ["remote"] } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-node target");
    expect(enterCalls).toEqual([]);
  });
});
