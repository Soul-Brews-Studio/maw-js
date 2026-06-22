import { describe, expect, test } from "bun:test";
import {
  heyArgs,
  replyArgs,
  inboxArgs,
  lsArgs,
  companyArgs,
  deptArgs,
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
