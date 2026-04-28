/**
 * Tests for src/core/runtime/sdk-print.ts — terminal output helpers.
 */
import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { print } from "../../src/core/runtime/sdk-print";

describe("sdk-print", () => {
  let spy: ReturnType<typeof spyOn>;

  afterEach(() => {
    spy?.mockRestore();
  });

  it("header outputs text", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.header("Test Header");
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Test Header");
  });

  it("ok outputs with checkmark", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.ok("All good");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("All good");
  });

  it("warn outputs text", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.warn("Watch out");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Watch out");
  });

  it("err outputs text", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.err("Something failed");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Something failed");
  });

  it("dim outputs text", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.dim("Subtle info");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Subtle info");
  });

  it("list outputs items", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.list(["item1", "item2", "item3"]);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("list uses custom dot and color", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.list(["test"], "★", "\x1b[34m");
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("★");
  });

  it("list handles empty array", () => {
    spy = spyOn(console, "log").mockImplementation(() => {});
    print.list([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
