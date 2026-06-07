import { beforeEach, describe, expect, mock, test } from "bun:test";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

type Ctx = { source: "cli" | "api"; args: unknown; writer?: (...args: unknown[]) => void };
let calls: Array<[string, ...unknown[]]> = [];
let sessions: any[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => string | Promise<string> = () => "";
let resolveTargetResult: any = null;
let sendKeysLiteralCalls: Array<[string, string]> = [];
let tmuxRunImpl: (...args: string[]) => string | Promise<string> = () => "";
let peerMode: "ok" | "fail" | "throw" | "missing" = "ok";
let wakePeerMode: "ok" | "fail" | "throw" | "missing" = "ok";
let workspaceThrow = false;
let messageEvents: unknown[] = [];
let registry: any = { updated: "now", plugins: {}, packages: {} };
let searchResult: any = { queried: 0, responded: 0, elapsedMs: 0, hits: [], errors: [] };

function record(name: string, ...args: unknown[]) {
  calls.push([name, ...args]);
  console.log(`${name}:ok`);
  if (workspaceThrow) throw new Error(`${name} failed`);
}

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => { hostExecCalls.push(cmd); return await hostExecImpl(cmd); },
  tmuxCmd: () => "tmux",
  tmux: "tmux",
  FLEET_DIR: "/tmp/fleet",
  CONFIG_DIR: "/tmp/config",
  MAW_ROOT: "/tmp/maw",
  resolveTarget: () => resolveTargetResult,
  curlFetch: async () => ({ ok: true, data: { ok: true, target: "remote:1" } }),
  Tmux: class { async sendKeysLiteral(target: string, text: string) { sendKeysLiteralCalls.push([target, text]); } },
}));
mock.module("maw-js/config", () => ({ loadConfig: () => ({ host: "local", disabledPlugins: [] }) }));
mock.module("maw-js/commands/shared/comm-send", () => ({ resolveOraclePane: async (target: string) => `pane:${target}` }));
mock.module("maw-js/commands/shared/fleet-load", () => ({ loadFleet: () => [] }));
mock.module("maw-js/core/transport/tmux", () => ({
  Tmux: class { async run(...args: string[]) { return await tmuxRunImpl(...args); } },
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/contacts/impl.ts"), () => ({
  cmdContactsLs: async () => record("contacts-ls"),
  cmdContactsAdd: async (name: string, args: string[]) => record("contacts-add", name, args),
  cmdContactsRm: async (name: string) => record("contacts-rm", name),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/impl.ts"), () => ({ cmdKill: async (target: string, opts: unknown) => record("kill", target, opts) }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-resolve.ts"), () => ({
  resolvePeer: (alias: string) => peerMode === "missing" ? null : ({ url: `http://${alias}.invalid` }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/kill/internal/peer-call.ts"), () => ({
  callPeerKill: async (_url: string, body: unknown) => {
    calls.push(["peer-kill", body]);
    if (peerMode === "throw") throw new Error("offline");
    if (peerMode === "fail") return { ok: false, status: 500, data: { error: "boom" } };
    return { ok: true, data: { output: "remote killed" } };
  },
}));
mock.module("maw-js/commands/shared/wake", () => ({ cmdWake: async (oracle: string, opts: unknown) => record("wake", oracle, opts) }));
mock.module("maw-js/commands/shared/fleet", () => ({ cmdWakeAll: async (opts: unknown) => record("wake-all", opts) }));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => undefined,
}));
mock.module("maw-js/commands/shared/wake-resolve", () => ({ fetchGitHubPrompt: async (kind: string, n: number) => `${kind}-${n}-prompt` }));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts"), () => ({
  resolvePeer: (alias: string) => wakePeerMode === "missing" ? null : ({ url: `http://${alias}.invalid` }),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/wake/internal/peer-call.ts"), () => ({
  callPeerWake: async (_url: string, body: unknown) => {
    calls.push(["peer-wake", body]);
    if (wakePeerMode === "throw") throw new Error("offline");
    if (wakePeerMode === "fail") return { ok: false, status: 502, data: { error: "bad" } };
    return { ok: true, data: { output: "remote woke" } };
  },
}));
mock.module("maw-js/commands/shared/workspace", () => ({
  cmdWorkspaceCreate: async (name: string, hub?: string) => record("ws-create", name, hub),
  cmdWorkspaceJoin: async (code: string, hub?: string) => record("ws-join", code, hub),
  cmdWorkspaceShare: async (agents: string[], ws?: string) => record("ws-share", agents, ws),
  cmdWorkspaceUnshare: async (agents: string[], ws?: string) => record("ws-unshare", agents, ws),
  cmdWorkspaceLs: async () => record("ws-ls"),
  cmdWorkspaceAgents: async (id?: string) => record("ws-agents", id),
  cmdWorkspaceInvite: async (id?: string) => record("ws-invite", id),
  cmdWorkspaceLeave: async (id?: string) => record("ws-leave", id),
  cmdWorkspaceStatus: async () => record("ws-status"),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/messages/ledger.ts"), () => ({
  listMessageLedgerEvents: () => messageEvents,
  messageLedgerDbPath: () => "/tmp/messages.db",
  recordMessageLedgerEvent: (data: unknown) => calls.push(["message-event", data]),
}));
mock.module("maw-js/lib/message-events", () => ({ isMessageLifecycleData: (data: unknown) => Boolean((data as any)?.id) }));
mock.module(import.meta.resolve("../../src/commands/plugins/plugin/registry-fetch.ts"), () => ({
  registryUrl: () => "https://registry.invalid/plugins.json",
  getRegistry: async () => registry,
}));
mock.module(import.meta.resolve("../../src/commands/plugins/plugin/search-peers.ts"), () => ({ searchPeers: async () => searchResult }));
mock.module(import.meta.resolve("../../src/commands/plugins/plugin/registry-resolve.ts"), () => ({ resolvePluginSource: (name: string, reg: any) => reg.plugins[name] }));
mock.module(import.meta.resolve("../../src/commands/plugins/plugin/install-impl.ts"), () => ({ cmdPluginInstall: async (args: string[]) => record("plugin-install", args) }));

