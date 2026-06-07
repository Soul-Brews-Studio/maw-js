import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createCostsApi, type CostsApiDeps } from "../src/api/costs";

function json(res: Response): Promise<any> {
  return res.json();
}

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function assistantLine(model: string | undefined, timestamp: string, usage: Record<string, number>) {
  return line({
    type: "assistant",
    timestamp,
    message: {
      model,
      usage,
    },
  });
}

function appWithFiles(files: Record<string, string>, dirs = Object.keys(files).map((path) => path.split("/")[2])) {
  const projectsDir = "/projects";
  const dirEntries = [...new Set(dirs)];
  const deps: CostsApiDeps = {
    projectsDir,
    join: (...parts) => parts.join("/"),
    readdirSync: ((path: string) => {
      if (path === projectsDir) return dirEntries;
      if (path.endsWith("/dir-throws")) throw new Error("dir vanished");
      return Object.keys(files)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1));
    }) as CostsApiDeps["readdirSync"],
    readFileSync: ((path: string) => {
      if (path.endsWith("/read-throws.jsonl")) throw new Error("read failed");
      return files[path] ?? "";
    }) as CostsApiDeps["readFileSync"],
    statSync: ((path: string) => {
      if (path.endsWith("/stat-throws")) throw new Error("stat failed");
      return { isDirectory: () => !path.endsWith("/not-a-dir") } as any;
    }) as CostsApiDeps["statSync"],
  };
  return new Elysia().use(createCostsApi(deps));
}

describe("costs API default-suite coverage", () => {
  test("default router factory is constructible", () => {
    expect(createCostsApi()).toBeInstanceOf(Elysia);
  });

  test("returns validation and project-read errors", async () => {
    const unreadable = new Elysia().use(createCostsApi({
      projectsDir: "/missing",
      join: (...parts) => parts.join("/"),
      readdirSync: (() => { throw new Error("denied"); }) as CostsApiDeps["readdirSync"],
      readFileSync: (() => "") as CostsApiDeps["readFileSync"],
      statSync: (() => ({ isDirectory: () => true })) as CostsApiDeps["statSync"],
    }));

    let res = await unreadable.handle(new Request("http://local/costs/daily?days=0"));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "days must be 1–365" });

    res = await unreadable.handle(new Request("http://local/costs/daily"));
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "Cannot read ~/.claude/projects/" });

    res = await unreadable.handle(new Request("http://local/costs"));
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: "Cannot read ~/.claude/projects/" });
  });

  test("aggregates costs and daily buckets while skipping malformed and unreadable entries", async () => {
    const today = new Date().toISOString();
    const old = "1970-01-01T00:00:00.000Z";
    const files = {
      "/projects/-home-nat-Code-github-com-laris-co-neo-oracle/opus.jsonl": [
        "{bad json",
        line({ type: "user", message: { content: "ignore" } }),
        line({ type: "assistant", message: {} }),
        assistantLine("claude-opus", today, {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ].join("\n"),
      "/projects/-tmp-random-custom-agent/haiku.jsonl": assistantLine("claude-haiku", today, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
      "/projects/-tmp-random-sonnet-agent/sonnet.jsonl": assistantLine("claude-sonnet", today, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
      "/projects/-tmp-random-default-agent/default.jsonl": assistantLine("unknown-model", today, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
      "/projects/-tmp-random-old-agent/old.jsonl": assistantLine("claude-opus", old, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
      "/projects/-tmp-random-empty-agent/empty.jsonl": line({ type: "assistant", message: {} }),
      "/projects/-tmp-random-no-time-agent/no-time.jsonl": line({
        type: "assistant",
        message: { model: "claude-opus", usage: { input_tokens: 1_000_000 } },
      }),
      "/projects/-tmp-random-read-bad/read-throws.jsonl": "unreadable",
    };
    const app = appWithFiles(files, [
      "-home-nat-Code-github-com-laris-co-neo-oracle",
      "-tmp-random-custom-agent",
      "-tmp-random-sonnet-agent",
      "-tmp-random-default-agent",
      "-tmp-random-old-agent",
      "-tmp-random-empty-agent",
      "-tmp-random-no-time-agent",
      "-tmp-random-read-bad",
      "dir-throws",
      "stat-throws",
      "not-a-dir",
    ]);

    let res = await app.handle(new Request("http://local/costs"));
    expect(res.status).toBe(200);
    const aggregate = await json(res);
    const byName = Object.fromEntries(aggregate.agents.map((agent: any) => [agent.name, agent]));
    expect(byName["laris-co-neo-oracle"]).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      sessions: 1,
      turns: 1,
      models: { opus: 1 },
      lastActive: today,
    });
    expect(byName["custom-agent"].models).toEqual({ haiku: 1 });
    expect(byName["sonnet-agent"].models).toEqual({ sonnet: 1 });
    expect(byName["default-agent"].models).toEqual({ sonnet: 1 });
    expect(aggregate.total.agents).toBe(6);
    expect(aggregate.total.sessions).toBe(6);
    expect(aggregate.total.tokens).toBe(11_000_000);
    expect(aggregate.agents[0].name).toBe("laris-co-neo-oracle");

    res = await app.handle(new Request("http://local/costs/daily?days=1"));
    expect(res.status).toBe(200);
    const daily = await json(res);
    expect(daily.window).toBe(1);
    const dailyByName = Object.fromEntries(daily.agents.map((agent: any) => [agent.name, agent]));
    expect(dailyByName["laris-co-neo-oracle"].dailyCosts[0]).toBeCloseTo(90);
    expect(dailyByName["laris-co-neo-oracle"].hadActivity).toEqual([true]);
    expect(dailyByName["old-agent"]).toBeUndefined();
    expect(daily.total.agents).toBe(4);
  });
});
