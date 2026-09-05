import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const helper = join(import.meta.dir, "../../scripts/run-with-timeout.ts");

function run(seconds: string, script: string) {
  return Bun.spawnSync(["bun", helper, seconds, "bun", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("portable isolated-test timeout", () => {
  test("preserves a successful command exit", () => {
    expect(run("1", "process.exit(0)").exitCode).toBe(0);
  });

  test("preserves a failing command exit", () => {
    expect(run("1", "process.exit(7)").exitCode).toBe(7);
  });

  test("returns GNU-timeout compatible status 124 at the deadline", () => {
    expect(run("0.05", "await Bun.sleep(1000)").exitCode).toBe(124);
  });
});
