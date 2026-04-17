/**
 * Tests for --task fire-and-forget flag and --issue --repo cross-repo.
 *
 * Tests replicate the relevant logic inline (same pattern as wake.test.ts)
 * to avoid pulling in tmux/ssh/config module chains.
 */
import { describe, test, expect } from "bun:test";
import { parseFlags } from "../src/cli/parse-args";

// ---------------------------------------------------------------------------
// Replicate route-agent wake opts building logic for unit testing
// ---------------------------------------------------------------------------

interface WakeOpts {
  task?: string;
  wt?: string;
  prompt?: string;
  incubate?: string;
  fresh?: boolean;
  noAttach?: boolean;
  listWt?: boolean;
}

function buildWakeOpts(args: string[]): { opts: WakeOpts; repo: string | undefined } {
  const flags = parseFlags(args, {
    "--wt": String,
    "--new": "--wt",
    "--incubate": String,
    "--issue": Number,
    "--pr": Number,
    "--repo": String,
    "--task": String,
    "--fresh": Boolean,
    "--no-attach": Boolean,
    "--list": Boolean,
    "--ls": "--list",
  }, 2);

  const opts: WakeOpts = {};
  let repo: string | undefined = flags["--repo"];

  if (flags["--wt"]) opts.wt = flags["--wt"];
  if (flags["--incubate"]) opts.incubate = flags["--incubate"];
  if (flags["--fresh"]) opts.fresh = true;
  if (flags["--no-attach"]) opts.noAttach = true;
  if (flags["--list"]) opts.listWt = true;
  if (flags["--task"]) opts.noAttach = true;

  const positionals = flags._;
  if (positionals.length > 0) opts.task = positionals[0];
  if (positionals.length > 1) opts.prompt = positionals.slice(1).join(" ");

  if (opts.incubate && !repo) repo = opts.incubate;

  const issueNum: number | null = flags["--issue"] ?? null;
  const prNum: number | null = flags["--pr"] ?? null;

  // Simulate --issue/--pr prompt resolution (without network call)
  if (issueNum) {
    opts.prompt = `__FETCHED_ISSUE_${issueNum}__`;
    if (!opts.task) opts.task = `issue-${issueNum}`;
  } else if (prNum) {
    opts.prompt = `__FETCHED_PR_${prNum}__`;
    if (!opts.task) opts.task = `pr-${prNum}`;
  } else if (flags["--task"]) {
    opts.prompt = flags["--task"];
  }

  return { opts, repo };
}

// ---------------------------------------------------------------------------
// Replicate resolveRepo logic for unit testing without hostExec
// ---------------------------------------------------------------------------

async function resolveRepoWith(repo: string | undefined, detectFromGit: () => Promise<string | null>): Promise<string> {
  if (repo) return repo;
  const detected = await detectFromGit();
  if (detected) return detected;
  throw new Error("Could not detect repo — pass --repo org/name");
}

// ---------------------------------------------------------------------------
// Replicate fetchGitHubPrompt issue formatting logic
// ---------------------------------------------------------------------------

function formatIssuePrompt(num: number, item: { title: string; body?: string; labels?: { name: string }[] }): string {
  const labels = (item.labels || []).map((l: { name: string }) => l.name).join(", ");
  return [
    `Work on issue #${num}: ${item.title}`,
    labels ? `Labels: ${labels}` : "",
    "",
    item.body || "(no description)",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// args format matches process.argv.slice(2): ["wake", "<oracle>", ...flags]
// routeAgent(cmd, args) uses args[1] for oracle and parseFlags(args, spec, 2)
// which slices to args[2..], so the oracle at index 1 is NOT in flags._

describe("--task flag (fire-and-forget)", () => {
  test("--task sets prompt and noAttach, no window label created", () => {
    const { opts } = buildWakeOpts(["wake", "neo", "--task", "write tests for the auth module"]);
    expect(opts.prompt).toBe("write tests for the auth module");
    expect(opts.noAttach).toBe(true);
    expect(opts.task).toBeUndefined(); // no positional window label
  });

  test("--task with multi-word quoted string captured whole", () => {
    // shell already splits quoted → arrives as single element in args
    const { opts } = buildWakeOpts(["wake", "neo", "--task", "implement PR #42 review checklist"]);
    expect(opts.prompt).toBe("implement PR #42 review checklist");
    expect(opts.noAttach).toBe(true);
  });

  test("--task + explicit --no-attach: noAttach stays true (idempotent)", () => {
    const { opts } = buildWakeOpts(["wake", "neo", "--task", "do x", "--no-attach"]);
    expect(opts.noAttach).toBe(true);
    expect(opts.prompt).toBe("do x");
  });

  test("--task + --issue: issue prompt wins, but noAttach is still set", () => {
    const { opts } = buildWakeOpts(["wake", "neo", "--task", "override", "--issue", "99"]);
    // --issue takes priority for the prompt content
    expect(opts.prompt).toBe("__FETCHED_ISSUE_99__");
    // --task still implies fire-and-forget
    expect(opts.noAttach).toBe(true);
  });
});

describe("--issue --repo cross-repo", () => {
  test("--repo value passed through to resolveRepo without git detection", async () => {
    const detectFromGit = async () => { throw new Error("should not call git"); };
    const slug = await resolveRepoWith("acme/my-project", detectFromGit);
    expect(slug).toBe("acme/my-project");
  });

  test("resolveRepo without --repo falls back to git remote detection", async () => {
    const detectFromGit = async () => "Soul-Brews-Studio/maw-js";
    const slug = await resolveRepoWith(undefined, detectFromGit);
    expect(slug).toBe("Soul-Brews-Studio/maw-js");
  });

  test("resolveRepo without --repo and no git remote throws", async () => {
    const detectFromGit = async () => null;
    await expect(resolveRepoWith(undefined, detectFromGit)).rejects.toThrow("pass --repo");
  });

  test("--issue --repo flag wires repo into wakeOpts context", () => {
    const { opts, repo } = buildWakeOpts(["wake", "neo", "--issue", "42", "--repo", "acme/other-repo"]);
    expect(repo).toBe("acme/other-repo");
    expect(opts.prompt).toBe("__FETCHED_ISSUE_42__");
    expect(opts.task).toBe("issue-42"); // auto-label
  });
});

describe("fetchGitHubPrompt — issue prompt format", () => {
  test("issue with labels formats correctly", () => {
    const result = formatIssuePrompt(7, {
      title: "Fix the login bug",
      body: "Steps to reproduce:\n1. Go to login\n2. Enter bad password",
      labels: [{ name: "bug" }, { name: "auth" }],
    });
    expect(result).toContain("Work on issue #7: Fix the login bug");
    expect(result).toContain("Labels: bug, auth");
    expect(result).toContain("Steps to reproduce:");
  });

  test("issue without labels omits labels line", () => {
    const result = formatIssuePrompt(3, { title: "Update docs", body: "See README" });
    expect(result).not.toContain("Labels:");
    expect(result).toContain("Work on issue #3: Update docs");
  });

  test("issue with empty body uses fallback", () => {
    const result = formatIssuePrompt(5, { title: "Empty issue" });
    expect(result).toContain("(no description)");
  });
});
