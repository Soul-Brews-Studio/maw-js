/**
 * Tests for shortenHome and surfaces from src/commands/shared/plugins-ui.ts.
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { shortenHome, surfaces } from "../../src/commands/shared/plugins-ui";
import { homedir } from "os";

describe("shortenHome", () => {
  const home = homedir();

  it("replaces home directory with ~", () => {
    expect(shortenHome(home + "/projects/maw")).toBe("~/projects/maw");
  });

  it("returns path unchanged if not under home", () => {
    expect(shortenHome("/tmp/something")).toBe("/tmp/something");
  });

  it("handles exact home directory", () => {
    expect(shortenHome(home)).toBe("~");
  });

  it("handles deeply nested path", () => {
    expect(shortenHome(home + "/a/b/c/d/e")).toBe("~/a/b/c/d/e");
  });
});

describe("surfaces", () => {
  it("returns dash for no cli or api", () => {
    const plugin = { manifest: {} } as any;
    expect(surfaces(plugin)).toBe("—");
  });

  it("returns cli surface", () => {
    const plugin = { manifest: { cli: { command: "ping" } } } as any;
    expect(surfaces(plugin)).toBe("cli:ping");
  });

  it("returns api surface", () => {
    const plugin = { manifest: { api: { path: "/health" } } } as any;
    expect(surfaces(plugin)).toBe("api:/health");
  });

  it("returns both surfaces", () => {
    const plugin = {
      manifest: { cli: { command: "ping" }, api: { path: "/health" } },
    } as any;
    expect(surfaces(plugin)).toBe("cli:ping, api:/health");
  });
});
