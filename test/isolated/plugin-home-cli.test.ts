import { describe, expect, test } from "bun:test";
import { runHome } from "../../src/vendor/mpr-plugins/home/index";

// Behavioural test for the home runner `runHome` — the shared engine that
// `maw company home` drives. cli-reorg kobo-26 removed the top-level `maw home`
// command (now a module surface), so we exercise the runner directly: bad input
// returns a clean error (not a throw).

const run = async (args: string[]): Promise<{ ok: boolean; error?: string }> => {
  const out: string[] = [];
  return runHome(args, (l) => out.push(l));
};

describe("maw company home runner (runHome)", () => {
  test("unknown subcommand → clean usage error, not a throw", async () => {
    const r = await run(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage");
  });
});
