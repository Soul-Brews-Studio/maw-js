import { describe, expect, test } from "bun:test";
import handler from "../../src/vendor/mpr-plugins/watch/index";

// Behavioural test for the `maw watch` DEPRECATION SHIM. The shim prints the
// "moved → maw company worklog" notice AND must forward ALL input transparently
// — bad input's clean error still surfaces in `.error`, not swallowed by the
// notice (regression: `error: output ?? r.error` let the notice shadow it).
// Uses an unknown subcommand so no verb touches the network (log/sync poll PRs).

const run = (args: string[]) =>
  handler({ source: "cli", args } as never) as Promise<{ ok: boolean; error?: string; output?: string }>;

describe("maw watch shim", () => {
  test("prints the moved notice on every call", async () => {
    const r = await run(["bogus"]);
    expect(r.output).toContain("moved → 'maw company worklog'");
  });

  test("unknown subcommand → clean usage error surfaces (not masked by the notice)", async () => {
    const r = await run(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage"); // the forwarded clean error, transparent
  });
});
