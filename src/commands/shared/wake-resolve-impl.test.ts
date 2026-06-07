/**
 * Regression tests for #769 — wake URL-resolver greedy substring match.
 *
 * detectSession(oracle, urlRepoName) must NOT fall back to substring
 * matching against the stripped sub-token when the wake target was a URL
 * (the user expressed full repo intent). It should only match on the
 * full repo name, the stripped form (exact), or a `NN-<full>` numbered
 * session — and return null otherwise so the caller can auto-create.
 */
import { describe, it, expect, mock } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const { mockConfigModule } = await import("../../../test/helpers/mock-config");

let tmuxSessions: Array<{ name: string }> = [];
let hostExecOut = "";

mock.module(join(root, "sdk"), () => ({
  tmux: {
    listSessions: async () => tmuxSessions,
  },
  hostExec: async () => hostExecOut,
  curlFetch: async () => ({ ok: false }),
  FLEET_DIR: "/tmp/maw-test-nonexistent-fleet",
}));

mock.module(join(root, "config"), () => mockConfigModule(() => ({
  sessions: {},
  agents: {},
  peers: [],
})));

const {
  detectSession,
  sanitizeBranchName,
  resolveLocalOracleRepoName,
  findWorktrees,
  findReusableWorktreeBySlug,
  resolveFromWorktrees,
  setSessionEnv,
} = await import("./wake-resolve-impl");


describe("resolveFromWorktrees — injected helper coverage", () => {
  it("resolves a main repo from a matching linked worktree", async () => {
    const result = await resolveFromWorktrees(
      "wireboy",
      async () => [{ path: "/tmp/wireboy.wt-1-fix", mainRepo: "Soul-Brews-Studio/wireboy-oracle" } as any],
      async () => "/tmp/ghq/github.com/Soul-Brews-Studio/wireboy-oracle/.git\n",
      (path) => path === "/tmp/ghq/github.com/Soul-Brews-Studio/wireboy-oracle",
    );

    expect(result).toEqual({
      repoPath: "/tmp/ghq/github.com/Soul-Brews-Studio/wireboy-oracle",
      repoName: "wireboy-oracle",
      parentDir: "/tmp/ghq/github.com/Soul-Brews-Studio",
    });
  });

  it("returns null for empty git common-dir or missing main repos", async () => {
    const worktrees = async () => [{ path: "/tmp/wireboy.wt-1-fix", mainRepo: "Soul-Brews-Studio/wireboy-oracle" } as any];

    await expect(resolveFromWorktrees("wireboy", worktrees, async () => "", () => true)).resolves.toBeNull();
    await expect(resolveFromWorktrees("wireboy", worktrees, async () => "/tmp/wireboy-oracle\n", () => false)).resolves.toBeNull();
    await expect(resolveFromWorktrees("other", worktrees, async () => { throw new Error("should not run"); }, () => true)).resolves.toBeNull();
  });
});

describe("setSessionEnv — injected helper coverage", () => {
  it("sets plain env vars and trims pass: secrets", async () => {
    const setCalls: Array<[string, string, string]> = [];

    await setSessionEnv("88-maw", {
      getEnvVars: () => ({ TOKEN: "pass:maw/token", PLAIN: "value" }),
      spawn: ((cmd: string[]) => ({
        stdout: new Blob([cmd.join(" ") === "pass show maw/token" ? "secret\n" : ""]),
        stderr: new Blob([""]),
        exited: Promise.resolve(0),
      })) as any,
      setEnvironment: async (session, key, value) => { setCalls.push([session, key, value]); },
    });

    expect(setCalls).toEqual([
      ["88-maw", "TOKEN", "secret"],
      ["88-maw", "PLAIN", "value"],
    ]);
  });

  it("throws when pass exits non-zero", async () => {
    await expect(setSessionEnv("88-maw", {
      getEnvVars: () => ({ TOKEN: "pass:missing/token" }),
      spawn: (() => ({
        stdout: new Blob([""]),
        stderr: new Blob(["missing"]),
        exited: Promise.resolve(7),
      })) as any,
      setEnvironment: async () => { throw new Error("should not set"); },
    })).rejects.toThrow("pass show 'missing/token' failed (exit 7)");
  });
});


describe("sanitizeBranchName (#823 Bug A) — greedy strip", () => {
  it("strips ALL leading dashes (--no-attach → no-attach)", () => {
    // Pre-#823: `/^[-.]|[-.]$/g` only stripped one leading dash, leaving
    // "-no-attach" which then became corrupted worktree name "1--no-attach".
    expect(sanitizeBranchName("--no-attach")).toBe("no-attach");
  });

  it("strips ALL trailing dashes/dots", () => {
    expect(sanitizeBranchName("foo--")).toBe("foo");
    expect(sanitizeBranchName("foo..")).toBe("foo");
    expect(sanitizeBranchName("--foo--")).toBe("foo");
  });

  it("collapses pure-junk input (`--`) to empty string", () => {
    // Edge case — caller responsible for treating empty as malformed input.
    expect(sanitizeBranchName("--")).toBe("");
    expect(sanitizeBranchName("...")).toBe("");
  });

  it("preserves valid branch names unchanged", () => {
    expect(sanitizeBranchName("feature-x")).toBe("feature-x");
    expect(sanitizeBranchName("issue-823")).toBe("issue-823");
  });

  it("lowercases and replaces whitespace with dashes (existing behavior)", () => {
    expect(sanitizeBranchName("My Task Name")).toBe("my-task-name");
  });
});

