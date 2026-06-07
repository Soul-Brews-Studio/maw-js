import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogsApi } from "../src/api/logs";
import { agentFromDir, findJsonlFiles } from "../src/api/logs-helpers";

async function json(res: Response): Promise<any> {
  return await res.json();
}

function cfgLimit(name: string): number {
  if (name === "logsDefault") return 3;
  if (name === "logsMax") return 3;
  if (name === "logsTruncate") return 5;
  return 10;
}

function logsApp(projectsDir: string) {
  return new Elysia({ prefix: "/api" }).use(createLogsApi({
    projectsDir,
    cfgLimit: cfgLimit as any,
    existsSync: () => true,
    readdirSync,
    readFileSync,
    statSync,
    join,
    agentFromDir,
    findJsonlFiles,
    logsAgentsApi: new Elysia(),
  }));
}

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe("logs API default-suite coverage", () => {
  test("default logs router factory is constructible", () => {
    expect(createLogsApi()).toBeInstanceOf(Elysia);
  });

  test("returns empty when projects dir is missing or unreadable", async () => {
    const missing = new Elysia({ prefix: "/api" }).use(createLogsApi({
      projectsDir: "/missing",
      cfgLimit: cfgLimit as any,
      existsSync: () => false,
      readdirSync,
      readFileSync,
      statSync,
      join,
      agentFromDir,
      findJsonlFiles,
      logsAgentsApi: new Elysia(),
    }));
    let res = await missing.handle(new Request("http://local/api/logs"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ entries: [], total: 0 });

    const unreadable = new Elysia({ prefix: "/api" }).use(createLogsApi({
      projectsDir: "/throws",
      cfgLimit: cfgLimit as any,
      existsSync: () => true,
      readdirSync: (() => { throw new Error("denied"); }) as any,
      readFileSync,
      statSync,
      join,
      agentFromDir,
      findJsonlFiles,
      logsAgentsApi: new Elysia(),
    }));
    res = await unreadable.handle(new Request("http://local/api/logs"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ entries: [], total: 0 });
  });

  test("parses user and assistant entries, skips snapshots/malformed lines, sorts newest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-logs-api-"));
    try {
      const mawjsDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-oracle");
      const issuerDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-issuer");
      mkdirSync(mawjsDir);
      mkdirSync(issuerDir);
      writeFileSync(join(dir, "not-a-dir"), "skip");

      writeFileSync(join(mawjsDir, "session.jsonl"), [
        line({
          sessionId: "s1",
          type: "message",
          timestamp: "2026-05-17T00:01:00.000Z",
          gitBranch: "alpha",
          message: { role: "user", content: "hello world" },
        }),
        line({
          sessionId: "s1",
          type: "message",
          timestamp: "2026-05-17T00:02:00.000Z",
          message: { role: "assistant", content: [{ type: "tool_use" }] },
        }),
        line({
          sessionId: "s1",
          type: "file-history-snapshot",
          timestamp: "2026-05-17T00:03:00.000Z",
        }),
        "{bad json",
        line({
          sessionId: "s1",
          type: "message",
          timestamp: "2026-05-17T00:04:00.000Z",
          message: { role: "assistant", content: "assist reply" },
        }),
      ].join("\n") + "\n");

      writeFileSync(join(issuerDir, "issuer.jsonl"), [
        line({
          sessionId: "s2",
          type: "event",
          timestamp: null,
          message: { role: "user", content: ["structured"] },
        }),
      ].join("\n") + "\n");

      const res = await logsApp(dir).handle(new Request("http://local/api/logs?limit=999"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        total: 3,
        entries: [
          {
            agent: "mawjs-oracle",
            sessionId: "s1",
            type: "message",
            timestamp: "2026-05-17T00:04:00.000Z",
            gitBranch: null,
            message: { role: "assistant", content: "assis" },
          },
          {
            agent: "mawjs-oracle",
            sessionId: "s1",
            type: "message",
            timestamp: "2026-05-17T00:02:00.000Z",
            gitBranch: null,
            message: { role: "assistant", content: "[tool_use/text blocks]" },
          },
          {
            agent: "mawjs-issuer",
            sessionId: "s2",
            type: "event",
            timestamp: null,
            gitBranch: null,
            message: { role: "user", content: "[structured]" },
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent and query filters narrow the scan and invalid limit falls back to default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-logs-filter-"));
    try {
      const mawjsDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-oracle");
      const issuerDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-issuer");
      mkdirSync(mawjsDir);
      mkdirSync(issuerDir);
      writeFileSync(join(mawjsDir, "session.jsonl"), line({
        sessionId: "s1",
        type: "message",
        timestamp: "2026-05-17T00:01:00.000Z",
        message: { role: "user", content: "no match" },
      }) + "\n");
      writeFileSync(join(issuerDir, "issuer.jsonl"), line({
        sessionId: "s2",
        type: "message",
        timestamp: "2026-05-17T00:02:00.000Z",
        message: { role: "user", content: "needle found" },
      }) + "\n");

      const res = await logsApp(dir).handle(new Request("http://local/api/logs?agent=issuer&q=NEEDLE&limit=bad"));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.total).toBe(1);
      expect(body.entries[0]).toMatchObject({
        agent: "mawjs-issuer",
        sessionId: "s2",
        message: { role: "user", content: "needl" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("continues past stat and read failures", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createLogsApi({
      projectsDir: "/projects",
      cfgLimit: cfgLimit as any,
      existsSync: () => true,
      readdirSync: (() => ["broken-dir", "agent-a"]) as any,
      readFileSync: (() => { throw new Error("deleted"); }) as any,
      statSync: ((path: string) => {
        if (path === "/projects/broken-dir") throw new Error("stat failed");
        return { isDirectory: () => true } as any;
      }) as any,
      join: (...parts) => parts.join("/"),
      agentFromDir: (name) => name,
      findJsonlFiles: (dirPath) => [`${dirPath}/missing.jsonl`],
      logsAgentsApi: new Elysia(),
    }));

    const res = await app.handle(new Request("http://local/api/logs"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ entries: [], total: 0 });
  });
});
