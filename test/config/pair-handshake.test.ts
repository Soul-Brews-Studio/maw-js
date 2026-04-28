/**
 * Tests for src/commands/plugins/pair/handshake.ts — warnIfPlainHttp.
 * Pure URL analysis function.
 */
import { describe, it, expect, spyOn } from "bun:test";
import { warnIfPlainHttp } from "../../src/commands/plugins/pair/handshake";

describe("warnIfPlainHttp", () => {
  it("warns for http:// non-loopback", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    warnIfPlainHttp("http://remote-host:3456");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("plain HTTP");
    spy.mockRestore();
  });

  it("does not warn for https://", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    warnIfPlainHttp("https://remote-host:3456");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not warn for http://localhost", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    warnIfPlainHttp("http://localhost:3456");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not warn for http://127.0.0.1", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    warnIfPlainHttp("http://127.0.0.1:3456");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns for http://[::1] (bracket form not matched)", () => {
    // URL("http://[::1]:3456").hostname is "[::1]" not "::1" — known edge case
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    warnIfPlainHttp("http://[::1]:3456");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not throw for invalid URL", () => {
    expect(() => warnIfPlainHttp("not a url")).not.toThrow();
  });
});
