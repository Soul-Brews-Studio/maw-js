import { describe, expect, test } from "bun:test";
import {
  heyArgs,
  replyArgs,
  inboxArgs,
  lsArgs,
  companyArgs,
  deptArgs,
  taskArgs,
  runMaw,
  toMcpResult,
  type SpawnFn,
  type SpawnedProc,
} from "../src/vendor/mpr-plugins/mcp/tools";

// ── pure argv mappers ───────────────────────────────────────────────────────

describe("argv mappers", () => {
  test("heyArgs", () => {
    expect(heyArgs("monkut", "hello there")).toEqual(["hey", "monkut", "hello there"]);
  });

  test("replyArgs", () => {
    expect(replyArgs("req-1-abc", "done")).toEqual(["reply", "req-1-abc", "done"]);
  });

  test("inboxArgs status", () => {
    expect(inboxArgs("status")).toEqual(["inbox", "status"]);
  });

  test("inboxArgs list", () => {
    expect(inboxArgs("list")).toEqual(["inbox", "list"]);
  });

  test("inboxArgs read + id", () => {
    expect(inboxArgs("read", "42")).toEqual(["inbox", "read", "42"]);
  });

  test("inboxArgs read without id throws", () => {
    expect(() => inboxArgs("read")).toThrow();
  });

  test("lsArgs verbose false", () => {
    expect(lsArgs(false)).toEqual(["ls"]);
    expect(lsArgs()).toEqual(["ls"]);
  });

  test("lsArgs verbose true", () => {
    expect(lsArgs(true)).toEqual(["ls", "-v"]);
  });

  test("companyArgs ls", () => {
    expect(companyArgs({ action: "ls" })).toEqual(["company", "ls"]);
  });

  test("companyArgs tree (no company)", () => {
    expect(companyArgs({ action: "tree" })).toEqual(["company", "tree"]);
  });

  test("companyArgs tree + company", () => {
    expect(companyArgs({ action: "tree", company: "acme" })).toEqual(["company", "tree", "acme"]);
  });

  test("companyArgs attach", () => {
    expect(companyArgs({ action: "attach", company: "acme", dept: "eng" })).toEqual([
      "company",
      "attach",
      "acme",
      "eng",
    ]);
  });

  test("companyArgs attach missing args throws", () => {
    expect(() => companyArgs({ action: "attach", company: "acme" })).toThrow();
  });

  test("deptArgs assign + role", () => {
    expect(
      deptArgs({ action: "assign", company: "acme", dept: "eng", oracle: "patchwork", role: "lead" }),
    ).toEqual(["dept", "assign", "acme", "eng", "patchwork", "--role", "lead"]);
  });

  test("deptArgs assign no role", () => {
    expect(deptArgs({ action: "assign", company: "acme", dept: "eng", oracle: "patchwork" })).toEqual([
      "dept",
      "assign",
      "acme",
      "eng",
      "patchwork",
    ]);
  });

  test("deptArgs members", () => {
    expect(deptArgs({ action: "members", company: "acme", dept: "eng" })).toEqual([
      "dept",
      "members",
      "acme",
      "eng",
    ]);
  });

  test("deptArgs learn", () => {
    expect(deptArgs({ action: "learn", company: "acme", dept: "eng", text: "redis is at :6379" })).toEqual([
      "dept",
      "learn",
      "acme",
      "eng",
      "redis is at :6379",
    ]);
  });

  test("deptArgs knowledge + query", () => {
    expect(deptArgs({ action: "knowledge", company: "acme", dept: "eng", text: "redis" })).toEqual([
      "dept",
      "knowledge",
      "acme",
      "eng",
      "redis",
    ]);
  });

  test("deptArgs knowledge no query", () => {
    expect(deptArgs({ action: "knowledge", company: "acme", dept: "eng" })).toEqual([
      "dept",
      "knowledge",
      "acme",
      "eng",
    ]);
  });
});

// ── task board argv mappers (kobo-21) — 1:1 with the CLI ─────────────────────

