import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpHome = mkdtempSync(join(tmpdir(), "maw-runtime-teams-"));
process.env.HOME = tmpHome;

const sshPath = import.meta.resolve("../../src/core/transport/ssh.ts");
const tmuxPath = import.meta.resolve("../../src/core/transport/tmux.ts");
const configPath = import.meta.resolve("../../src/config/index.ts");
const targetCwdPath = import.meta.resolve("../../src/commands/shared/target-cwd.ts");

let selectCalls: string[] = [];
let selectReject = false;
let sendKeyCalls: Array<{ target: string; text: string }> = [];
let sendReject: Error | null = null;
let paneCommand: string | Error = "claude";
let killedWindows: string[] = [];
let tmuxRunResult = "";
let tmuxRunThrow: Error | null = null;

mock.module(sshPath, () => ({
  selectWindow: async (target: string) => {
    selectCalls.push(target);
    if (selectReject) throw new Error("missing window");
  },
  sendKeys: async (target: string, text: string) => {
    sendKeyCalls.push({ target, text });
    if (sendReject) throw sendReject;
  },
  hostExec: async () => "",
  getPaneCommand: async () => {
    if (paneCommand instanceof Error) throw paneCommand;
    return paneCommand;
  },
  isAgentCommand: (cmd: string) => /claude|codex/.test(cmd),
}));

mock.module(tmuxPath, () => ({
  tmux: {
    killWindow: async (target: string) => {
      killedWindows.push(target);
    },
    run: async (..._args: string[]) => {
      if (tmuxRunThrow) throw tmuxRunThrow;
      return tmuxRunResult;
    },
  },
}));

mock.module(configPath, () => ({
  buildCommand: (oracle: string) => `claude --oracle ${oracle || "default"}`,
}));

mock.module(targetCwdPath, () => ({
  extractOracleName: (target: string) => target.split(":")[0]?.replace(/^\d+-/, "") || "",
  resolveTargetCwd: (target: string) => target.includes("known") ? join(tmpHome, "known-oracle") : null,
  shellQuote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

const { registerBuiltinHandlers } = await import("../../src/core/runtime/handlers.ts?runtime-teams-coverage");

mock.module("os", () => ({
  homedir: () => tmpHome,
  tmpdir,
}));

const teamsModule = await import("../../src/engine/teams.ts?runtime-teams-coverage");
const { scanTeams, broadcastTeams } = teamsModule;

type Handler = (ws: any, data: any, engine: any) => unknown;

function makeEngine() {
  const handlers = new Map<string, Handler>();
  const engine = {
    pushedCapture: 0,
    pushedPreviews: 0,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    pushCapture: () => { engine.pushedCapture++; },
    pushPreviews: () => { engine.pushedPreviews++; },
  };
  registerBuiltinHandlers(engine as any);
  return { engine, handlers };
}

function makeWs() {
  const sent: string[] = [];
  return {
    ws: {
      data: {},
      send: (msg: string) => sent.push(msg),
    },
    sent,
  };
}

function resetHome() {
  rmSync(join(tmpHome, ".claude"), { recursive: true, force: true });
  mkdirSync(join(tmpHome, ".claude", "teams"), { recursive: true });
  mkdirSync(join(tmpHome, ".claude", "tasks"), { recursive: true });
}

function writeTeam(name: string, config: Record<string, unknown>) {
  const dir = join(tmpHome, ".claude", "teams", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf-8");
}

function writeTask(team: string, file: string, payload: string) {
  const dir = join(tmpHome, ".claude", "tasks", team);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), payload, "utf-8");
}

beforeEach(() => {
  selectCalls = [];
  selectReject = false;
  sendKeyCalls = [];
  sendReject = null;
  paneCommand = "claude";
  killedWindows = [];
  tmuxRunResult = "";
  tmuxRunThrow = null;
  resetHome();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("runtime websocket handlers", () => {
  test("registers handlers and routes main/preview subscriptions", () => {
    const { engine, handlers } = makeEngine();
    const { ws } = makeWs();

    handlers.get("subscribe")!(ws, { target: "alpha:0" }, engine);
    expect(ws.data.target).toBe("alpha:0");
    expect(engine.pushedCapture).toBe(1);

    handlers.get("subscribe")!(ws, { target: "beta:1", scope: "preview" }, engine);
    expect([...ws.data.previewTargets]).toEqual(["beta:1"]);
    expect(engine.pushedPreviews).toBe(1);

    handlers.get("subscribe-previews")!(ws, { targets: ["a", "b"] }, engine);
    expect([...ws.data.previewTargets]).toEqual(["a", "b"]);
    expect(engine.pushedPreviews).toBe(2);
  });

  test("select ignores failures and send blocks non-agent panes unless forced", async () => {
    const { engine, handlers } = makeEngine();
    const { ws, sent } = makeWs();
    selectReject = true;
    handlers.get("select")!(ws, { target: "missing" }, engine);
    await Promise.resolve();
    expect(selectCalls).toEqual(["missing"]);

    paneCommand = "vim";
    await handlers.get("send")!(ws, { target: "alpha:0", text: "hi" }, engine);
    expect(JSON.parse(sent.at(-1)!).error).toContain("no active Claude session");
    expect(sendKeyCalls).toEqual([]);

    paneCommand = new Error("pane gone");
    await handlers.get("send")!(ws, { target: "alpha:0", text: "forced by failed check" }, engine);
    await new Promise(resolve => setTimeout(resolve, 320));
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "sent", target: "alpha:0" });
    expect(engine.pushedCapture).toBe(1);
  });

  test("send force/reject, sleep, stop, wake, and restart paths report action results", async () => {
    const { handlers } = makeEngine();
    const { ws, sent } = makeWs();
    const captureEngine = { pushCapture: () => {} };

    await handlers.get("send")!(ws, { target: "alpha:0", text: "hello", force: true }, captureEngine);
    expect(sendKeyCalls.at(-1)).toEqual({ target: "alpha:0", text: "hello" });

    sendReject = new Error("cannot send");
    await handlers.get("send")!(ws, { target: "alpha:0", text: "oops", force: true }, captureEngine);
    await Promise.resolve();
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "error", error: "cannot send" });

    await handlers.get("sleep")!(ws, { target: "alpha:0" }, {});
    await Promise.resolve();
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "error", error: "cannot send" });
    sendReject = null;

    await handlers.get("sleep")!(ws, { target: "alpha:0" }, {});
    await handlers.get("stop")!(ws, { target: "alpha" }, {});
    await handlers.get("wake")!(ws, { target: "known:0" }, {});

    const restartPromise = handlers.get("restart")!(ws, { target: "plain:0", command: "custom-cmd" }, {});
    await new Promise(resolve => setTimeout(resolve, 2510));
    await restartPromise;

    expect(sendKeyCalls).toContainEqual({ target: "alpha:0", text: "\x03" });
    expect(killedWindows).toEqual(["alpha"]);
    expect(sendKeyCalls.find(call => call.text.includes("known-oracle"))?.text).toContain(`cd '${join(tmpHome, "known-oracle")}' &&`);
    expect(sendKeyCalls.slice(-3)).toEqual([
      { target: "plain:0", text: "\x03" },
      { target: "plain:0", text: "\x03" },
      { target: "plain:0", text: "custom-cmd\r" },
    ]);
    expect(sent.map(s => JSON.parse(s).type)).toContain("action-ok");
  });
});

