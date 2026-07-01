import { describe, expect, test } from "bun:test";
import handler from "../../src/vendor/mpr-plugins/home/index";

// Behavioural test for the `maw home` DEPRECATION SHIM. The shim prints the
// "moved → maw company home" notice AND must forward ALL input transparently —
// bad input's clean error still surfaces in `.error`, not swallowed by the
// notice (regression: `error: output ?? r.error` let the notice shadow it).

const run = (args: string[]) =>
  handler({ source: "cli", args } as never) as Promise<{ ok: boolean; error?: string; output?: string }>;

describe("maw home shim", () => {
  test("prints the moved notice on every call", async () => {
    const r = await run(["bogus"]);
    expect(r.output).toContain("moved → 'maw company home'");
  });

  test("unknown subcommand → clean usage error surfaces (not masked by the notice)", async () => {
    const r = await run(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage"); // the forwarded clean error, transparent
  });
});