describe("detectSession (#769) — URL-aware resolution", () => {
  it("URL with `<name>-oracle` repo resolves to exact full-name session", async () => {
    tmuxSessions = [
      { name: "01-maw-m5" },
      { name: "04-ollama-m5" },
      { name: "m5-oracle" },
    ];
    const result = await detectSession("m5", "m5-oracle");
    expect(result).toBe("m5-oracle");
  });

  it("URL with no existing session returns null (caller auto-creates)", async () => {
    // The pre-#769 bug: oracle="m5" + sessions like "01-maw-m5" / "04-ollama-m5"
    // would be picked up by the generic `endsWith("-${oracle}")` rule and
    // surface as AmbiguousMatchError. With urlRepoName="m5-oracle", neither
    // of those sessions matches and we return null cleanly.
    tmuxSessions = [
      { name: "01-maw-m5" },
      { name: "04-ollama-m5" },
    ];
    const result = await detectSession("m5", "m5-oracle");
    expect(result).toBeNull();
  });

  it("URL with NN-<full-name> numbered prefix resolves to that session", async () => {
    tmuxSessions = [
      { name: "01-maw-m5" },
      { name: "99-m5-oracle" },
    ];
    const result = await detectSession("m5", "m5-oracle");
    expect(result).toBe("99-m5-oracle");
  });

  it("URL with stripped-form exact match also resolves", async () => {
    // `name === <repo-name without -oracle>` per issue #769 fix sketch.
    tmuxSessions = [
      { name: "m5" },
    ];
    const result = await detectSession("m5", "m5-oracle");
    expect(result).toBe("m5");
  });

  it("exact numeric-prefixed session name resolves before suffix ambiguity", async () => {
    tmuxSessions = [
      { name: "47-mawjs" },
      { name: "48-mawjs-codex" },
    ];
    const result = await detectSession("48-mawjs-codex");
    expect(result).toBe("48-mawjs-codex");
  });

  it("short fuzzy token reuses unique numbered canonical fleet session (#1794)", async () => {
    tmuxSessions = [
      { name: "20-homekeeper" },
      { name: "mawjs-view" },
    ];
    const result = await detectSession("homeke");
    expect(result).toBe("20-homekeeper");
  });

  it("short fuzzy fleet fallback does not hijack dashed sub-oracle sessions (#535/#1794)", async () => {
    tmuxSessions = [
      { name: "114-mawjs-no2" },
    ];
    const result = await detectSession("mawjs");
    expect(result).toBeNull();
  });

  it("genuine multi-exact-match on full name still errors", async () => {
    tmuxSessions = [
      { name: "10-m5-oracle" },
      { name: "20-m5-oracle" },
    ];
    // detectSession calls process.exit(1) on ambiguous numeric matches.
    // Stub it to throw so we can assert the path was hit.
    const origExit = process.exit;
    let exited = false;
    // @ts-expect-error — test stub
    process.exit = (code?: number) => { exited = true; throw new Error(`process.exit(${code})`); };
    try {
      await expect(detectSession("m5", "m5-oracle")).rejects.toThrow("process.exit(1)");
      expect(exited).toBe(true);
    } finally {
      process.exit = origExit;
    }
  });
});

describe("resolveLocalOracleRepoName (#1469) — exact local oracle wins before fuzzy", () => {
  const repos = [
    "github.com/Soul-Brews-Studio/mawjs-oracle",
    "github.com/Soul-Brews-Studio/mawjs-codex-oracle",
    "github.com/Soul-Brews-Studio/arra-oracle-v3-oracle",
  ];

  it("prefers an exact full oracle repo name over a shorter fuzzy suffix", () => {
    expect(resolveLocalOracleRepoName("mawjs-codex-oracle", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  it("prefers an exact bare oracle name over a shorter fuzzy suffix", () => {
    expect(resolveLocalOracleRepoName("mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  it("strips a numeric fleet session prefix before exact local oracle lookup", () => {
    expect(resolveLocalOracleRepoName("48-mawjs-codex", repos)).toEqual({
      kind: "exact",
      match: "mawjs-codex-oracle",
    });
  });

  it("keeps legacy fuzzy lookup for non-exact local oracle abbreviations", () => {
    expect(resolveLocalOracleRepoName("v3", repos)).toEqual({
      kind: "fuzzy",
      match: "arra-oracle-v3-oracle",
    });
  });

  it("fails loudly when a bare oracle name exists in multiple orgs (#1635)", () => {
    expect(resolveLocalOracleRepoName("pulse", [
      "github.com/laris-co/pulse-oracle",
      "github.com/Soul-Brews-Studio/pulse-oracle",
    ])).toEqual({
      kind: "ambiguous",
      candidates: [
        "laris-co/pulse-oracle",
        "Soul-Brews-Studio/pulse-oracle",
      ],
    });
  });
});

describe("findWorktrees (#1775) — cross-repo slug fallback", () => {
  it("reuses a matching slug even when the repo stem changed", async () => {
    hostExecOut = "/ghq/github.com/laris-co/homekeeper-oracle.wt-2-white";
    await expect(findWorktrees("/ghq/github.com/laris-co", "homelab", "white", "homekeeper-oracle")).resolves.toEqual([
      { path: "/ghq/github.com/laris-co/homekeeper-oracle.wt-2-white", name: "2-white" },
    ]);
  });

  it("does not reuse a matching slug from another oracle", () => {
    expect(findReusableWorktreeBySlug("/ghq/github.com/Soul-Brews-Studio", "white", "mother-oracle", {
      readdirSync: () => ["volt-oracle.wt-1-white", "mother-oracle.wt-2-black"] as any,
      statSync: () => ({ isDirectory: () => true }) as any,
    })).toBeNull();
  });
});
