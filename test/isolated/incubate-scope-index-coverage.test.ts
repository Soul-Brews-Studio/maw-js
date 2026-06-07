import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let incubateCalls: any[] = [];
let incubateThrow: Error | null = null;
let incubateLog = "";
let incubateErrorLog = "";
let resolveModeError: Error | null = null;
let resolveModeValue: "default" | "flash" | "contribute" = "default";

let scopeListValue: any = [{ name: "alpha" }];
let scopeListFormatted = "formatted scopes";
let scopeCreateResult: any = { name: "alpha", members: ["neo", "trinity"] };
let scopeCreateError: Error | null = null;
let scopeShowResult: any = { name: "alpha", members: ["neo"] };
let scopeShowError: Error | null = null;
let scopeDeleteResult = true;
let scopeDeleteError: Error | null = null;

let scopeListCalls = 0;
let scopeCreateCalls: any[] = [];
let scopeShowCalls: string[] = [];
let scopeDeleteCalls: string[] = [];
let scopePathCalls: string[] = [];

const incubateImplPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/incubate/impl.ts");
const scopeImplPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/scope/impl.ts");

mock.module(incubateImplPath, () => ({
  resolveMode: () => {
    if (resolveModeError) throw resolveModeError;
    return resolveModeValue;
  },
  cmdIncubate: async (opts: any) => {
    incubateCalls.push(opts);
    if (incubateLog) console.log(incubateLog);
    if (incubateErrorLog) console.error(incubateErrorLog);
    if (incubateThrow) throw incubateThrow;
  },
}));

mock.module(scopeImplPath, () => ({
  cmdList: () => {
    scopeListCalls++;
    return scopeListValue;
  },
  formatList: (rows: any) => {
    if (rows === "__throw__") throw new Error("format exploded");
    return scopeListFormatted;
  },
  cmdCreate: (opts: any) => {
    scopeCreateCalls.push(opts);
    if (scopeCreateError) throw scopeCreateError;
    return scopeCreateResult;
  },
  scopePath: (name: string) => {
    scopePathCalls.push(name);
    return `/tmp/scopes/${name}.json`;
  },
  cmdShow: (name: string) => {
    scopeShowCalls.push(name);
    if (scopeShowError) throw scopeShowError;
    return scopeShowResult;
  },
  cmdDelete: (name: string) => {
    scopeDeleteCalls.push(name);
    if (scopeDeleteError) throw scopeDeleteError;
    return scopeDeleteResult;
  },
}));

const { default: incubateHandler } = await import("../../src/vendor/mpr-plugins/incubate/index");
const { default: scopeHandler } = await import("../../src/vendor/mpr-plugins/scope/index");

beforeEach(() => {
  incubateCalls = [];
  incubateThrow = null;
  incubateLog = "";
  incubateErrorLog = "";
  resolveModeError = null;
  resolveModeValue = "default";

  scopeListValue = [{ name: "alpha" }];
  scopeListFormatted = "formatted scopes";
  scopeCreateResult = { name: "alpha", members: ["neo", "trinity"] };
  scopeCreateError = null;
  scopeShowResult = { name: "alpha", members: ["neo"] };
  scopeShowError = null;
  scopeDeleteResult = true;
  scopeDeleteError = null;

  scopeListCalls = 0;
  scopeCreateCalls = [];
  scopeShowCalls = [];
  scopeDeleteCalls = [];
  scopePathCalls = [];
});

