import { describe, expect, test } from "bun:test";
import {
  buildWormholeLifecycleData,
  buildWormholeLifecycleFeedEvent,
  isWormholeLifecycleData,
  type WormholeLifecycleInput,
} from "../src/lib/wormhole-events";

const baseInput: WormholeLifecycleInput = {
  id: "wh-1",
  ts: new Date("2026-05-20T11:51:00.000Z"),
  direction: "relayed",
  state: "delivered",
  cmd: "/dig",
  args: ["--deep"],
  origin: "[oracle-world:mawjs]",
  peer: "white",
  peerUrl: "http://white.wg:3456",
  trustTier: "readonly",
  elapsedMs: 137,
  status: 200,
  outputBytes: 9_482,
};

describe("wormhole lifecycle event builders", () => {
  test("buildWormholeLifecycleData fills stable fields and optional metadata", () => {
    const data = buildWormholeLifecycleData(baseInput);
    expect(data).toEqual({
      id: "wh-1",
      ts: "2026-05-20T11:51:00.000Z",
      direction: "relayed",
      state: "delivered",
      cmd: "/dig",
      args: ["--deep"],
      origin: "[oracle-world:mawjs]",
      peer: "white",
      peerUrl: "http://white.wg:3456",
      trustTier: "readonly",
      elapsedMs: 137,
      status: 200,
      outputBytes: 9_482,
    });
  });

  test("buildWormholeLifecycleData normalizes timestamps and truncates long fields", () => {
    const longCmd = "/x" + "y".repeat(600);
    const longError = "e".repeat(1_010);
    const longArg = "a".repeat(550);
    const tooManyArgs = [longArg, ...Array.from({ length: 59 }, (_, i) => `arg${i}`)];
    const data = buildWormholeLifecycleData({
      ...baseInput,
      id: undefined,
      ts: 1_700_000_000_000,
      cmd: longCmd,
      args: tooManyArgs,
      error: longError,
      state: "failed",
    });

    expect(data.id).toBeTruthy();
    expect(data.ts).toBe("2023-11-14T22:13:20.000Z");
    expect(data.cmd).toHaveLength(500);
    expect(data.cmd.endsWith("…")).toBe(true);
    expect(data.args).toHaveLength(50);
    expect(data.args[0]).toHaveLength(500);
    expect(data.args[0].endsWith("…")).toBe(true);
    expect(data.args.at(-1)).toBe("arg48");
    expect(data.error).toHaveLength(1_000);
    expect(data.error?.endsWith("…")).toBe(true);
  });

  test("buildWormholeLifecycleFeedEvent maps state to feed event type", () => {
    const delivered = buildWormholeLifecycleFeedEvent(baseInput);
    expect(delivered.event).toBe("WormholeRequest");
    expect(delivered.host).toBe("oracle-world");
    expect(delivered.oracle).toBe("mawjs");
    expect(delivered.sessionId).toBe("white");
    expect(delivered.message).toContain("relayed/delivered");
    expect(delivered.message).toContain("[oracle-world:mawjs] → white");
    expect(delivered.message).toContain("cmd=/dig");
    expect(delivered.message).toContain("tier=readonly");
    expect(delivered.message).toContain("status=200");

    const failed = buildWormholeLifecycleFeedEvent({
      ...baseInput,
      state: "failed",
      error: "shell_peer_denied",
      trustTier: "denied",
    });
    expect(failed.event).toBe("WormholeFail");
    expect(failed.message).toContain("error=shell_peer_denied");
    expect(failed.message).toContain("tier=denied");

    const queued = buildWormholeLifecycleFeedEvent({ ...baseInput, state: "queued" });
    expect(queued.event).toBe("WormholeRequest");
  });

  test("buildWormholeLifecycleFeedEvent handles unsigned origin and invalid timestamp fallback", () => {
    const before = Date.now();
    const event = buildWormholeLifecycleFeedEvent({
      ...baseInput,
      ts: "not-a-date",
      origin: "unsigned",
    });
    const after = Date.now();
    expect(event.host).toBe("local");
    expect(event.oracle).toBe("unsigned");
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after + 5);
  });

  test("buildWormholeLifecycleData defaults blank timestamps to now", () => {
    const before = Date.now();
    const data = buildWormholeLifecycleData({ ...baseInput, ts: "" });
    const after = Date.now();
    expect(new Date(data.ts).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(data.ts).getTime()).toBeLessThanOrEqual(after + 5);
  });

  test("buildWormholeLifecycleData omits undefined optional fields", () => {
    const data = buildWormholeLifecycleData({
      ...baseInput,
      peerUrl: undefined,
      elapsedMs: undefined,
      status: undefined,
      outputBytes: undefined,
    });
    expect(data.peerUrl).toBeUndefined();
    expect(data.elapsedMs).toBeUndefined();
    expect(data.status).toBeUndefined();
    expect(data.outputBytes).toBeUndefined();
  });

  test("isWormholeLifecycleData accepts complete payloads and rejects malformed values", () => {
    const data = buildWormholeLifecycleData(baseInput);
    expect(isWormholeLifecycleData(data)).toBe(true);
    expect(isWormholeLifecycleData(null)).toBe(false);
    expect(isWormholeLifecycleData("nope")).toBe(false);
    expect(isWormholeLifecycleData({ ...data, id: 123 })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, direction: "sideways" })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, state: "lost" })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, cmd: 7 })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, args: "not-an-array" })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, origin: 7 })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, peer: 7 })).toBe(false);
    expect(isWormholeLifecycleData({ ...data, trustTier: "owner" })).toBe(false);
  });
});
