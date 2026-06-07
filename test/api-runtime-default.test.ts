import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import { createClaudeFleetApi } from "../src/api/claude-fleet";
import { createTransportApi } from "../src/api/transport";
import { createTriggersApi } from "../src/api/triggers";
import {
  createUiStateApi,
  readUiState,
  writeUiState,
} from "../src/api/ui-state";

async function json(res: Response): Promise<any> {
  return await res.json();
}

function apiWith(plugin: Elysia) {
  return new Elysia({ prefix: "/api" }).use(plugin);
}

describe("runtime API routers default-suite coverage", () => {
  test("ui-state helpers read missing, invalid, valid, and written JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-ui-state-"));
    try {
      const statePath = join(dir, "ui-state.json");
      expect(readUiState(statePath)).toEqual({});

      writeFileSync(statePath, "{", "utf-8");
      expect(readUiState(statePath)).toEqual({});

      writeUiState({ panel: "fleet", width: 42 }, statePath);
      expect(readUiState(statePath)).toEqual({ panel: "fleet", width: 42 });
      expect(readFileSync(statePath, "utf-8")).toBe('{\n  "panel": "fleet",\n  "width": 42\n}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ui-state API delegates reads and maps write failures to 400", async () => {
    const writes: object[] = [];
    const app = apiWith(createUiStateApi({
      readUiState: () => ({ sidebar: "open" }),
      writeUiState: (data) => {
        writes.push(data);
      },
    }));

    const get = await app.handle(new Request("http://local/api/ui-state"));
    expect(get.status).toBe(200);
    expect(await json(get)).toEqual({ sidebar: "open" });

    const post = await app.handle(new Request("http://local/api/ui-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sidebar: "closed" }),
    }));
    expect(post.status).toBe(200);
    expect(await json(post)).toEqual({ ok: true });
    expect(writes).toEqual([{ sidebar: "closed" }]);

    const failing = apiWith(createUiStateApi({
      readUiState: () => ({}),
      writeUiState: () => {
        throw new Error("readonly");
      },
    }));
    const bad = await failing.handle(new Request("http://local/api/ui-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sidebar: "closed" }),
    }));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: "readonly" });
  });

  test("transport API reports status and sends with explicit host/from", async () => {
    const sends: any[] = [];
    const router = {
      status: () => [{ name: "tmux", connected: true }],
      send: async (target: any, message: string, from: string) => {
        sends.push({ target, message, from });
        return { ok: true, via: "tmux", retryable: false };
      },
    };
    const app = apiWith(createTransportApi({
      getTransportRouter: (() => router) as any,
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    }));

    const status = await app.handle(new Request("http://local/api/transport/status"));
    expect(status.status).toBe(200);
    expect(await json(status)).toEqual({
      transports: [{ name: "tmux", connected: true }],
      timestamp: "2026-05-17T00:00:00.000Z",
    });

    const sent = await app.handle(new Request("http://local/api/transport/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oracle: "mawjs-oracle",
        host: "m5",
        message: "ping",
        from: "mawjs-codex",
      }),
    }));
    expect(sent.status).toBe(200);
    expect(await json(sent)).toEqual({
      ok: true,
      via: "tmux",
      retryable: false,
      target: "mawjs-oracle",
      host: "m5",
    });
    expect(sends).toEqual([{
      target: { oracle: "mawjs-oracle", host: "m5" },
      message: "ping",
      from: "mawjs-codex",
    }]);
  });

  test("transport API defaults host and sender for local sends", async () => {
    const sends: any[] = [];
    const app = apiWith(createTransportApi({
      getTransportRouter: (() => ({
        status: () => [],
        send: async (target: any, message: string, from: string) => {
          sends.push({ target, message, from });
          return { ok: false, via: "none", reason: "unreachable", retryable: false };
        },
      })) as any,
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    }));

    const res = await app.handle(new Request("http://local/api/transport/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oracle: "mawjs-oracle", message: "ping" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: false,
      via: "none",
      reason: "unreachable",
      retryable: false,
      target: "mawjs-oracle",
      host: "local",
    });
    expect(sends).toEqual([{
      target: { oracle: "mawjs-oracle" },
      message: "ping",
      from: "api",
    }]);
  });

  test("transport API can stamp status with the default clock branch", async () => {
    const app = apiWith(createTransportApi({
      getTransportRouter: (() => ({
        status: () => [{ name: "http", connected: false }],
        send: async () => ({ ok: false, via: "none", retryable: false }),
      })) as any,
    }));

    const res = await app.handle(new Request("http://local/api/transport/status"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.transports).toEqual([{ name: "http", connected: false }]);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  test("triggers API renders configured triggers with last-fired history", async () => {
    const app = apiWith(createTriggersApi({
      getTriggers: () => [
        { on: "pr-merge", repo: "Soul-Brews-Studio/maw-js", action: "maw hey", name: "notify" },
        { on: "agent-idle", timeout: 60, action: "maw wake" },
      ],
      getTriggerHistory: () => [{
        index: 0,
        result: {
          trigger: { on: "pr-merge", action: "maw hey" },
          action: "maw hey",
          ok: true,
          output: "sent",
          ts: 123,
        },
      }],
      fire: (async () => []) as any,
    }));

    const res = await app.handle(new Request("http://local/api/triggers"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      total: 2,
      triggers: [
        {
          index: 0,
          on: "pr-merge",
          repo: "Soul-Brews-Studio/maw-js",
          timeout: null,
          action: "maw hey",
          name: "notify",
          lastFired: { ts: 123, ok: true, action: "maw hey", error: null },
        },
        {
          index: 1,
          on: "agent-idle",
          repo: null,
          timeout: 60,
          action: "maw wake",
          name: null,
          lastFired: null,
        },
      ],
    });
  });

  test("triggers API awaits fire results and normalizes optional output/error", async () => {
    const calls: any[] = [];
    const app = apiWith(createTriggersApi({
      getTriggers: () => [],
      getTriggerHistory: () => [],
      fire: async (event, ctx) => {
        calls.push({ event, ctx });
        return [
          {
            trigger: { on: "issue-close", action: "ok" },
            action: "ok",
            ok: true,
            output: "done",
            ts: 1,
          },
          {
            trigger: { on: "issue-close", action: "bad" },
            action: "bad",
            ok: false,
            error: "boom",
            ts: 2,
          },
        ];
      },
    }));

    const res = await app.handle(new Request("http://local/api/triggers/fire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "issue-close",
        context: { repo: "Soul-Brews-Studio/maw-js", issue: "1709" },
      }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      event: "issue-close",
      fired: 2,
      results: [
        { action: "ok", ok: true, output: "done", error: null },
        { action: "bad", ok: false, output: null, error: "boom" },
      ],
    });
    expect(calls).toEqual([{
      event: "issue-close",
      ctx: { repo: "Soul-Brews-Studio/maw-js", issue: "1709" },
    }]);
  });

  test("claude fleet API returns session count and discovery failures", async () => {
    const session = {
      sessionId: "abc",
      projectPath: "/repo",
      repo: "Soul-Brews-Studio/maw-js",
      worktree: null,
      pid: 123,
      ppid: 1,
      parentChain: ["maw"],
      tmuxTarget: "54-mawjs:mawjs-oracle.0",
      triggeredFrom: "maw-wake",
      status: "active",
      lastActivityAt: "2026-05-17T00:00:00.000Z",
      lastUserMessage: "test",
      lastAssistantMessage: "pass",
      sizeBytes: 42,
    };
    const okApp = apiWith(createClaudeFleetApi({
      listClaudeSessions: async () => [session] as any,
    }));

    const ok = await okApp.handle(new Request("http://local/api/fleet/claude"));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ sessions: [session], count: 1 });

    const badApp = apiWith(createClaudeFleetApi({
      listClaudeSessions: async () => {
        throw new Error("scan failed");
      },
    }));
    const bad = await badApp.handle(new Request("http://local/api/fleet/claude"));
    expect(bad.status).toBe(500);
    expect(await json(bad)).toEqual({
      error: "Failed to discover Claude sessions",
      detail: "scan failed",
    });
  });
});
