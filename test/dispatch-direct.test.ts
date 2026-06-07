/** Direct coverage for the CLI dispatch ladder's safe error/shortcut paths. */
import { afterEach, describe, expect, it } from "bun:test";
import { dispatchCommand } from "../src/cli/dispatch";
import { UserError } from "../src/core/util/user-error";

const original = {
  exit: process.exit,
  log: console.log,
  error: console.error,
  testMode: process.env.MAW_TEST_MODE,
};

type Capture = { code: number | undefined; stdout: string; stderr: string; error: unknown };

async function captureDispatch(cmd: string, args: string[]): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;
  let error: unknown;

  process.env.MAW_TEST_MODE = "1";
  (process as any).exit = (exitCode?: number) => {
    code = exitCode ?? 0;
    throw new Error(`exit:${code}`);
  };
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };

  try {
    await dispatchCommand(cmd, args);
  } catch (err) {
    error = err;
    if (err instanceof Error && err.message.startsWith("exit:")) {
      // process.exit is part of the old dispatch contract; capture it.
    } else if (!(err instanceof UserError)) {
      throw err;
    }
  }

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), error };
}

afterEach(() => {
  (process as any).exit = original.exit;
  console.log = original.log;
  console.error = original.error;
  if (original.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = original.testMode;
});

describe("dispatchCommand direct safe paths", () => {
  it("fails loud for unknown non-oracle-shaped commands", async () => {
    const res = await captureDispatch("??missing", ["??missing"]);
    expect(res.error).toBeInstanceOf(UserError);
    expect(res.stderr).toContain("unknown command: ??missing");
    expect(res.stderr).toContain("maw --help");
    expect(res.code).toBeUndefined();
  });

  it("short-circuits core route help before plugin registry fallback", async () => {
    const res = await captureDispatch("plugins", ["plugins", "--help"]);
    expect(res.code).toBeUndefined();
    expect(res.stdout).toContain("usage: maw plugins");
    expect(res.stderr).toBe("");
  });
});
