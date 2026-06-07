import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createTeamsApi } from "../src/api/teams";

function apiWith(options: {
  teams?: unknown[];
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  scanThrows?: boolean;
} = {}) {
  const home = "/home/test";
  const reads: string[] = [];
  const app = new Elysia({ prefix: "/api" }).use(createTeamsApi({
    scanTeams: async () => {
      if (options.scanThrows) throw new Error("scan failed");
      return (options.teams ?? []) as any;
    },
    homedir: () => home,
    join: (...parts: string[]) => parts.join("/"),
    readdirSync: ((path: string) => {
      const entries = options.dirs?.[path];
      if (!entries) throw new Error(`missing dir ${path}`);
      return entries;
    }) as any,
    readFileSync: ((path: string) => {
      reads.push(path);
      const value = options.files?.[path];
      if (value === undefined) throw new Error(`missing file ${path}`);
      return value;
    }) as any,
  }));
  return { app, home, reads };
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

describe("teams API default-suite coverage", () => {
  test("default router factory is constructible", () => {
    expect(createTeamsApi()).toBeInstanceOf(Elysia);
  });

  test("lists scanned teams with total", async () => {
    const teams = [{ name: "alpha" }, { name: "beta" }];
    const { app } = apiWith({ teams });

    const res = await app.handle(new Request("http://local/api/teams"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ teams, total: 2 });
  });

  test("loads a team config from the home directory", async () => {
    const { app, reads } = apiWith({
      files: {
        "/home/test/.claude/teams/ops/config.json": JSON.stringify({ name: "ops", members: ["neo"] }),
      },
    });

    const res = await app.handle(new Request("http://local/api/teams/ops"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ name: "ops", members: ["neo"] });
    expect(reads).toEqual(["/home/test/.claude/teams/ops/config.json"]);
  });

  test("missing or malformed team config returns 404", async () => {
    const missing = apiWith();
    let res = await missing.app.handle(new Request("http://local/api/teams/ghost"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "team not found" });

    const malformed = apiWith({
      files: { "/home/test/.claude/teams/bad/config.json": "{bad json" },
    });
    res = await malformed.app.handle(new Request("http://local/api/teams/bad"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "team not found" });
  });

  test("lists JSON tasks, skips malformed task files, and ignores non-JSON files", async () => {
    const { app, reads } = apiWith({
      dirs: {
        "/home/test/.claude/tasks/ops": ["001.json", "notes.txt", "bad.json", "002.json"],
      },
      files: {
        "/home/test/.claude/tasks/ops/001.json": JSON.stringify({ id: 1, title: "first" }),
        "/home/test/.claude/tasks/ops/bad.json": "not json",
        "/home/test/.claude/tasks/ops/002.json": JSON.stringify({ id: 2, title: "second" }),
      },
    });

    const res = await app.handle(new Request("http://local/api/teams/ops/tasks"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      tasks: [{ id: 1, title: "first" }, { id: 2, title: "second" }],
      total: 2,
    });
    expect(reads).toEqual([
      "/home/test/.claude/tasks/ops/001.json",
      "/home/test/.claude/tasks/ops/bad.json",
      "/home/test/.claude/tasks/ops/002.json",
    ]);
  });

  test("missing tasks directory returns an empty task list", async () => {
    const { app } = apiWith();

    const res = await app.handle(new Request("http://local/api/teams/ghost/tasks"));

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ tasks: [], total: 0 });
  });
});
