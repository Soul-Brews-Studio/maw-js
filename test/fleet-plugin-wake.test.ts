/**
 * Tests for #1152 — `maw fleet wake` CLI subcommand.
 *
 * Verifies the new route in the fleet plugin invokes `cmdWakeAll` with the
 * correct flags, and that --help lists the new subcommand.
 */
import { describe, test, expect, mock } from "bun:test";
import type { InvokeContext } from "../src/plugin/types";

// Capture cmdWakeAll invocations so the test doesn't actually spawn tmux sessions.
const wakeCalls: any[] = [];
mock.module("../src/commands/shared/fleet", () => ({
  cmdWakeAll: async (opts: any) => { wakeCalls.push(opts); },
  cmdSleep: async () => {},
  cmdFleetLs: async () => {},
  cmdFleetRenumber: async () => {},
  cmdFleetValidate: async () => {},
  cmdFleetSyncConfigs: async () => {},
  cmdFleetSync: async () => {},
}));

// Mock fleet-hibernate so `resume`/`hibernate`/`status` don't hit real tmux
mock.module("../src/commands/plugins/fleet/fleet-hibernate", () => ({
  cmdHibernate: async () => {},
  cmdResume: async () => {},
  cmdFleetStatus: async () => {},
}));

const { default: fleetHandler } = await import("../src/commands/plugins/fleet/index");

const cliCtx = (args: string[]): InvokeContext => ({ source: "cli", args });

describe("maw fleet wake (#1152)", () => {
  test("--help lists the new wake subcommand", async () => {
    const result = await fleetHandler(cliCtx(["--help"]));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("wake [--all] [--kill]");
    expect(result.output).toContain("cold-start all fleet sessions");
  });

  test("`maw fleet wake` invokes cmdWakeAll with no flags", async () => {
    wakeCalls.length = 0;
    const result = await fleetHandler(cliCtx(["wake"]));
    expect(result.ok).toBe(true);
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]).toEqual({ all: false, kill: false });
  });

  test("`maw fleet wake --all` passes all=true", async () => {
    wakeCalls.length = 0;
    await fleetHandler(cliCtx(["wake", "--all"]));
    expect(wakeCalls[0].all).toBe(true);
    expect(wakeCalls[0].kill).toBe(false);
  });

  test("`maw fleet wake --kill` passes kill=true", async () => {
    wakeCalls.length = 0;
    await fleetHandler(cliCtx(["wake", "--kill"]));
    expect(wakeCalls[0].kill).toBe(true);
    expect(wakeCalls[0].all).toBe(false);
  });

  test("`maw fleet wake --all --kill` passes both", async () => {
    wakeCalls.length = 0;
    await fleetHandler(cliCtx(["wake", "--all", "--kill"]));
    expect(wakeCalls[0]).toEqual({ all: true, kill: true });
  });

  test("`maw fleet resume` does NOT route to cmdWakeAll (distinct from hibernate-pair)", async () => {
    wakeCalls.length = 0;
    // We don't fully invoke cmdResume here; just verify it doesn't accidentally
    // call cmdWakeAll. The route may error out due to mocked deps, but the
    // important assertion is that wake-all wasn't invoked.
    await fleetHandler(cliCtx(["resume"])).catch(() => {});
    expect(wakeCalls).toHaveLength(0);
  });

  test("unknown subcommand error mentions wake", async () => {
    const result = await fleetHandler(cliCtx(["nonexistent"]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wake");
  });
});
