/**
 * bud-repo.ts — ensureBudRepo() covers the GitHub repo scaffolding step
 * of `maw bud`. It shells out via hostExec to:
 *   - `gh repo view <slug>` (pre-check)
 *   - `gh repo create <slug> --private --add-readme`
 *   - `ghq get github.com/<slug>` (clone)
 *
 * Isolated because we mock.module(".../src/sdk") — mock.module is
 * process-global and must be set BEFORE bud-repo.ts loads.
 *
 * Strategy:
 *   - Real fs on a per-run mkdtempSync tmpdir for the `existsSync` branch.
 *   - hostExec stubbed via a programmable handler so each test drives the
 *     branches (view-hit / view-miss / create-succeeds / create-already /
 *     create-403 / create-other-error).
 *   - Assert on observable state: the sequence of shelled commands, the
 *     thrown error message, the early-return guard.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── hostExec mock (set BEFORE importing bud-repo) ──────────────────────────

interface ExecResponse {
  match?: RegExp;        // cmd substring/regex to match
  result?: string | (() => string); // static string or dynamic callback (for state-dependent stubs)
  error?: string;        // message to reject with
  sideEffect?: () => void; // run before resolving (e.g. mkdirSync to simulate `ghq get` landing)
}

let execCalls: string[] = [];
let execResponses: ExecResponse[] = [];

const mockExec = async (cmd: string): Promise<string> => {
  execCalls.push(cmd);
  for (const r of execResponses) {
    if (r.match && r.match.test(cmd)) {
      if (r.error) throw new Error(r.error);
      r.sideEffect?.();
      return typeof r.result === "function" ? r.result() : (r.result ?? "");
    }
  }
  return "";
};

// Helper: stub `ghq list --exact --full-path` to reflect whether the clone
// has happened yet. Returns `path` once `path` exists on disk, empty before.
// Mirrors how real ghq behaves — it only lists repos it knows about.
function stubGhqListTracking(path: string): ExecResponse {
  return { match: /^ghq list /, result: () => existsSync(path) ? `${path}\n` : "" };
}

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: mockExec,
}));

const { ensureBudRepo } = await import("../../src/commands/plugins/bud/bud-repo");

// ─── Scratch tmpdir for existsSync-local branch ─────────────────────────────

const tmpBase = mkdtempSync(join(tmpdir(), "maw-bud-repo-"));

afterAll(() => {
  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
});

// Silence the decorated console output — keeps test runner output clean.
const origLog = console.log;
beforeEach(() => {
  console.log = () => {};
  execCalls = [];
  execResponses = [];
});
afterEach(() => { console.log = origLog; });
afterAll(() => { console.log = origLog; });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ensureBudRepo — local short-circuit", () => {
  test("returns early when budRepoPath already exists on disk (no shell-out)", async () => {
    const existingPath = join(tmpBase, "already-cloned");
    mkdirSync(existingPath, { recursive: true });

    await ensureBudRepo(
      "Soul-Brews-Studio/already-cloned-oracle",
      existingPath,
      "already-cloned-oracle",
      "Soul-Brews-Studio",
    );

    // Zero commands executed — the existsSync guard kicks us out before any gh/ghq call.
    expect(execCalls).toEqual([]);
  });
});

describe("ensureBudRepo — gh repo view pre-check", () => {
  test("view returns matching repo name → skips create, still clones via ghq", async () => {
    const missingPath = join(tmpBase, "view-hit");
    execResponses = [
      stubGhqListTracking(missingPath),
      { match: /^gh repo view /, result: `{"name":"view-hit-oracle"}` },
      { match: /^ghq get /, sideEffect: () => mkdirSync(missingPath, { recursive: true }) },
    ];

    await ensureBudRepo(
      "Soul-Brews-Studio/view-hit-oracle",
      missingPath,
      "view-hit-oracle",
      "Soul-Brews-Studio",
    );

    // view was called, create was NOT, ghq get was called.
    expect(execCalls.some((c) => c.startsWith("gh repo view"))).toBe(true);
    expect(execCalls.some((c) => c.startsWith("gh repo create"))).toBe(false);
    expect(execCalls.some((c) => c.startsWith("ghq get"))).toBe(true);
    expect(execCalls.some((c) => c.includes("github.com/Soul-Brews-Studio/view-hit-oracle"))).toBe(true);
  });

  test("view throws (.catch swallows) → proceeds to create → then ghq get", async () => {
    const missingPath = join(tmpBase, "view-miss");
    execResponses = [
      stubGhqListTracking(missingPath),
      { match: /^gh repo view /, error: "not found" },
      // No response for `gh repo create` → default "" which means "success".
      { match: /^ghq get /, sideEffect: () => mkdirSync(missingPath, { recursive: true }) },
    ];

    await ensureBudRepo(
      "Soul-Brews-Studio/view-miss-oracle",
      missingPath,
      "view-miss-oracle",
      "Soul-Brews-Studio",
    );

    const viewIdx = execCalls.findIndex((c) => c.startsWith("gh repo view"));
    const createIdx = execCalls.findIndex((c) => c.startsWith("gh repo create"));
    const cloneIdx = execCalls.findIndex((c) => c.startsWith("ghq get"));

    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(viewIdx);
    expect(cloneIdx).toBeGreaterThan(createIdx);

    // Create flags match the real impl — regression guard.
    expect(execCalls[createIdx]).toContain("--private");
    expect(execCalls[createIdx]).toContain("--add-readme");
    expect(execCalls[createIdx]).toContain("Soul-Brews-Studio/view-miss-oracle");
  });

  test("view returns UNRELATED repo name (no match) → proceeds to create", async () => {
    // Regression: the check is viewCheck.includes(budRepoName) — a foreign
    // repo payload must NOT be treated as a hit.
    const missingPath = join(tmpBase, "view-other");
    execResponses = [
      stubGhqListTracking(missingPath),
      { match: /^gh repo view /, result: `{"name":"some-other-repo"}` },
      { match: /^ghq get /, sideEffect: () => mkdirSync(missingPath, { recursive: true }) },
    ];

    await ensureBudRepo(
      "Soul-Brews-Studio/view-other-oracle",
      missingPath,
      "view-other-oracle",
      "Soul-Brews-Studio",
    );

    expect(execCalls.some((c) => c.startsWith("gh repo create"))).toBe(true);
  });
});

describe("ensureBudRepo — gh repo create error branches", () => {
  test('"already exists" error is swallowed, ghq get still runs', async () => {
    const missingPath = join(tmpBase, "create-already");
    execResponses = [
      stubGhqListTracking(missingPath),
      { match: /^gh repo view /, error: "not found" },
      { match: /^gh repo create /, error: "repository already exists on remote" },
      { match: /^ghq get /, sideEffect: () => mkdirSync(missingPath, { recursive: true }) },
    ];

    await ensureBudRepo(
      "Soul-Brews-Studio/create-already-oracle",
      missingPath,
      "create-already-oracle",
      "Soul-Brews-Studio",
    );

    // Must NOT throw — the "already exists" branch logs and continues.
    expect(execCalls.some((c) => c.startsWith("ghq get"))).toBe(true);
  });

  test('"403" error maps to friendly org-admin message (mentions org + slug)', async () => {
    const missingPath = join(tmpBase, "create-403");
    execResponses = [
      { match: /^gh repo view /, error: "not found" },
      { match: /^gh repo create /, error: "HTTP 403: forbidden" },
    ];

    let caught: Error | null = null;
    try {
      await ensureBudRepo(
        "my-gh-org/locked-oracle",
        missingPath,
        "locked-oracle",
        "my-gh-org",
      );
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("no permission to create repos");
    expect(caught!.message).toContain("my-gh-org");
    expect(caught!.message).toContain("my-gh-org/locked-oracle");
    expect(caught!.message).toContain("maw bud");

    // Never reaches ghq get when permission is denied.
    expect(execCalls.some((c) => c.startsWith("ghq get"))).toBe(false);
  });

  test('"admin" error (e.g. "must be an admin") also maps to friendly message', async () => {
    const missingPath = join(tmpBase, "create-admin");
    execResponses = [
      { match: /^gh repo view /, error: "not found" },
      { match: /^gh repo create /, error: "you must be an admin of this org to create repos" },
    ];

    let caught: Error | null = null;
    try {
      await ensureBudRepo(
        "some-org/admin-only-oracle",
        missingPath,
        "admin-only-oracle",
        "some-org",
      );
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("no permission to create repos");
    expect(caught!.message).toContain("some-org");
  });

  test("unrecognized error is re-thrown verbatim (no swallowing, no friendly-wrap)", async () => {
    const missingPath = join(tmpBase, "create-weird");
    execResponses = [
      { match: /^gh repo view /, error: "not found" },
      { match: /^gh repo create /, error: "ECONNRESET: network borked" },
    ];

    let caught: Error | null = null;
    try {
      await ensureBudRepo(
        "Soul-Brews-Studio/weird-oracle",
        missingPath,
        "weird-oracle",
        "Soul-Brews-Studio",
      );
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("ECONNRESET");
    // Must NOT be rewritten to the friendly message.
    expect(caught!.message).not.toContain("no permission to create repos");

    // Clone never runs after a hard failure.
    expect(execCalls.some((c) => c.startsWith("ghq get"))).toBe(false);
  });
});

describe("ensureBudRepo — ghq clone command shape", () => {
  test("clone command is always `ghq get github.com/<slug>` (regression guard)", async () => {
    const missingPath = join(tmpBase, "clone-shape");
    execResponses = [
      stubGhqListTracking(missingPath),
      { match: /^gh repo view /, error: "not found" },
      { match: /^ghq get /, sideEffect: () => mkdirSync(missingPath, { recursive: true }) },
    ];

    await ensureBudRepo(
      "Soul-Brews-Studio/clone-shape-oracle",
      missingPath,
      "clone-shape-oracle",
      "Soul-Brews-Studio",
    );

    const cloneCmd = execCalls.find((c) => c.startsWith("ghq get"));
    expect(cloneCmd).toBe("ghq get github.com/Soul-Brews-Studio/clone-shape-oracle");
  });
});
