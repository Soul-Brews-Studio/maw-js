import { describe, expect, test } from "bun:test";
import { canonicalSessionName } from "../src/core/fleet/session-name";

describe("canonicalSessionName guard rails", () => {
  test("strips only fleet/trailing oracle adornments and preserves readable internal dashes", () => {
    expect(canonicalSessionName("mawjs-oracle")).toBe("mawjs");
    expect(canonicalSessionName("mawjs-codex-oracle")).toBe("mawjs-codex");
    expect(canonicalSessionName("maw-m5-oracle")).toBe("maw-m5");
    expect(canonicalSessionName("51-maw-js-oracle")).toBe("maw-js");
    expect(canonicalSessionName({ oracle: "mawjs-codex-oracle", slot: 50 })).toBe("50-mawjs-codex");
  });

  test("rejects invalid slot values", () => {
    expect(() => canonicalSessionName({ oracle: "neo-oracle", slot: -1 })).toThrow("invalid fleet slot");
    expect(() => canonicalSessionName({ oracle: "neo-oracle", slot: 100 })).toThrow("invalid fleet slot");
  });
});
