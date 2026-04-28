/**
 * Tests for small pure functions across multiple modules:
 * - deriveName from src/core/fleet/registry-oracle-scan-local.ts
 * - trySilent/trySilentAsync from src/core/util/try-silent.ts
 * - shortSha from src/core/consent/gate-plugin-install.ts
 * - q (quote) from src/core/transport/tmux-types.ts
 */
import { describe, it, expect } from "bun:test";
import { deriveName } from "../../src/core/fleet/registry-oracle-scan-local";
import { trySilent, trySilentAsync } from "../../src/core/util/try-silent";
import { shortSha } from "../../src/core/consent/gate-plugin-install";
import { q } from "../../src/core/transport/tmux-types";

// ─── deriveName ─────────────────────────────────────────────────────────────

describe("deriveName", () => {
  it("strips -oracle suffix", () => {
    expect(deriveName("neo-oracle")).toBe("neo");
  });

  it("keeps name without -oracle suffix", () => {
    expect(deriveName("mawjs")).toBe("mawjs");
  });

  it("only strips trailing -oracle", () => {
    expect(deriveName("oracle-keeper")).toBe("oracle-keeper");
  });

  it("handles empty string", () => {
    expect(deriveName("")).toBe("");
  });
});

// ─── trySilent ──────────────────────────────────────────────────────────────

describe("trySilent", () => {
  it("returns value on success", () => {
    expect(trySilent(() => 42)).toBe(42);
  });

  it("returns undefined on throw", () => {
    expect(trySilent(() => { throw new Error("boom"); })).toBeUndefined();
  });

  it("returns string value", () => {
    expect(trySilent(() => "hello")).toBe("hello");
  });

  it("returns null (not undefined)", () => {
    expect(trySilent(() => null)).toBeNull();
  });
});

describe("trySilentAsync", () => {
  it("returns value on success", async () => {
    expect(await trySilentAsync(async () => 42)).toBe(42);
  });

  it("returns undefined on throw", async () => {
    expect(await trySilentAsync(async () => { throw new Error("boom"); })).toBeUndefined();
  });
});

// ─── shortSha ───────────────────────────────────────────────────────────────

describe("shortSha", () => {
  it("returns first 8 chars of hex", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef12");
  });

  it("strips sha256: prefix", () => {
    expect(shortSha("sha256:deadbeef12345678")).toBe("deadbeef");
  });

  it("returns <no sha> for null", () => {
    expect(shortSha(null)).toBe("<no sha>");
  });

  it("returns <no sha> for undefined", () => {
    expect(shortSha(undefined)).toBe("<no sha>");
  });

  it("returns <no sha> for empty string", () => {
    expect(shortSha("")).toBe("<no sha>");
  });

  it("handles short hash", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

// ─── q (tmux quote) ─────────────────────────────────────────────────────────

describe("q (tmux quote)", () => {
  it("quotes a string", () => {
    const result = q("hello");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("quotes a number", () => {
    const result = q(42);
    expect(typeof result).toBe("string");
  });

  it("handles empty string", () => {
    const result = q("");
    expect(typeof result).toBe("string");
  });

  it("handles special characters", () => {
    const result = q("hello world");
    expect(result).toContain("hello world");
  });
});
