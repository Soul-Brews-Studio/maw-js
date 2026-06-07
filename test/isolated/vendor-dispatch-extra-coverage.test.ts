import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-vendor-dispatch-extra-"));
const pairImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/impl.ts");
const tagImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/tag/impl.ts");
const splitImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/split/impl.ts");

type PairResult = { ok: true } | { ok: false; error: string };

let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let pairGenerateCalls: Array<{ expiresSec?: number }> = [];
let pairAcceptCalls: Array<{ url: string; code: string }> = [];
let pairGenerateResult: PairResult = { ok: true };
let pairAcceptResult: PairResult = { ok: true };
let pairGenerateThrow: Error | null = null;
let tagCalls: Array<{ target: string; opts: unknown }> = [];
let tagThrow: Error | null = null;
let splitCalls: Array<{ target: string; opts: unknown }> = [];
let splitThrow: Error | null = null;

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
}));

mock.module(pairImplPath, () => ({
  pairGenerate: async (opts: { expiresSec?: number } = {}) => {
    pairGenerateCalls.push(opts);
    if (pairGenerateThrow) throw pairGenerateThrow;
    console.log("generated pair code");
    return pairGenerateResult;
  },
  pairAccept: async (url: string, code: string) => {
    pairAcceptCalls.push({ url, code });
    console.warn("accepting pair");
    return pairAcceptResult;
  },
}));

mock.module(tagImplPath, () => ({
  cmdTag: async (target: string, opts: unknown = {}) => {
    tagCalls.push({ target, opts });
    console.log(`tagged ${target}`);
    if (tagThrow) throw tagThrow;
  },
}));

mock.module(splitImplPath, () => ({
  cmdSplit: async (target: string, opts: unknown = {}) => {
    splitCalls.push({ target, opts });
    console.error(`split ${target}`);
    if (splitThrow) throw splitThrow;
  },
}));

const { ensureBudRepo } = await import("../../src/vendor/mpr-plugins/bud/bud-repo.ts?vendor-dispatch-extra");
const { default: pairHandler } = await import("../../src/vendor/mpr-plugins/pair/index.ts?vendor-dispatch-extra");
const { default: tagHandler } = await import("../../src/vendor/mpr-plugins/tag/index.ts?vendor-dispatch-extra");
const { default: splitHandler } = await import("../../src/vendor/mpr-plugins/split/index.ts?vendor-dispatch-extra");

function ctx(source: "cli" | "api", args: unknown, writer?: (...args: any[]) => void) {
  return { source, args, writer } as any;
}

