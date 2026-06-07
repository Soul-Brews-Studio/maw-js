/** Targeted isolated coverage for thin re-export modules absent from LCOV. */
import { describe, expect, test } from "bun:test";

describe("thin re-export module coverage", () => {
  test("shared thin modules expose their re-exported command surfaces", async () => {
    const split = await import("../../src/commands/plugins/split/impl");
    const fleet = await import("../../src/commands/shared/fleet");
    const pulse = await import("../../src/commands/shared/pulse");
    const sdk = await import("../../src/sdk/index");
    const tmuxTypes = await import("../../src/core/transport/tmux-types");

    expect(typeof split.cmdSplit).toBe("function");
    expect(typeof fleet.cmdFleetLs).toBe("function");
    expect(typeof fleet.cmdFleetRename).toBe("function");
    expect(typeof fleet.cmdFleetRenumber).toBe("function");
    expect(typeof fleet.cmdFleetValidate).toBe("function");
    expect(typeof fleet.cmdFleetSync).toBe("function");
    expect(typeof fleet.cmdFleetSyncConfigs).toBe("function");
    expect(typeof fleet.cmdSleep).toBe("function");
    expect(typeof fleet.cmdWakeAll).toBe("function");
    expect(typeof pulse.todayDate).toBe("function");
    expect(typeof pulse.todayLabel).toBe("function");
    expect(typeof pulse.timePeriod).toBe("function");
    expect(typeof pulse.cmdPulseAdd).toBe("function");
    expect(typeof pulse.cmdPulseLs).toBe("function");

    expect(sdk.definePlugin({
      name: "thin-reexport-smoke",
      handler: () => ({ ok: true }),
    })).toMatchObject({ name: "thin-reexport-smoke" });
    expect(() => sdk.definePlugin({ name: "", handler: () => ({ ok: true }) })).toThrow("name is required");
    expect(() => sdk.definePlugin({ name: "bad" } as any)).toThrow("handler is required");

    const oldSocket = process.env.MAW_TMUX_SOCKET;
    process.env.MAW_TMUX_SOCKET = "/tmp/maw socket";
    try {
      expect(tmuxTypes.resolveSocket()).toBe("/tmp/maw socket");
      expect(tmuxTypes.tmuxCmd()).toBe("tmux -S '/tmp/maw socket'");
      expect(tmuxTypes.q("safe-target:1.0")).toBe("safe-target:1.0");
      expect(tmuxTypes.q("quote's target")).toBe("'quote'\\''s target'");
    } finally {
      if (oldSocket === undefined) delete process.env.MAW_TMUX_SOCKET;
      else process.env.MAW_TMUX_SOCKET = oldSocket;
    }
  });
});