describe("vendor incubate plugin dispatcher", () => {
  test("returns usage when source is missing or help-like", async () => {
    expect(await incubateHandler({ source: "cli", args: [] } as any)).toEqual({
      ok: false,
      error: expect.stringContaining("usage: maw incubate <source-repo>"),
    });

    expect(await incubateHandler({ source: "cli", args: ["--help"] } as any)).toEqual({
      ok: false,
      error: expect.stringContaining("usage: maw incubate <source-repo>"),
    });
  });

  test("rejects a flag-like source before calling the impl", async () => {
    const result = await incubateHandler({ source: "cli", args: ["--wat"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("\"--wat\" looks like a flag");
    expect(incubateCalls).toHaveLength(0);
  });

  test("surfaces resolveMode errors for conflicting CLI flags", async () => {
    resolveModeError = new Error("pick one mode");

    const result = await incubateHandler({
      source: "cli",
      args: ["github.com/acme/repo", "--flash", "--contribute"],
    } as any);

    expect(result).toEqual({ ok: false, error: "pick one mode" });
    expect(incubateCalls).toHaveLength(0);
  });

  test("passes parsed CLI flags through to cmdIncubate and captures output", async () => {
    resolveModeValue = "flash";
    incubateLog = "incubating";

    const result = await incubateHandler({
      source: "cli",
      args: [
        "github.com/acme/repo",
        "--stem", "sprout",
        "--from", "oracle-a",
        "--org", "Soul-Brews-Studio",
        "--issue", "1637",
        "--note", "hello",
        "--nickname", "Sprout",
        "--fast",
        "--root",
        "--blank",
        "--seed",
        "--split",
        "--dry-run",
        "--signal-on-birth",
        "--trigger", "wake up",
        "--flash",
        "--no-trigger",
      ],
    } as any);

    expect(result).toEqual({ ok: true, output: "incubating" });
    expect(incubateCalls).toEqual([{
      source: "github.com/acme/repo",
      stem: "sprout",
      mode: "flash",
      trigger: "wake up",
      noTrigger: true,
      from: "oracle-a",
      org: "Soul-Brews-Studio",
      issue: 1637,
      note: "hello",
      nickname: "Sprout",
      fast: true,
      root: true,
      blank: true,
      seed: true,
      split: true,
      dryRun: true,
      signalOnBirth: true,
    }]);
  });

  test("validates API args and forwards valid bodies", async () => {
    expect(await incubateHandler({ source: "api", args: {} } as any)).toEqual({
      ok: false,
      error: "source required",
    });

    expect(await incubateHandler({ source: "api", args: { source: "x", mode: "weird" } } as any)).toEqual({
      ok: false,
      error: "invalid mode: weird",
    });

    const ok = await incubateHandler({
      source: "api",
      args: {
        source: "github.com/acme/repo",
        mode: "contribute",
        stem: "bud",
        trigger: "ping",
        noTrigger: true,
        from: "neo",
        org: "Soul-Brews-Studio",
        issue: 7,
        note: "n",
        nickname: "B",
        fast: true,
        root: true,
        blank: true,
        seed: true,
        split: true,
        dryRun: true,
        signalOnBirth: true,
      },
    } as any);

    expect(ok.ok).toBe(true);
    expect(incubateCalls.at(-1)).toEqual({
      source: "github.com/acme/repo",
      stem: "bud",
      mode: "contribute",
      trigger: "ping",
      noTrigger: true,
      from: "neo",
      org: "Soul-Brews-Studio",
      issue: 7,
      note: "n",
      nickname: "B",
      fast: true,
      root: true,
      blank: true,
      seed: true,
      split: true,
      dryRun: true,
      signalOnBirth: true,
    });
  });

  test("prefers captured logs when the impl throws", async () => {
    incubateErrorLog = "captured failure";
    incubateThrow = new Error("raw failure");

    const result = await incubateHandler({
      source: "api",
      args: { source: "github.com/acme/repo" },
    } as any);

    expect(result).toEqual({
      ok: false,
      error: "captured failure",
      output: "captured failure",
    });
  });
});

describe("vendor scope plugin dispatcher", () => {
  test("prints help when no subcommand is provided", async () => {
    const result = await scopeHandler({ source: "cli", args: [] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw scope <list|create|show|delete>");
  });

  test("lists scopes through the impl formatter", async () => {
    const result = await scopeHandler({ source: "cli", args: ["list"] } as any);

    expect(scopeListCalls).toBe(1);
    expect(result).toEqual({ ok: true, output: "formatted scopes" });
  });

  test("validates create usage and reports create success details", async () => {
    expect(await scopeHandler({ source: "cli", args: ["create"] } as any)).toEqual({
      ok: false,
      error: "usage: maw scope create <name> --members <a,b,c> [--lead <m>] [--ttl <iso>]",
    });

    expect(await scopeHandler({ source: "cli", args: ["create", "alpha"] } as any)).toEqual({
      ok: false,
      error: "usage: maw scope create alpha --members <a,b,c> [--lead <m>] [--ttl <iso>]",
    });

    const created = await scopeHandler({
      source: "cli",
      args: ["create", "alpha", "--members", "neo,trinity", "--lead", "neo", "--ttl", "2026-06-01T00:00:00.000Z"],
    } as any);

    expect(scopeCreateCalls).toEqual([{
      name: "alpha",
      members: ["neo", "trinity"],
      lead: "neo",
      ttl: "2026-06-01T00:00:00.000Z",
    }]);
    expect(scopePathCalls).toEqual(["alpha"]);
    expect(created.ok).toBe(true);
    expect(created.output).toContain("created scope \"alpha\" (2 members)");
    expect(created.output).toContain("/tmp/scopes/alpha.json");
  });

  test("shows missing, found, and thrown scope lookups", async () => {
    expect(await scopeHandler({ source: "cli", args: ["show"] } as any)).toEqual({
      ok: false,
      error: "usage: maw scope show <name>",
    });

    scopeShowResult = null;
    const missing = await scopeHandler({ source: "cli", args: ["show", "ghost"] } as any);
    expect(missing).toEqual({
      ok: false,
      error: 'scope "ghost" not found',
      output: "",
    });

    scopeShowResult = { name: "alpha", members: ["neo"] };
    const shown = await scopeHandler({ source: "cli", args: ["info", "alpha"] } as any);
    expect(shown.ok).toBe(true);
    expect(shown.output).toContain('"name": "alpha"');

    scopeShowError = new Error("read failed");
    const failed = await scopeHandler({ source: "cli", args: ["show", "alpha"] } as any);
    expect(failed).toEqual({
      ok: false,
      error: "read failed",
      output: "",
    });
  });

  test("handles delete confirmation, success, and delete errors", async () => {
    expect(await scopeHandler({ source: "cli", args: ["delete"] } as any)).toEqual({
      ok: false,
      error: "usage: maw scope delete <name> [--yes]",
    });

    const confirm = await scopeHandler({ source: "cli", args: ["delete", "alpha"] } as any);
    expect(confirm).toEqual({
      ok: false,
      error: "delete requires --yes",
      output: "refusing to delete scope \"alpha\" without --yes\n  to confirm: maw scope delete alpha --yes",
    });

    const deleted = await scopeHandler({ source: "cli", args: ["rm", "alpha", "--yes"] } as any);
    expect(scopeDeleteCalls.at(-1)).toBe("alpha");
    expect(deleted).toEqual({
      ok: true,
      output: "deleted scope \"alpha\"",
    });

    scopeDeleteError = new Error("unlink failed");
    const failed = await scopeHandler({ source: "cli", args: ["remove", "beta", "--yes"] } as any);
    expect(failed).toEqual({
      ok: false,
      error: "unlink failed",
      output: "",
    });
  });

  test("prints help for unknown subcommands", async () => {
    const result = await scopeHandler({ source: "cli", args: ["wat"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('maw scope: unknown subcommand "wat" (expected list|create|show|delete)');
    expect(result.output).toContain("usage: maw scope <list|create|show|delete>");
  });
});