describe("taskArgs", () => {
  test("add: title only", () => {
    expect(taskArgs({ action: "add", title: "fix login" })).toEqual(["company", "task", "add", "fix login"]);
  });

  test("add: all flags in CLI order + common company/from", () => {
    expect(
      taskArgs({
        action: "add",
        title: "big work",
        repo: "acme/app",
        dept: "eng",
        epic: "auth",
        assignee: "patchwork",
        parent: ["kobo-1", "kobo-2"],
        body: "- [ ] step",
        company: "kobo",
        from: "eq3",
      }),
    ).toEqual([
      "company", "task", "add", "big work",
      "--repo", "acme/app",
      "--dept", "eng",
      "--epic", "auth",
      "--assignee", "patchwork",
      "--parent", "kobo-1",
      "--parent", "kobo-2",
      "--body", "- [ ] step",
      "--company", "kobo",
      "--from", "eq3",
    ]);
  });

  test("add: missing title throws", () => {
    expect(() => taskArgs({ action: "add" })).toThrow(/title/);
  });

  test("add: --state backlog (kobo-70) is passed through", () => {
    expect(taskArgs({ action: "add", title: "later", state: "backlog" }))
      .toEqual(["company", "task", "add", "later", "--state", "backlog"]);
  });

  test("move: id + state → company task move argv (kobo-70)", () => {
    expect(taskArgs({ action: "move", id: "kobo-5", state: "backlog", company: "kobo" }))
      .toEqual(["company", "task", "move", "kobo-5", "backlog", "--company", "kobo"]);
    expect(() => taskArgs({ action: "move", state: "todo" })).toThrow(/id/);
    expect(() => taskArgs({ action: "move", id: "kobo-5" })).toThrow(/state/);
  });

  test("ls: bare", () => {
    expect(taskArgs({ action: "ls" })).toEqual(["company", "task", "ls"]);
  });

  test("ls: --mine + --for + --company (mine is a bare flag)", () => {
    expect(taskArgs({ action: "ls", company: "kobo", mine: true, for: "tony" })).toEqual([
      "company", "task", "ls", "--company", "kobo", "--mine", "--for", "tony",
    ]);
  });

  test("start / claim / done / unblock take an id + common flags", () => {
    expect(taskArgs({ action: "start", id: "kobo-3" })).toEqual(["company", "task", "start", "kobo-3"]);
    expect(taskArgs({ action: "claim", id: "kobo-3", from: "eq3" })).toEqual(["company", "task", "claim", "kobo-3", "--from", "eq3"]);
    expect(taskArgs({ action: "done", id: "kobo-3" })).toEqual(["company", "task", "done", "kobo-3"]);
    expect(taskArgs({ action: "unblock", id: "kobo-3" })).toEqual(["company", "task", "unblock", "kobo-3"]);
  });

  test("id-required verbs throw without an id", () => {
    for (const action of ["start", "claim", "done", "unblock", "review", "pr", "block"] as const) {
      expect(() => taskArgs({ action })).toThrow(/requires an id/);
    }
  });

  test("review: id + optional --to/--reason", () => {
    expect(taskArgs({ action: "review", id: "kobo-3", to: "eq3", reason: "check auth" })).toEqual([
      "company", "task", "review", "kobo-3", "--to", "eq3", "--reason", "check auth",
    ]);
    expect(taskArgs({ action: "review", id: "kobo-3" })).toEqual(["company", "task", "review", "kobo-3"]);
  });

  test("pr: id + pr number (stringified)", () => {
    expect(taskArgs({ action: "pr", id: "kobo-3", pr: 66 })).toEqual(["company", "task", "pr", "kobo-3", "66"]);
  });

  test("pr: missing pr number throws", () => {
    expect(() => taskArgs({ action: "pr", id: "kobo-3" })).toThrow(/pr number/);
  });

  test("block: id + required --kind + optional --reason/--for", () => {
    expect(taskArgs({ action: "block", id: "kobo-3", kind: "dependency", reason: "waits #66", for: "tony" })).toEqual([
      "company", "task", "block", "kobo-3", "--kind", "dependency", "--reason", "waits #66", "--for", "tony",
    ]);
  });

  test("block: missing kind throws", () => {
    expect(() => taskArgs({ action: "block", id: "kobo-3" })).toThrow(/kind/);
  });

  test("dep: op add/rm + id + exactly one parent (kobo-134)", () => {
    expect(taskArgs({ action: "dep", id: "kobo-3", op: "add", parent: ["kobo-1"] })).toEqual([
      "company", "task", "dep", "add", "kobo-3", "kobo-1",
    ]);
    expect(taskArgs({ action: "dep", id: "kobo-3", op: "rm", parent: ["kobo-1"], company: "kobo" })).toEqual([
      "company", "task", "dep", "rm", "kobo-3", "kobo-1", "--company", "kobo",
    ]);
  });

  test("dep: missing/invalid op, missing id, and not-exactly-one parent all throw", () => {
    expect(() => taskArgs({ action: "dep", op: "add", parent: ["kobo-1"] })).toThrow(/requires an id/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", parent: ["kobo-1"] })).toThrow(/op/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "bogus", parent: ["kobo-1"] })).toThrow(/op/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "add" })).toThrow(/exactly one parent/);
    expect(() => taskArgs({ action: "dep", id: "kobo-3", op: "add", parent: ["a", "b"] })).toThrow(/exactly one parent/);
  });

  test("archive: bare + --days + --company", () => {
    expect(taskArgs({ action: "archive" })).toEqual(["company", "task", "archive"]);
    expect(taskArgs({ action: "archive", days: 7, company: "kobo" })).toEqual([
      "company", "task", "archive", "--company", "kobo", "--days", "7",
    ]);
  });

  test("archive: per-card by id (kobo-35) — id is positional, precedes --days", () => {
    expect(taskArgs({ action: "archive", id: "kobo-35" })).toEqual([
      "company", "task", "archive", "kobo-35",
    ]);
    expect(taskArgs({ action: "archive", id: "kobo-35", company: "kobo", from: "tony" })).toEqual([
      "company", "task", "archive", "kobo-35", "--company", "kobo", "--from", "tony",
    ]);
    // id wins over --days: per-card archive is unambiguous, the sweep flag is ignored
    expect(taskArgs({ action: "archive", id: "kobo-35", days: 7 })).toEqual([
      "company", "task", "archive", "kobo-35",
    ]);
  });
});

// ── runMaw result mapping (injected fake spawn) ──────────────────────────────

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

function fakeSpawn(opts: { code: number; stdout?: string; stderr?: string }): {
  fn: SpawnFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: SpawnFn = (cmd) => {
    calls.push(cmd);
    return {
      stdout: streamOf(opts.stdout ?? ""),
      stderr: streamOf(opts.stderr ?? ""),
      exited: Promise.resolve(opts.code),
    } satisfies SpawnedProc;
  };
  return { fn, calls };
}

describe("runMaw", () => {
  test("exit 0 → ok result with stdout, and prepends 'maw' to argv", async () => {
    const { fn, calls } = fakeSpawn({ code: 0, stdout: "hello\n" });
    const r = await runMaw(["ls"], fn);
    expect(r).toEqual({ ok: true, stdout: "hello\n", stderr: "" });
    expect(calls[0]).toEqual(["maw", "ls"]);

    const mcp = toMcpResult(r);
    expect(mcp.isError).toBeUndefined();
    expect(mcp.content[0].text).toBe("hello\n");
  });

  test("ok with empty stdout → '(ok)'", async () => {
    const { fn } = fakeSpawn({ code: 0, stdout: "" });
    const mcp = toMcpResult(await runMaw(["ls"], fn));
    expect(mcp.content[0].text).toBe("(ok)");
    expect(mcp.isError).toBeUndefined();
  });

  test("non-zero exit → isError with stderr", async () => {
    const { fn } = fakeSpawn({ code: 1, stdout: "", stderr: "boom\n" });
    const r = await runMaw(["reply", "x", "y"], fn);
    expect(r.ok).toBe(false);
    const mcp = toMcpResult(r);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toBe("boom\n");
  });

  test("injected spawn throwing → isError, no crash", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("maw: command not found");
    };
    const r = await runMaw(["ls"], throwingSpawn);
    expect(r.ok).toBe(false);
    const mcp = toMcpResult(r);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain("maw: command not found");
  });
});
