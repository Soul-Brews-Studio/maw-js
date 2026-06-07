import { describe, expect, test } from "bun:test";
import { processMirror } from "../../src/lib/process-mirror";
import { isUserError, UserError } from "../../src/core/util/user-error";
import { LoRaTransport } from "../../src/transports/lora";
import { discoveryTransport } from "../../src/transports";

describe("tiny pure core helpers and transport stubs", () => {
  test("processMirror filters empty lines, normalizes separators, tails, and pads", () => {
    const raw = [
      "",
      "first",
      "────── decorative ━━━━━━",
      "   ",
      "second",
      "third",
    ].join("\n");

    expect(processMirror(raw, 2)).toBe("second\nthird");
    expect(processMirror(raw, 5)).toBe([
      "",
      "first",
      `${"─".repeat(60)} decorative ${"─".repeat(60)}`,
      "second",
      "third",
    ].join("\n"));
    expect(processMirror("only", 3)).toBe("\n\nonly");
    expect(processMirror("\n  \n", 2)).toBe("\n\n");
  });

  test("UserError carries the cross-module brand and guard rejects impostors", () => {
    const err = new UserError("bad target");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UserError");
    expect(err.message).toBe("bad target");
    expect(err.isUserError).toBe(true);
    expect(isUserError(err)).toBe(true);
    expect(isUserError(new Error("regular"))).toBe(false);
    expect(isUserError({ isUserError: true })).toBe(false);
    expect(isUserError(null)).toBe(false);
  });

  test("LoRa transport stays an inert disconnected future-hardware stub", async () => {
    const transport = new LoRaTransport();
    const calls: string[] = [];
    transport.onMessage(() => calls.push("message"));
    transport.onPresence(() => calls.push("presence"));
    transport.onFeed(() => calls.push("feed"));

    expect(transport.name).toBe("lora");
    expect(transport.connected).toBe(false);
    await transport.connect();
    expect(transport.connected).toBe(false);
    expect(transport.canReach({ oracle: "neo" })).toBe(false);
    expect(await transport.send({ oracle: "neo" }, "hello")).toBe(false);
    await transport.publishPresence({ oracle: "neo", host: "m5", status: "ready", timestamp: 1 });
    await transport.publishFeed({ timestamp: "2026-05-16 00:00:00", oracle: "neo", host: "m5", event: "SessionStart", project: "", sessionId: "", message: "", ts: 1 });
    await transport.disconnect();
    expect(transport.connected).toBe(false);
    expect(calls).toEqual([]);
  });

  test("discoveryTransport honors configured fallbacks and disabled zenoh-scout plugin", () => {
    expect(discoveryTransport({})).toBe("scout");
    expect(discoveryTransport({ discovery: { transport: "scout" } })).toBe("scout");
    expect(discoveryTransport({ discovery: { transport: "off" } })).toBe("off");
    expect(discoveryTransport({ discovery: { transport: "zenoh" } })).toBe("zenoh");
    expect(discoveryTransport({ discovery: { transport: "both" } })).toBe("both");
    expect(discoveryTransport({ zenoh: { scout: { enabled: true } } })).toBe("both");
    expect(discoveryTransport({ zenoh: { scout: { enabled: false } } })).toBe("scout");
    expect(discoveryTransport({ discovery: { transport: "zenoh" }, disabledPlugins: ["zenoh-scout"] })).toBe("off");
    expect(discoveryTransport({ discovery: { transport: "both" }, disabledPlugins: ["zenoh-scout"] })).toBe("scout");
  });
});
