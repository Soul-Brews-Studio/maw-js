import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const sdkPath = join(import.meta.dir, "../../packages/sdk/index.ts");
const dtsPath = join(import.meta.dir, "../../packages/sdk/index.d.ts");

describe("sdk messages helper exports (#2157)", () => {
  test("runtime SDK exports xdg path helpers and message lifecycle helpers", async () => {
    const sdk = await import("../../packages/sdk/index");

    expect(typeof sdk.mawStatePath).toBe("function");
    expect(typeof sdk.mawConfigPath).toBe("function");
    expect(typeof sdk.mawDataPath).toBe("function");
    expect(typeof sdk.buildMessageLifecycleData).toBe("function");
    expect(typeof sdk.buildMessageLifecycleFeedEvent).toBe("function");
    expect(typeof sdk.isMessageLifecycleData).toBe("function");

    const data = sdk.buildMessageLifecycleData({
      id: "msg-1",
      ts: "2026-06-06T00:00:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "m5:mawjs",
      to: "m5:oracle",
      text: "hello",
    });

    expect(sdk.isMessageLifecycleData(data)).toBe(true);
    expect(data.id).toBe("msg-1");
  });

  test("sdk declarations include xdg helpers and message lifecycle types", () => {
    const source = readFileSync(sdkPath, "utf8");
    const dts = readFileSync(dtsPath, "utf8");

    for (const symbol of [
      "mawStatePath",
      "mawConfigPath",
      "mawDataPath",
      "buildMessageLifecycleData",
      "buildMessageLifecycleFeedEvent",
      "isMessageLifecycleData",
      "MessageLifecycleData",
      "MessageLifecycleInput",
      "MessageDirection",
      "MessageState",
    ]) {
      expect(source + dts).toContain(symbol);
    }
  });
});
