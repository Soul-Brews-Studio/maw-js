import { describe, expect, test } from "bun:test";
import { runWorklog } from "../../src/vendor/mpr-plugins/watch/index";

// Behavioural test for the worklog runner `runWorklog` — the shared engine that
// `maw company worklog` drives. cli-reorg kobo-26 removed the top-level
// `maw watch` command (now a module + serve-hook surface), so we exercise the
// runner directly. Uses an unknown subcommand so no verb touches the network
// (log/sync poll PRs); bad input returns a clean error, not a throw.

const run = async (args: string[]): Promise<{ ok: boolean; error?: string }> => {
  const out: string[] = [];
  return runWorklog(args, (l) => out.push(l));
};

describe("maw company worklog runner (runWorklog)", () => {
  test("unknown subcommand → clean usage error, not a throw", async () => {
    const r = await run(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage");
  });
});