function stripAnsi(value: string | undefined) {
  return (value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  hostExecCalls = [];
  hostExecImpl = async () => "";
  pairGenerateCalls = [];
  pairAcceptCalls = [];
  pairGenerateResult = { ok: true };
  pairAcceptResult = { ok: true };
  pairGenerateThrow = null;
  tagCalls = [];
  tagThrow = null;
  splitCalls = [];
  splitThrow = null;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bud repo path resolution", () => {
  test("returns the predicted repo path when it already exists", async () => {
    const predicted = join(tmpRoot, "existing-oracle");
    mkdirSync(predicted, { recursive: true });

    await expect(ensureBudRepo("org/existing-oracle", predicted, "existing-oracle", "org")).resolves.toBe(predicted);
    expect(hostExecCalls).toEqual([]);
  });

  test("trusts a pre-existing ghq clone over stale config.ghqRoot", async () => {
    const actual = join(tmpRoot, "actual-preexisting");
    mkdirSync(actual, { recursive: true });
    hostExecImpl = async (cmd: string) => cmd.startsWith("ghq list") ? `${actual}\n` : "";

    await expect(ensureBudRepo("org/preexisting-oracle", join(tmpRoot, "missing-predicted"), "preexisting-oracle", "org")).resolves.toBe(actual);
    expect(hostExecCalls).toEqual(["ghq list --exact --full-path github.com/org/preexisting-oracle"]);
  });

  test("creates or reuses GitHub repo, clones with ghq, then resolves actual ghq path", async () => {
    const actual = join(tmpRoot, "actual-after-clone");
    mkdirSync(actual, { recursive: true });
    let listCount = 0;
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("ghq list")) return ++listCount === 1 ? "" : `${actual}\n`;
      if (cmd.startsWith("gh repo view")) return JSON.stringify({ name: "clone-oracle" });
      return "";
    };

    const result = await ensureBudRepo("org/clone-oracle", join(tmpRoot, "stale-predicted"), "clone-oracle", "org");

    expect(result).toBe(actual);
    expect(hostExecCalls).toContain("gh repo view org/clone-oracle --json name 2>/dev/null");
    expect(hostExecCalls).toContain("ghq get github.com/org/clone-oracle");
  });

  test("creates missing GitHub repos and treats already-exists create failures as idempotent", async () => {
    const actual = join(tmpRoot, "actual-created");
    mkdirSync(actual, { recursive: true });
    let listCount = 0;
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("ghq list")) return ++listCount === 1 ? "" : `${actual}\n`;
      if (cmd.startsWith("gh repo view")) return "";
      if (cmd.startsWith("gh repo create")) return "";
      return "";
    };

    await expect(ensureBudRepo("org/created-oracle", join(tmpRoot, "created"), "created-oracle", "org")).resolves.toBe(actual);
    expect(hostExecCalls).toContain("gh repo create org/created-oracle --private --add-readme");

    const actualExisting = join(tmpRoot, "actual-existing-after-create");
    mkdirSync(actualExisting, { recursive: true });
    listCount = 0;
    hostExecCalls = [];
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("ghq list")) return ++listCount === 1 ? "" : `${actualExisting}\n`;
      if (cmd.startsWith("gh repo view")) return "";
      if (cmd.startsWith("gh repo create")) throw new Error("repository already exists");
      return "";
    };

    await expect(ensureBudRepo("org/exists-oracle", join(tmpRoot, "exists"), "exists-oracle", "org")).resolves.toBe(actualExisting);
  });

  test("reports org permission failures with a useful admin message", async () => {
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("gh repo view")) return "";
      if (cmd.startsWith("gh repo create")) throw new Error("HTTP 403 admin required");
      return "";
    };

    await expect(ensureBudRepo("org/nope-oracle", join(tmpRoot, "nope"), "nope-oracle", "org")).rejects.toThrow(
      "no permission to create repos in org",
    );
  });

  test("continues after ghq precheck errors and rethrows unexpected repo creation failures", async () => {
    hostExecImpl = async (cmd: string) => {
      if (cmd.startsWith("ghq list")) throw new Error("ghq unavailable");
      if (cmd.startsWith("gh repo view")) return "";
      if (cmd.startsWith("gh repo create")) throw new Error("rate limited");
      return "";
    };

    await expect(ensureBudRepo("org/rate-oracle", join(tmpRoot, "rate"), "rate-oracle", "org")).rejects.toThrow("rate limited");
    expect(hostExecCalls[0]).toBe("ghq list --exact --full-path github.com/org/rate-oracle");
  });

  test("fails loudly when ghq get succeeds but ghq list cannot find the clone", async () => {
    hostExecImpl = async () => "";

    await expect(ensureBudRepo("org/lost-oracle", join(tmpRoot, "lost"), "lost-oracle", "org")).rejects.toThrow(
      "ghq get succeeded but ghq list cannot find github.com/org/lost-oracle",
    );
  });
});

