import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");

describe("serve-tmux-stream-ws plugin removal regression (#2466)", () => {
  test("duplicate serve WebSocket plugin remains removed", () => {
    expect(existsSync(join(root, "src/vendor-plugins/serve-tmux-stream-ws"))).toBe(false);
  });
});
