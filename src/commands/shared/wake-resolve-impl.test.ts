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

mock.module(join(root, "sdk"), () => ({
  tmux: {
    listSessions: async () => tmuxSessions,
  },
  hostExec: async () => "",
  curlFetch: async () => ({ ok: false }),
  FLEET_DIR: "/tmp/maw-test-nonexistent-fleet",
}));

mock.module(join(root, "config"), () => mockConfigModule(() => ({
  sessions: {},
  agents: {},
  peers: [],
})));

const { detectSession, sanitizeBranchName } = await import("./wake-resolve-impl");

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
