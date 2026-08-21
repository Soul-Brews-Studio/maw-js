/**
 * Fleet-child recovery — PARTIAL external-boundary evidence (#dept-roster D-5).
 *
 * Spawns the real `maw wake <bare-name> --dry-run` process (through src/cli.ts,
 * the actual entry point) against a scratch MAW_HOME fleet, with a fake `tmux`
 * on PATH so no live tmux is touched. It proves the recovery DECISION engages at
 * the real CLI entry (bare-name routing, record read, engine gate) as an
 * external process.
 *
 * It is deliberately PARTIAL, not full same-interface proof:
 *   - --dry-run stops before the tmux send-keys injection, so the exact injected
 *     command bytes and a live child's cwd/env are NOT asserted here.
 *   - These tests assert on stdout/stderr only, NOT the process exit code: a
 *     manual non-dry-run hostile run exits rc=1 because after a correct
 *     fallthrough the normal wake path reaches a missing-repo clone in this
 *     sandbox — expected here, but it means exit-code is not evidence.
 *   - send-keys bytes and live-child env/cwd remain INCONCLUSIVE and are the
 *     live-reconcile canary, kept closed in this non-live worktree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const BUN = process.execPath;

let scratch: string;
let env: Record<string, string>;

function runWake(name: string): { stdout: string; stderr: string; code: number } {
  const res = Bun.spawnSync([BUN, CLI, "wake", name, "--dry-run"], { env, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    code: res.exitCode ?? -1,
  };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "maw-src03-cli-"));
  const fleetDir = join(scratch, "fleet");
  const fakebin = join(scratch, "bin");
  mkdirSync(fleetDir, { recursive: true });
  mkdirSync(fakebin, { recursive: true });

  const tmuxShim = join(fakebin, "tmux");
  writeFileSync(tmuxShim, "#!/bin/sh\ncase \"$1\" in\n  -V) echo 'tmux 3.4' ;;\n  has-session) exit 1 ;;\n  *) exit 0 ;;\nesac\n", "utf-8");
  chmodSync(tmuxShim, 0o755);

  writeFileSync(join(fleetDir, "25-cookbook.json"), JSON.stringify({
    name: "25-cookbook",
    windows: [{
      name: "cookbook",
      repo: "org/nntn-cookbook",
      runtime: {
        engine: "codex", cwd: "/tmp/captured-cwd", nativeSessionId: "sess-abc",
        capturedAt: "2026-08-19T21:10:00.000Z",
        launch: { cwd: "/tmp/ratified-root", env: { CODEX_HOME: "/tmp/codex-home" }, argv: ["codex", "resume"] },
      },
    }],
  }, null, 2) + "\n", "utf-8");

  writeFileSync(join(fleetDir, "99-probe.json"), JSON.stringify({
    name: "99-probe",
    windows: [{
      name: "gemini-seat", repo: "org/probe",
      runtime: { engine: "gemini", cwd: "/tmp/x", nativeSessionId: "s", capturedAt: "2026-08-19T21:10:00.000Z" },
    }],
  }, null, 2) + "\n", "utf-8");

  writeFileSync(join(fleetDir, "07-plain.json"), JSON.stringify({
    name: "07-plain",
    windows: [{ name: "plain-seat", repo: "org/plain" }], // no runtime
  }, null, 2) + "\n", "utf-8");

  env = {
    PATH: `${fakebin}:${dirname(BUN)}:/usr/bin:/bin`,
    HOME: scratch,
    MAW_HOME: scratch,
    MAW_NO_PROMPT: "1",
  };
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("maw wake <bare> --dry-run — CLI boundary", () => {
  test("POS: a recoverable fleet child resumes its captured session", () => {
    const { stdout, stderr } = runWake("cookbook");
    const out = stdout + stderr;
    // recovery engaged at the real entry point and read the record
    expect(out).toContain("would recover 25-cookbook:cookbook");
    expect(out).toContain("codex session sess-abc");
  });

  test("NEG: an unsupported engine warns and does not recover", () => {
    const { stdout, stderr } = runWake("gemini-seat");
    const out = stdout + stderr;
    expect(out).toContain("unsupported recoverable engine 'gemini'");
    expect(out).not.toContain("would recover 99-probe");
  });

  test("NEG: a window with no runtime does not recover", () => {
    const { stdout, stderr } = runWake("plain-seat");
    const out = stdout + stderr;
    expect(out).not.toContain("would recover 07-plain");
  });
});