describe("pair plugin dispatcher", () => {
  test("prints help with no CLI args", async () => {
    const res = await pairHandler(ctx("cli", []));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("maw pair generate");
  });

  test("validates generate expiration bounds", async () => {
    const res = await pairHandler(ctx("cli", ["generate", "--expires", "4"]));
    expect(res).toEqual({ ok: false, error: "--expires must be 5..3600 seconds" });
    expect(pairGenerateCalls).toEqual([]);
  });

  test("dispatches generate and propagates pairGenerate errors", async () => {
    pairGenerateResult = { ok: false, error: "no listener" };
    const bad = await pairHandler(ctx("cli", ["generate", "--expires", "30"]));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("no listener");
    expect(pairGenerateCalls).toEqual([{ expiresSec: 30 }]);

    pairGenerateResult = { ok: true };
    const good = await pairHandler(ctx("cli", ["generate"]));
    expect(good.ok).toBe(true);
    expect(stripAnsi(good.output)).toContain("generated pair code");
  });

  test("dispatches URL accept, reports accept errors, and handles unexpected args", async () => {
    pairAcceptResult = { ok: false, error: "bad code" };
    const accepted = await pairHandler(ctx("cli", ["http://peer:5002", "W4K-7F3"]));
    expect(accepted.ok).toBe(false);
    expect(accepted.error).toBe("bad code");
    expect(pairAcceptCalls).toEqual([{ url: "http://peer:5002", code: "W4K-7F3" }]);

    const unexpected = await pairHandler(ctx("cli", ["wat"]));
    expect(unexpected.ok).toBe(false);
    expect(unexpected.error).toContain("unexpected args");
    expect(unexpected.output).toContain("maw pair generate");
  });

  test("dispatches successful URL accept and returns captured warning output", async () => {
    pairAcceptResult = { ok: true };

    const accepted = await pairHandler(ctx("cli", ["http://peer:5002", "W4K-7F3"]));

    expect(accepted.ok).toBe(true);
    expect(stripAnsi(accepted.output)).toContain("accepting pair");
    expect(pairAcceptCalls).toEqual([{ url: "http://peer:5002", code: "W4K-7F3" }]);
  });

  test("returns thrown errors from pairGenerate", async () => {
    pairGenerateThrow = new Error("boom");
    const res = await pairHandler(ctx("cli", ["generate"]));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });
});

describe("tag and split plugin dispatchers", () => {
  test("tag validates CLI/API targets and dispatches parsed options", async () => {
    expect(await tagHandler(ctx("cli", []))).toEqual({ ok: false, error: "usage: maw tag <target> [--pane N] [--title <text>] [--meta key=val]" });
    expect(await tagHandler(ctx("cli", ["--bad"]))).toEqual({ ok: false, error: '"--bad" looks like a flag, not a target.\n  usage: maw tag <target> ...' });
    expect(await tagHandler(ctx("api", {}))).toEqual({ ok: false, error: "target is required" });

    const res = await tagHandler(ctx("cli", ["mawjs:2", "--pane", "3", "--title", "hello", "--meta", "role=lead", "--meta", "tone=calm"]));
    expect(res.ok).toBe(true);
    expect(tagCalls).toEqual([{ target: "mawjs:2", opts: { pane: 3, title: "hello", meta: ["role=lead", "tone=calm"] } }]);

    await tagHandler(ctx("api", { target: "api-target", pane: 4, title: "api", meta: ["a=b"] }));
    expect(tagCalls.at(-1)).toEqual({ target: "api-target", opts: { pane: 4, title: "api", meta: ["a=b"] } });
  });

  test("tag catch branch prefers captured logs over thrown message", async () => {
    tagThrow = new Error("tag failed");
    const res = await tagHandler(ctx("cli", ["stderr-target"]));
    expect(res.ok).toBe(false);
    expect(stripAnsi(res.error)).toContain("tagged stderr-target");
    expect(stripAnsi(res.output)).toContain("tagged stderr-target");
  });

  test("split validates CLI/API targets and dispatches parsed options", async () => {
    expect(await splitHandler(ctx("cli", ["-x"]))).toEqual({ ok: false, error: '"-x" looks like a flag, not a target.\n  usage: maw split <target>' });
    expect(await splitHandler(ctx("api", {}))).toEqual({ ok: false, error: "target is required" });

    const res = await splitHandler(ctx("cli", ["mawjs", "--pct", "44", "--vertical", "--no-attach", "--claude-pane-policy", "background-tab"]));
    expect(res.ok).toBe(true);
    expect(splitCalls).toEqual([{ target: "mawjs", opts: { pct: 44, vertical: true, noAttach: true, claudePanePolicy: "background-tab" } }]);

    await splitHandler(ctx("api", { target: "api-split", pct: 60, vertical: false, noAttach: true, claudePanePolicy: "refuse" }));
    expect(splitCalls.at(-1)).toEqual({ target: "api-split", opts: { pct: 60, vertical: false, noAttach: true, claudePanePolicy: "refuse" } });
  });

  test("split catch branch prefers captured logs over thrown message", async () => {
    splitThrow = new Error("split failed");
    const res = await splitHandler(ctx("cli", ["nope"]));
    expect(res.ok).toBe(false);
    expect(stripAnsi(res.error)).toContain("split nope");
    expect(stripAnsi(res.output)).toContain("split nope");
  });
});
