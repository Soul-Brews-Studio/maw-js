import { describe, expect, mock, test } from "bun:test";

type Call = { name: string; args: unknown[] };
const calls: Call[] = [];
let throwFrom: string | null = null;

const record = async (name: string, ...args: unknown[]) => {
  calls.push({ name, args });
  if (throwFrom === name) throw new Error(`${name} exploded`);
  console.log(`${name}:${args.map(String).join(",")}`);
};

mock.module("maw-js/commands/shared/workspace", () => ({
  cmdWorkspaceCreate: (name: string, hub?: string) => record("create", name, hub),
  cmdWorkspaceJoin: (code: string, hub?: string) => record("join", code, hub),
  cmdWorkspaceShare: (agents: string[], wsId?: string) => record("share", agents, wsId),
  cmdWorkspaceUnshare: (agents: string[], wsId?: string) => record("unshare", agents, wsId),
  cmdWorkspaceLs: () => record("ls"),
  cmdWorkspaceAgents: (wsId?: string) => record("agents", wsId),
  cmdWorkspaceInvite: (wsId?: string) => record("invite", wsId),
  cmdWorkspaceLeave: (wsId?: string) => record("leave", wsId),
  cmdWorkspaceStatus: () => record("status"),
}));

const mod = await import("../../src/vendor/mpr-plugins/workspace/index.ts?workspace-index-second-pass-coverage");
const { default: handler, command, _parseCreate, _parseJoin, _parseShareAgents } = mod;

const cli = (args: string[], writer?: (...args: unknown[]) => void) => ({ source: "cli" as const, args, writer });
const api = (args: Record<string, unknown> = {}) => ({ source: "api" as const, args });

describe("workspace plugin index second-pass coverage", () => {
  test("exports aliases and pure parsers honor hub/workspace flags", () => {
    expect(command).toEqual({ name: ["workspace", "ws"], description: "Multi-node workspace management." });
    expect(_parseCreate(["create", "alpha", "--hub", "http://hub"])).toEqual({ name: "alpha", hub: "http://hub" });
    expect(_parseCreate(["create"])).toEqual({ name: undefined, hub: undefined });
    expect(_parseJoin(["join", "CODE", "--hub", "http://hub"])).toEqual({ code: "CODE", hub: "http://hub" });
    expect(_parseJoin(["join"])).toEqual({ code: undefined, hub: undefined });
    expect(_parseShareAgents(["share", "--ws", "w1", "m5", "m6"])).toEqual({ wsId: "w1", agents: ["m5", "m6"] });
    expect(_parseShareAgents(["unshare", "--workspace", "w2", "m7"])).toEqual({ wsId: "w2", agents: ["m7"] });
  });

  test("create/join/share/unshare validate required args and dispatch with parsed flags", async () => {
    calls.length = 0;
    expect(await handler(cli(["create"]))).toEqual({ ok: false, error: "name required", output: "usage: maw workspace create <name> [--hub <url>]" });
    expect(await handler(cli(["join"]))).toEqual({ ok: false, error: "code required", output: "usage: maw workspace join <code> [--hub <url>]" });
    expect(await handler(cli(["share"]))).toEqual({ ok: false, error: "agent required", output: "usage: maw workspace share <agent...> [--workspace <id>]" });
    expect(await handler(cli(["unshare"]))).toEqual({ ok: false, error: "agent required", output: "usage: maw workspace unshare <agent...> [--workspace <id>]" });

    expect((await handler(cli(["create", "alpha", "--hub", "http://hub"]))).ok).toBe(true);
    expect((await handler(cli(["join", "CODE", "--hub", "http://hub"]))).ok).toBe(true);
    expect((await handler(cli(["share", "m5", "m6", "--workspace", "w1"]))).ok).toBe(true);
    expect((await handler(cli(["unshare", "m5", "--ws", "w2"]))).ok).toBe(true);

    expect(calls.map(c => [c.name, c.args])).toEqual([
      ["create", ["alpha", "http://hub"]],
      ["join", ["CODE", "http://hub"]],
      ["share", [["m5", "m6"], "w1"]],
      ["unshare", [["m5"], "w2"]],
    ]);
  });

  test("list-like verbs dispatch, API defaults to ls, and writer streaming suppresses output capture", async () => {
    calls.length = 0;
    const writerLines: string[] = [];

    expect(await handler(cli(["ls"], (...args) => writerLines.push(args.map(String).join(" "))))).toEqual({ ok: true, output: undefined });
    expect(await handler(cli(["list"]))).toMatchObject({ ok: true });
    expect(await handler(cli(["agents", "w1"]))).toMatchObject({ ok: true });
    expect(await handler(cli(["invite", "w2"]))).toMatchObject({ ok: true });
    expect(await handler(cli(["leave", "w3"]))).toMatchObject({ ok: true });
    expect(await handler(cli(["status"]))).toMatchObject({ ok: true });
    expect(await handler(cli([]))).toMatchObject({ ok: true });
    expect(await handler(api({ sub: "status" }))).toMatchObject({ ok: true });

    expect(writerLines).toEqual(["ls:"]);
    expect(calls.map(c => c.name)).toEqual(["ls", "ls", "agents", "invite", "leave", "status", "ls", "ls"]);
  });

  test("unknown subcommands print help and command failures return structured errors with console restored", async () => {
    const originalLog = console.log;
    const unknown = await handler(cli(["wat"]));
    expect(unknown.ok).toBe(true);
    expect(unknown.output).toContain("maw workspace");
    expect(unknown.output).toContain("Alias: maw ws ...");

    throwFrom = "status";
    const failed = await handler(cli(["status"]));
    throwFrom = null;
    expect(failed).toEqual({ ok: false, error: "status exploded", output: undefined });
    expect(console.log).toBe(originalLog);
  });
});