describe("engine team scanning and broadcast", () => {
  test("scanTeams handles tmux errors and missing teams directory", async () => {
    rmSync(join(tmpHome, ".claude"), { recursive: true, force: true });
    await expect(scanTeams()).resolves.toEqual([]);

    resetHome();
    tmuxRunThrow = new Error("tmux down");
    writeTeam("quiet", { name: "quiet", description: "", members: [] });
    await expect(scanTeams()).resolves.toEqual([{ name: "quiet", description: "", members: [], tasks: [], alive: false }]);
  });

  test("scanTeams loads tasks and detects tmux/in-process/team-lead liveness", async () => {
    const now = Date.now();
    tmuxRunResult = "%1\n%2\n";
    writeTeam("alpha", {
      name: "alpha",
      description: "live",
      members: [
        { backendType: "tmux", tmuxPaneId: "%2" },
        { backendType: "in-process", cwd: join(tmpHome, "repo"), joinedAt: now - 60_000 },
      ],
    });
    writeTask("alpha", "1.json", JSON.stringify({ id: 1, subject: "ok" }));
    writeTask("alpha", "bad.json", "{");

    writeTeam("remote", {
      name: "remote",
      description: "not live",
      members: [
        { backendType: "in-process", cwd: "/Users/elsewhere/repo", joinedAt: now },
        { agentType: "team-lead", cwd: join(tmpHome, "old"), joinedAt: now - 3 * 60 * 60 * 1000 },
      ],
    });
    writeTeam("broken", "{ not json" as any);
    writeFileSync(join(tmpHome, ".claude", "teams", "broken", "config.json"), "{", "utf-8");

    const teams = await scanTeams();
    expect(teams.find(t => t.name === "alpha")).toMatchObject({ alive: true, tasks: [{ id: 1, subject: "ok" }] });
    expect(teams.find(t => t.name === "remote")).toMatchObject({ alive: false, tasks: [] });
    expect(teams.some(t => t.name === "broken")).toBe(false);
  });

  test("broadcastTeams skips empty clients, suppresses unchanged payloads, and sends changed team state", async () => {
    writeTeam("alpha", { name: "alpha", description: "", members: [] });
    const lastJson = { value: "" };
    const sentA: string[] = [];
    const sentB: string[] = [];
    await broadcastTeams(new Set(), lastJson);
    expect(lastJson.value).toBe("");

    const clients = new Set<any>([
      { send: (msg: string) => sentA.push(msg) },
      { send: (msg: string) => sentB.push(msg) },
    ]);
    await broadcastTeams(clients, lastJson);
    expect(JSON.parse(sentA[0]!).type).toBe("teams");
    expect(sentB).toHaveLength(1);

    await broadcastTeams(clients, lastJson);
    expect(sentA).toHaveLength(1);

    writeTask("alpha", "2.json", JSON.stringify({ id: 2 }));
    await broadcastTeams(clients, lastJson);
    expect(sentA).toHaveLength(2);
  });
});
