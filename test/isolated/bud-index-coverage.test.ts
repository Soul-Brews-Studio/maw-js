import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

const budCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];
const fromRepoCalls: Array<Record<string, unknown>> = [];

mock.module(join(root, "src/vendor/mpr-plugins/bud/impl"), () => ({
  cmdBud: async (name: string, opts: Record<string, unknown>) => {
    budCalls.push({ name, opts });
    if (name === "loggy") console.log("bud log", opts.note);
    if (name === "noisy-fail") {
      console.error("before fail");
      throw new Error("boom after log");
    }
    if (name === "plain-fail") throw new Error("plain boom");
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/from-repo"), () => ({
  looksLikeUrl: (target: string) => target.startsWith("http://")
    || target.startsWith("https://")
    || target.startsWith("git@")
    || /^[^./][^/]+\/[^/]+$/.test(target),
  cmdBudFromRepo: async (opts: Record<string, unknown>) => {
    fromRepoCalls.push(opts);
    console.log("from-repo", opts.target, opts.stem);
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/bud/index");

beforeEach(() => {
  budCalls.length = 0;
  fromRepoCalls.length = 0;
});

describe("bud plugin index coverage", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "bud",
      description: "Create a new oracle (bud from parent)",
    });
  });

  test("CLI help and flag-looking names return usage errors without invoking bud", async () => {
    const missing = await handler({ source: "cli", args: [] });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("usage: maw bud <name>");

    const help = await handler({ source: "cli", args: ["--help"] });
    expect(help.ok).toBe(false);
    expect(help.error).toContain("maw bud --from-repo");

    const flagName = await handler({ source: "cli", args: ["--not-a-name"] });
    expect(flagName.ok).toBe(false);
    expect(flagName.error).toContain("looks like a flag");
    expect(budCalls).toEqual([]);
  });

  test("CLI normal bud parses every forwarded option and captures console output", async () => {
    const result = await handler({
      source: "cli",
      args: [
        "loggy",
        "--from", "parent",
        "--repo", "org/loggy-oracle",
        "--org", "Org",
        "--issue", "42",
        "--note", "hello",
        "--nickname", "Loggy",
        "--fast",
        "--root",
        "--dry-run",
        "--split",
        "--scaffold-only",
        "--seed",
        "--blank",
        "--signal-on-birth",
      ],
    });

    expect(result).toEqual({ ok: true, output: "bud log hello" });
    expect(budCalls).toEqual([{ name: "loggy", opts: {
      from: "parent",
      repo: "org/loggy-oracle",
      org: "Org",
      issue: 42,
      note: "hello",
      nickname: "Loggy",
      fast: true,
      root: true,
      dryRun: true,
      split: true,
      scaffoldOnly: true,
      seed: true,
      blank: true,
      signalOnBirth: true,
    } }]);
  });

  test("writer receives CLI output instead of returning captured output", async () => {
    const written: string[] = [];
    const result = await handler({
      source: "cli",
      args: ["loggy", "--note", "writer-path"],
      writer: (...args: unknown[]) => written.push(args.map(String).join(" ")),
    });

    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["bud log writer-path"]);
  });

  test("CLI from-repo validates stem before dispatching", async () => {
    const missingStem = await handler({ source: "cli", args: ["--from-repo", "/repo"] });
    expect(missingStem).toEqual({ ok: false, error: "--from-repo requires --stem <stem> (oracle stem, no -oracle suffix)" });

    const suffixedStem = await handler({ source: "cli", args: ["--from-repo", "/repo", "--stem", "leaf-oracle"] });
    expect(suffixedStem.ok).toBe(false);
    expect(suffixedStem.error).toContain("--stem must NOT end with '-oracle'");
    expect(suffixedStem.error).toContain("--stem leaf");
    expect(fromRepoCalls).toEqual([]);
  });

  test("CLI from-repo forwards safe router options and URL classification", async () => {
    const result = await handler({
      source: "cli",
      args: [
        "--from-repo", "Soul-Brews-Studio/existing",
        "--stem", "leaf",
        "--from", "parent",
        "--pr",
        "--dry-run",
        "--force",
        "--track-vault",
        "--seed",
        "--sync-peers",
      ],
    });

    expect(result).toEqual({ ok: true, output: "from-repo Soul-Brews-Studio/existing leaf" });
    expect(fromRepoCalls).toEqual([{ 
      target: "Soul-Brews-Studio/existing",
      stem: "leaf",
      isUrl: true,
      pr: true,
      dryRun: true,
      force: true,
      from: "parent",
      trackVault: true,
      seed: true,
      syncPeers: true,
    }]);
  });

  test("API mode requires a name and forwards typed body options", async () => {
    expect(await handler({ source: "api", args: {} })).toEqual({ ok: false, error: "name required" });

    const result = await handler({
      source: "api",
      args: {
        name: "api-bud",
        from: "parent",
        repo: "org/api-bud-oracle",
        org: "Org",
        issue: 7,
        note: "api note",
        nickname: "Api Bud",
        fast: true,
        root: true,
        dryRun: true,
        split: true,
        scaffoldOnly: true,
        seed: true,
        blank: true,
        signalOnBirth: true,
      },
    });

    expect(result).toEqual({ ok: true, output: undefined });
    expect(budCalls).toEqual([{ name: "api-bud", opts: {
      from: "parent",
      repo: "org/api-bud-oracle",
      org: "Org",
      issue: 7,
      note: "api note",
      nickname: "Api Bud",
      fast: true,
      root: true,
      dryRun: true,
      split: true,
      scaffoldOnly: true,
      seed: true,
      blank: true,
      signalOnBirth: true,
    } }]);
  });

  test("errors prefer captured logs when present and otherwise expose thrown message", async () => {
    const noisy = await handler({ source: "cli", args: ["noisy-fail"] });
    expect(noisy).toEqual({ ok: false, error: "before fail", output: "before fail" });

    const plain = await handler({ source: "cli", args: ["plain-fail"] });
    expect(plain).toEqual({ ok: false, error: "plain boom", output: undefined });
  });
});
