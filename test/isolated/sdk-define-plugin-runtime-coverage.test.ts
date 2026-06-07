/**
 * @summary Runtime smoke for packages/sdk/define.ts (ABI-style plugin declaration surface).
 */

import { describe, expect, test } from "bun:test";
import { definePlugin } from "../../packages/sdk/define";

describe("definePlugin runtime contract", () => {
  test("returns manifest with an implement() helper", () => {
    const plugin = definePlugin({
      name: "relay",
      hooks: {
        on: ["transport:after_send"],
      },
      module: {
        path: "./impl.ts",
        exports: ["onTransportAfterSend"],
      },
    } as const);

    expect(plugin.name).toBe("relay");
    expect(plugin.module.path).toBe("./impl.ts");
    expect(typeof plugin.implement).toBe("function");

    const withHandler = plugin.implement({
      onTransportAfterSend(event) {
        expect(event.result.ok).toBe(true);
      },
    });

    expect(withHandler.onTransportAfterSend).toBeDefined();
  });
});
