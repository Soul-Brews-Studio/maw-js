import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createAsksApi } from "../src/api/asks";
import { createFleetApi } from "../src/api/fleet";
import { createWorktreesApi } from "../src/api/worktrees";

async function json(res: Response): Promise<any> {
  return await res.json();
}

function apiWith(plugin: Elysia) {
  return new Elysia({ prefix: "/api" }).use(plugin);
}

describe("small API routers default-suite coverage", () => {
  test("worktrees API returns scanned rows and cleanup logs", async () => {
    const calls: string[] = [];
    const app = apiWith(createWorktreesApi({
      async scanWorktrees() {
        calls.push("scan");
        return [{
          path: "/repo/.wt-demo",
          branch: "codex/demo",
          repo: "Soul-Brews-Studio/maw-js.wt-demo",
          mainRepo: "Soul-Brews-Studio/maw-js",
          name: "demo",
          status: "active",
          tmuxWindow: "mawjs-demo",
        }];
      },
      async cleanupWorktree(path) {
        calls.push(`cleanup:${path}`);
        return [`removed ${path}`];
      },
    }));

    const list = await app.handle(new Request("http://local/api/worktrees"));
    expect(list.status).toBe(200);
    expect(await json(list)).toEqual([{
      path: "/repo/.wt-demo",
      branch: "codex/demo",
      repo: "Soul-Brews-Studio/maw-js.wt-demo",
      mainRepo: "Soul-Brews-Studio/maw-js",
      name: "demo",
      status: "active",
      tmuxWindow: "mawjs-demo",
    }]);

    const cleanup = await app.handle(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/repo/.wt-demo" }),
    }));
    expect(cleanup.status).toBe(200);
    expect(await json(cleanup)).toEqual({ ok: true, log: ["removed /repo/.wt-demo"] });
    expect(calls).toEqual(["scan", "cleanup:/repo/.wt-demo"]);
  });

  test("worktrees API maps scan, validation, and cleanup failures to errors", async () => {
    const app = apiWith(createWorktreesApi({
      async scanWorktrees() {
        throw new Error("tmux unavailable");
      },
      async cleanupWorktree() {
        throw new Error("cleanup denied");
      },
    }));

    const list = await app.handle(new Request("http://local/api/worktrees"));
    expect(list.status).toBe(500);
    expect(await json(list)).toEqual({ error: "tmux unavailable" });

    const missing = await app.handle(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "" }),
    }));
    expect(missing.status).toBe(400);
    expect(await json(missing)).toEqual({ error: "path required" });

    const cleanup = await app.handle(new Request("http://local/api/worktrees/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/repo/.wt-demo" }),
    }));
    expect(cleanup.status).toBe(500);
    expect(await json(cleanup)).toEqual({ error: "cleanup denied" });
  });

  test("fleet API loads JSON configs and ignores disabled or non-json files", async () => {
    const reads: string[] = [];
    const app = apiWith(createFleetApi({
      fleetDir: "/fleet",
      readdirSync: () => ["m5.json", "disabled.json.disabled", "notes.txt"] as any,
      readFileSync: (path) => {
        reads.push(String(path));
        return JSON.stringify({ node: "m5", windows: [{ name: "mawjs" }] });
      },
      join: (...parts) => parts.join("/"),
    }));

    const res = await app.handle(new Request("http://local/api/fleet-config"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      configs: [{ node: "m5", windows: [{ name: "mawjs" }] }],
    });
    expect(reads).toEqual(["/fleet/m5.json"]);
  });

  test("fleet API returns an empty config list with an error when IO fails", async () => {
    const app = apiWith(createFleetApi({
      fleetDir: "/fleet",
      readdirSync: () => {
        throw new Error("no fleet dir");
      },
      readFileSync: (() => "{}") as any,
      join: (...parts) => parts.join("/"),
    }));

    const res = await app.handle(new Request("http://local/api/fleet-config"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ configs: [], error: "no fleet dir" });
  });

  test("asks API reads missing, invalid, and valid JSON safely", async () => {
    let mode: "missing" | "invalid" | "valid" = "missing";
    const app = apiWith(createAsksApi({
      asksPath: "/asks.json",
      existsSync: () => mode !== "missing",
      readFileSync: () => {
        if (mode === "invalid") return "{";
        return JSON.stringify([{ question: "ship alpha?", answer: "Nat decides" }]);
      },
      writeFileSync: (() => undefined) as any,
    }));

    let res = await app.handle(new Request("http://local/api/asks"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);

    mode = "invalid";
    res = await app.handle(new Request("http://local/api/asks"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);

    mode = "valid";
    res = await app.handle(new Request("http://local/api/asks"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([{ question: "ship alpha?", answer: "Nat decides" }]);
  });

  test("asks API writes JSON payloads and reports write failures", async () => {
    const writes: Array<{ path: string; payload: string }> = [];
    const app = apiWith(createAsksApi({
      asksPath: "/asks.json",
      existsSync: () => false,
      readFileSync: (() => "[]") as any,
      writeFileSync: (path, payload) => {
        writes.push({ path: String(path), payload: String(payload) });
      },
    }));

    const ok = await app.handle(new Request("http://local/api/asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "coverage?", answer: "targeted" }),
    }));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true });
    expect(writes).toEqual([{
      path: "/asks.json",
      payload: '{\n  "question": "coverage?",\n  "answer": "targeted"\n}',
    }]);

    const failing = apiWith(createAsksApi({
      asksPath: "/asks.json",
      existsSync: () => false,
      readFileSync: (() => "[]") as any,
      writeFileSync: () => {
        throw new Error("readonly");
      },
    }));
    const bad = await failing.handle(new Request("http://local/api/asks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "coverage?" }),
    }));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ error: "readonly" });
  });
});
