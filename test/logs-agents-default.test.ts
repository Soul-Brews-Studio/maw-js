import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  agentFromDir,
  countLines,
  findJsonlFiles,
} from "../src/api/logs-helpers";
import { createLogsAgentsApi } from "../src/api/logs-agents";

async function json(res: Response): Promise<any> {
  return await res.json();
}

function appWith(projectsDir: string) {
  return new Elysia({ prefix: "/api" }).use(createLogsAgentsApi({
    projectsDir,
    existsSync: () => true,
    readdirSync,
    statSync,
    join,
    agentFromDir,
    findJsonlFiles,
    countLines,
  }));
}

describe("logs helpers default-suite coverage", () => {
  test("agentFromDir strips known org prefixes and falls back to the last two path tokens", () => {
    expect(agentFromDir("-opt-Code-github-com-Soul-Brews-Studio-mawjs-oracle"))
      .toBe("mawjs-oracle");
    expect(agentFromDir("-Users-nat-Code-laris-co-pulse-oracle"))
      .toBe("pulse-oracle");
    expect(agentFromDir("-tmp-random-deep-custom-agent"))
      .toBe("custom-agent");
  });

  test("findJsonlFiles finds root and one-level nested JSONL files and ignores inaccessible paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-logs-helpers-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "root.jsonl"), "{}\n");
      writeFileSync(join(dir, "sub", "child.jsonl"), "{}\n");
      writeFileSync(join(dir, "ignore.txt"), "nope");

      expect(findJsonlFiles(dir).sort()).toEqual([
        join(dir, "root.jsonl"),
        join(dir, "sub", "child.jsonl"),
      ].sort());
      expect(findJsonlFiles(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("countLines counts non-empty lines and returns zero for unreadable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-logs-count-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "one\n\ntwo\n");
      expect(countLines(file)).toBe(2);
      expect(countLines(join(dir, "missing.jsonl"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("logs agents API default-suite coverage", () => {
  test("default logs agents router factory is constructible", () => {
    expect(createLogsAgentsApi()).toBeInstanceOf(Elysia);
  });

  test("returns empty when the projects directory is missing or unreadable", async () => {
    const missing = new Elysia({ prefix: "/api" }).use(createLogsAgentsApi({
      projectsDir: "/missing",
      existsSync: () => false,
      readdirSync,
      statSync,
      join,
      agentFromDir,
      findJsonlFiles,
      countLines,
    }));
    let res = await missing.handle(new Request("http://local/api/logs/agents"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ agents: [], total: 0 });

    const unreadable = new Elysia({ prefix: "/api" }).use(createLogsAgentsApi({
      projectsDir: "/throws",
      existsSync: () => true,
      readdirSync: (() => { throw new Error("denied"); }) as any,
      statSync,
      join,
      agentFromDir,
      findJsonlFiles,
      countLines,
    }));
    res = await unreadable.handle(new Request("http://local/api/logs/agents"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ agents: [], total: 0 });
  });

  test("aggregates files and line counts by agent, sorted by latest mtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-logs-agents-"));
    try {
      const mawjsDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-oracle");
      const issuerDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-mawjs-issuer");
      const emptyDir = join(dir, "-opt-Code-github-com-Soul-Brews-Studio-empty-oracle");
      mkdirSync(mawjsDir);
      mkdirSync(join(mawjsDir, "subagents"));
      mkdirSync(issuerDir);
      mkdirSync(emptyDir);
      writeFileSync(join(dir, "not-a-dir"), "skip");

      const oldFile = join(mawjsDir, "old.jsonl");
      const newFile = join(mawjsDir, "subagents", "new.jsonl");
      const issuerFile = join(issuerDir, "issuer.jsonl");
      writeFileSync(oldFile, "{}\n\n{}\n");
      writeFileSync(newFile, "{}\n");
      writeFileSync(issuerFile, "{}\n");
      utimesSync(oldFile, new Date("2026-05-17T00:00:00.000Z"), new Date("2026-05-17T00:00:00.000Z"));
      utimesSync(newFile, new Date("2026-05-17T00:02:00.000Z"), new Date("2026-05-17T00:02:00.000Z"));
      utimesSync(issuerFile, new Date("2026-05-17T00:01:00.000Z"), new Date("2026-05-17T00:01:00.000Z"));

      const res = await appWith(dir).handle(new Request("http://local/api/logs/agents"));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.total).toBe(2);
      expect(body.agents).toEqual([
        {
          name: "mawjs-oracle",
          files: 2,
          lines: 3,
          lastModified: "2026-05-17T00:02:00.000Z",
        },
        {
          name: "mawjs-issuer",
          files: 1,
          lines: 1,
          lastModified: "2026-05-17T00:01:00.000Z",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps entries with deleted-file mtime failures at the end", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createLogsAgentsApi({
      projectsDir: "/projects",
      existsSync: () => true,
      readdirSync: (() => ["broken-dir", "agent-a", "agent-b"]) as any,
      statSync: ((path: string) => {
        if (path === "/projects/broken-dir") throw new Error("stat failed");
        if (path === "/projects/agent-a" || path === "/projects/agent-b") {
          return { isDirectory: () => true } as any;
        }
        if (path.endsWith("agent-a/one.jsonl")) {
          return { mtime: new Date("2026-05-17T00:00:00.000Z") } as any;
        }
        throw new Error("deleted");
      }) as any,
      join: (...parts) => parts.join("/"),
      agentFromDir: (name) => name,
      findJsonlFiles: (dirPath) => [`${dirPath}/one.jsonl`],
      countLines: () => 1,
    }));

    const res = await app.handle(new Request("http://local/api/logs/agents"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      total: 2,
      agents: [
        { name: "agent-a", files: 1, lines: 1, lastModified: "2026-05-17T00:00:00.000Z" },
        { name: "agent-b", files: 1, lines: 1, lastModified: null },
      ],
    });
  });

  test("keeps the newest lastModified when multiple project dirs map to one agent", async () => {
    const app = new Elysia({ prefix: "/api" }).use(createLogsAgentsApi({
      projectsDir: "/projects",
      existsSync: () => true,
      readdirSync: (() => ["same-agent-new", "same-agent-old"]) as any,
      statSync: ((path: string) => {
        if (path === "/projects/same-agent-new" || path === "/projects/same-agent-old") {
          return { isDirectory: () => true } as any;
        }
        if (path.endsWith("same-agent-new/one.jsonl")) {
          return { mtime: new Date("2026-05-17T00:02:00.000Z") } as any;
        }
        return { mtime: new Date("2026-05-17T00:01:00.000Z") } as any;
      }) as any,
      join: (...parts) => parts.join("/"),
      agentFromDir: () => "same-agent",
      findJsonlFiles: (dirPath) => [`${dirPath}/one.jsonl`],
      countLines: () => 1,
    }));

    const res = await app.handle(new Request("http://local/api/logs/agents"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      total: 1,
      agents: [
        { name: "same-agent", files: 2, lines: 2, lastModified: "2026-05-17T00:02:00.000Z" },
      ],
    });
  });
});