const contacts = await import("../../src/vendor/mpr-plugins/contacts/index.ts?coverage-100b-vendor-c-indexes");
const capture = await import("../../src/vendor/mpr-plugins/capture/impl.ts?coverage-100b-vendor-c-indexes");
const zoom = await import("../../src/vendor/mpr-plugins/zoom/impl.ts?coverage-100b-vendor-c-indexes");
const send = await import("../../src/vendor/mpr-plugins/send/impl.ts?coverage-100b-vendor-c-indexes");
const pr = await import("../../src/vendor/mpr-plugins/pr/impl.ts?coverage-100b-vendor-c-indexes");
const kill = await import("../../src/vendor/mpr-plugins/kill/index.ts?coverage-100b-vendor-c-indexes");
const wake = await import("../../src/vendor/mpr-plugins/wake/index.ts?coverage-100b-vendor-c-indexes");
const workspace = await import("../../src/vendor/mpr-plugins/workspace/index.ts?coverage-100b-vendor-c-indexes");
const messages = await import("../../src/vendor/mpr-plugins/messages/index.ts?coverage-100b-vendor-c-indexes");
const plugin = await import("../../src/commands/plugins/plugin/index.ts?coverage-100b-vendor-c-indexes");

function ctx(source: Ctx["source"], args: unknown): Ctx { return { source, args }; }

beforeEach(() => {
  calls = [];
  sessions = [];
  hostExecCalls = [];
  hostExecImpl = () => "";
  resolveTargetResult = null;
  sendKeysLiteralCalls = [];
  tmuxRunImpl = () => "";
  peerMode = "ok";
  wakePeerMode = "ok";
  workspaceThrow = false;
  messageEvents = [];
  registry = { updated: "now", plugins: {}, packages: {} };
  searchResult = { queried: 0, responded: 0, elapsedMs: 0, hits: [], errors: [] };
});

