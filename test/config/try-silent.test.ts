/**
 * Tests for src/core/util/try-silent.ts — trySilent, trySilentAsync.
 * Pure wrappers: call fn, return result or undefined on throw.
 */
import { describe, it, expect } from "bun:test";
import { trySilent, trySilentAsync } from "../../src/core/util/try-silent";

describe("trySilent", () => {
  it("returns value on success", () => {
    expect(trySilent(() => 42)).toBe(42);
  });

  it("returns string on success", () => {
    expect(trySilent(() => "hello")).toBe("hello");
  });

  it("returns null on success (not confused with undefined)", () => {
    expect(trySilent(() => null)).toBeNull();
  });

  it("returns undefined on throw", () => {
    expect(trySilent(() => { throw new Error("boom"); })).toBeUndefined();
  });

  it("returns undefined on non-Error throw", () => {
    expect(trySilent(() => { throw "string error"; })).toBeUndefined();
  });

  it("returns object on success", () => {
    const obj = { a: 1 };
    expect(trySilent(() => obj)).toBe(obj);
  });

  it("returns false on success (not confused with failure)", () => {
    expect(trySilent(() => false)).toBe(false);
  });

  it("returns 0 on success (not confused with failure)", () => {
    expect(trySilent(() => 0)).toBe(0);
  });

  it("returns empty string on success", () => {
    expect(trySilent(() => "")).toBe("");
  });
});

describe("trySilentAsync", () => {
  it("returns value on success", async () => {
    expect(await trySilentAsync(async () => 42)).toBe(42);
  });

  it("returns undefined on rejected promise", async () => {
    expect(await trySilentAsync(async () => { throw new Error("boom"); })).toBeUndefined();
  });

  it("returns undefined on non-Error rejection", async () => {
    expect(await trySilentAsync(async () => { throw "string error"; })).toBeUndefined();
  });

  it("returns null on success", async () => {
    expect(await trySilentAsync(async () => null)).toBeNull();
  });

  it("returns false on success (not confused with failure)", async () => {
    expect(await trySilentAsync(async () => false)).toBe(false);
  });

  it("handles delayed resolution", async () => {
    const result = await trySilentAsync(() => new Promise<string>(r => setTimeout(() => r("ok"), 10)));
    expect(result).toBe("ok");
  });

  it("handles delayed rejection", async () => {
    const result = await trySilentAsync(() => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("fail")), 10)));
    expect(result).toBeUndefined();
  });
});
