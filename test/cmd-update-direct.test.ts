/**
 * Direct unit coverage for maw update's safe gates.
 *
 * These tests intentionally stop before destructive install operations by
 * setting MAW_TEST_MODE=1 and/or intercepting process.exit. The older
 * subprocess tests prove CLI wiring; this file imports cmd-update directly so
 * Bun coverage accounts for the guard logic in src/cli/cmd-update.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { runUpdate } from "../src/cli/cmd-update";

type Capture = { code: number | undefined; stdout: string; stderr: string; threw: unknown };

const original = {
  exit: process.exit,
  log: console.log,
  error: console.error,
  stdoutWrite: process.stdout.write,
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  testMode: process.env.MAW_TEST_MODE,
};

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

async function captureRun(args: string[], opts: { testMode?: string; stdinIsTTY?: boolean } = {}): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;
  let threw: unknown;

  if (opts.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = opts.testMode;
  if (opts.stdinIsTTY !== undefined) setStdinIsTTY(opts.stdinIsTTY);

  (process as any).exit = (exitCode?: number) => {
    code = exitCode ?? 0;
    throw new Error(`exit:${code}`);
  };
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  (process.stdout as any).write = (chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  };

  try {
    await runUpdate(args);
  } catch (err) {
    threw = err;
    if (!(err instanceof Error) || !err.message.startsWith("exit:")) throw err;
  }

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), threw };
}

afterEach(() => {
  (process as any).exit = original.exit;
  console.log = original.log;
  console.error = original.error;
  (process.stdout as any).write = original.stdoutWrite;
  if (original.stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", original.stdinIsTTY);
  else delete (process.stdin as any).isTTY;
  if (original.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = original.testMode;
});

describe("cmd-update direct safe gates", () => {
  it("prints help and exits before version/install side effects", async () => {
    const res = await captureRun(["update", "--help"], { testMode: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("usage: maw update [ref]");
    expect(res.stdout).toContain("--yes, -y");
    expect(res.stderr).toBe("");
  });

  it("rejects unknown flag-looking args before install", async () => {
    const res = await captureRun(["update", "--yess"], { testMode: "1" });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid ref "--yess"');
    expect(res.stdout).not.toContain("[test-mode]");
  });

  it("requires --yes in non-interactive mode", async () => {
    const res = await captureRun(["update", "main"], { testMode: "1", stdinIsTTY: false });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("non-interactive environment");
    expect(res.stderr).toContain("--yes");
  });

  it("accepts valid refs and stops at the MAW_TEST_MODE safety boundary", async () => {
    const res = await captureRun(["update", "feat/coverage-direct", "--yes"], { testMode: "1" });
    expect(res.code).toBeUndefined();
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("feat/coverage-direct");
    expect(res.stdout).toContain('[test-mode] ref "feat/coverage-direct" accepted');
  });

  it("ignores flag-looking values when choosing the positional ref", async () => {
    const res = await captureRun(["update", "--yes"], { testMode: "1" });
    expect(res.code).toBeUndefined();
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain('[test-mode] ref "main" accepted');
  });
});
