import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const calls: Array<{ name: string; args: unknown[] }> = [];
let fail: Error | null = null;

function record(name: string, ...args: unknown[]) {
  calls.push({ name, args });
  if (fail) throw fail;
  console.log(`${name} ok`);
}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    const out: Record<string, any> = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) out._.push(arg);
      else if (parser === Boolean) out[arg] = true;
      else if (typeof parser === "string") {
        const targetParser = spec[parser];
        if (targetParser === Boolean) out[parser] = true;
        else out[parser] = args[++i];
      } else out[arg] = args[++i];
    }
    return out;
  },
  cmdWorkspaceCreate: async (name: string, hub?: string) => record("create", name, hub),
  cmdWorkspaceJoin: async (code: string, hub?: string) => record("join", code, hub),
  cmdWorkspaceShare: async (agents: string[], wsId?: string) => record("share", agents, wsId),
  cmdWorkspaceUnshare: async (agents: string[], wsId?: string) => record("unshare", agents, wsId),
  cmdWorkspaceLs: async () => record("ls"),
  cmdWorkspaceAgents: async (wsId?: string) => record("agents", wsId),
  cmdWorkspaceInvite: async (wsId?: string) => record("invite", wsId),
  cmdWorkspaceLeave: async (wsId?: string) => record("leave", wsId),
  cmdWorkspaceStatus: async () => record("status"),
}));

const mod = await import("../../src/vendor/mpr-plugins/workspace/index.ts?plugin-workspace-standalone");
const handler = mod.default;

const cli = (args: string[]) => ({ source: "cli", args } as any);

beforeEach(() => {
  calls.length = 0;
  fail = null;
});

describe("workspace plugin standalone boundary (#2113)", () => {
  test("imports only the SDK boundary", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/workspace/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("pure parsers preserve hub and workspace aliases", () => {
    expect(mod._parseCreate(["create", "room", "--hub", "https://hub"])).toEqual({ name: "room", hub: "https://hub" });
    expect(mod._parseJoin(["join", "code", "--hub", "https://hub"])).toEqual({ code: "code", hub: "https://hub" });
    expect(mod._parseShareAgents(["share", "--ws", "w1", "neo", "trinity"])).toEqual({ wsId: "w1", agents: ["neo", "trinity"] });
  });

  test("dispatches all workspace subcommands through SDK helpers", async () => {
    await handler(cli(["create", "room", "--hub", "https://hub"]));
    await handler(cli(["join", "invite", "--hub", "https://hub"]));
    await handler(cli(["share", "neo", "trinity", "--workspace", "w1"]));
    await handler(cli(["unshare", "neo", "--ws", "w1"]));
    await handler(cli(["ls"]));
    await handler(cli(["agents", "w1"]));
    await handler(cli(["invite", "w1"]));
    await handler(cli(["leave", "w1"]));
    await handler(cli(["status"]));

    expect(calls.map((call) => call.name)).toEqual(["create", "join", "share", "unshare", "ls", "agents", "invite", "leave", "status"]);
    expect(calls[0]?.args).toEqual(["room", "https://hub"]);
    expect(calls[2]?.args).toEqual([["neo", "trinity"], "w1"]);
  });

  test("validates missing args, defaults to list, renders help, and captures errors", async () => {
    expect(await handler(cli(["create"]))).toEqual({ ok: false, error: "name required", output: "usage: maw workspace create <name> [--hub <url>]" });
    expect(await handler(cli(["join"]))).toEqual({ ok: false, error: "code required", output: "usage: maw workspace join <code> [--hub <url>]" });
    expect(await handler(cli(["share"]))).toEqual({ ok: false, error: "agent required", output: "usage: maw workspace share <agent...> [--workspace <id>]" });
    expect(await handler(cli(["unshare"]))).toEqual({ ok: false, error: "agent required", output: "usage: maw workspace unshare <agent...> [--workspace <id>]" });

    const defaultList = await handler(cli([]));
    expect(defaultList.ok).toBe(true);
    expect(calls.at(-1)?.name).toBe("ls");

    const help = await handler(cli(["wat"]));
    expect(help.ok).toBe(true);
    expect(help.output).toContain("maw workspace");
    expect(help.output).toContain("Alias: maw ws");

    fail = new Error("hub unavailable");
    const failed = await handler(cli(["status"]));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("hub unavailable");
  });
});