describe("coverage-100b vendor index and one-liner gaps", () => {
  test("contacts routes remove and catch paths", async () => {
    await expect(contacts.default(ctx("cli", ["rm", "neo"]))).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toEqual(["contacts-rm", "neo"]);

    await expect(contacts.default(ctx("cli", ["rm"]))).resolves.toMatchObject({ ok: false, error: "name required" });
  });

  test("capture and zoom render hint lists for unresolved sessions", async () => {
    sessions = [{ name: "alpha-needle", windows: [{ index: 0, name: "main" }] }];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      await expect(capture.cmdCapture("eed", {})).rejects.toThrow("session 'eed' not found");
      await expect(zoom.cmdZoom("eed", {})).rejects.toThrow("session 'eed' not found");
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("did you mean");
    expect(errors.join("\n")).toContain("alpha-needle");
  });

  test("send includes resolver hints for error results and pr rejects empty cwd", async () => {
    resolveTargetResult = { type: "error", detail: "ambiguous target", hint: "use exact" };
    await expect(send.cmdSend({ target: "neo", text: "hello" })).rejects.toThrow("ambiguous target — use exact");

    process.env.TMUX = "1";
    tmuxRunImpl = () => "";
    await expect(pr.cmdPr()).rejects.toThrow("could not detect working directory");
    delete process.env.TMUX;
  });

  test("kill and wake peer forwarding surface non-404 details", async () => {
    peerMode = "fail";
    await expect(kill.default(ctx("cli", ["neo", "--peer", "remote"]))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("boom"),
    });

    wakePeerMode = "fail";
    await expect(wake.default(ctx("cli", ["neo", "--peer", "remote", "task"]))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("bad"),
    });
  });

  test("workspace parse helpers and handler branches cover missing args and catch fallback", async () => {
    expect(workspace._parseCreate(["create", "room", "--hub", "http://hub"])).toEqual({ name: "room", hub: "http://hub" });
    expect(workspace._parseJoin(["join", "code", "--hub", "http://hub"])).toEqual({ code: "code", hub: "http://hub" });
    expect(workspace._parseShareAgents(["share", "--ws", "abc", "neo", "trinity"])).toEqual({ wsId: "abc", agents: ["neo", "trinity"] });

    await expect(workspace.default(ctx("cli", ["share"]))).resolves.toMatchObject({ ok: false, error: "agent required" });
    workspaceThrow = true;
    await expect(workspace.default(ctx("cli", ["status"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("ws-status") });
  });

  test("messages event and query helpers ignore invalid lifecycle data and print JSON for API", async () => {
    await messages.onEvent({ event: "Other", data: { id: "ignored" } } as any);
    await messages.onEvent({ event: "MessageSend", data: { no: "id" } } as any);
    await messages.onEvent({ event: "MessageSend", data: { id: "m1" } } as any);
    expect(calls).toEqual([["message-event", { id: "m1" }]]);

    messageEvents = [{ ts: "bad-date", from: "a", to: "b", direction: "outbound", state: "queued", body: "hello" }];
    const result = await messages.default(ctx("api", { limit: "2", json: true }));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("bad-date");
  });

  test("plugin registry/search/info/install one-liners handle empty and package paths", async () => {
    registry = {
      updated: "2026-05-18T00:00:00Z",
      plugins: { alpha: { version: "1.0.0", summary: "Alpha plugin", source: "https://example.invalid/a.tgz", author: "Nat", license: "BUSL", addedAt: "today" } },
      packages: { standard: { summary: "bundle", plugins: ["alpha"] } },
    };

    await expect(plugin.default(ctx("cli", ["registry"]))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("plugins:  1") });
    await expect(plugin.default(ctx("cli", ["search", "zzz"]))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("no plugins match") });
    await expect(plugin.default(ctx("cli", ["info", "alpha"]))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("alpha@1.0.0") });
    await expect(plugin.default(ctx("cli", ["install", "standard"]))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("1/1 installed") });
    expect(calls.some(call => call[0] === "plugin-install")).toBe(true);
  });
});
