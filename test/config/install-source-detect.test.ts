/**
 * Tests for src/commands/plugins/plugin/install-source-detect.ts
 * — parsePeerSpec + detectMode (pure string functions).
 */
import { describe, it, expect } from "bun:test";
import {
  parsePeerSpec,
  detectMode,
} from "../../src/commands/plugins/plugin/install-source-detect";

// ─── parsePeerSpec ──────────────────────────────────────────────────────

describe("parsePeerSpec", () => {
  it("parses name@peer", () => {
    const r = parsePeerSpec("hello@myhost");
    expect(r).toEqual({ name: "hello", peer: "myhost" });
  });

  it("returns null for URL", () => {
    expect(parsePeerSpec("https://example.com/plugin")).toBeNull();
  });

  it("returns null for http URL", () => {
    expect(parsePeerSpec("http://example.com/plugin")).toBeNull();
  });

  it("returns null for absolute path", () => {
    expect(parsePeerSpec("/home/user/plugin")).toBeNull();
  });

  it("returns null for relative path (./ )", () => {
    expect(parsePeerSpec("./my-plugin")).toBeNull();
  });

  it("returns null for relative path (../)", () => {
    expect(parsePeerSpec("../my-plugin")).toBeNull();
  });

  it("returns null for tarball .tgz", () => {
    expect(parsePeerSpec("plugin.tgz")).toBeNull();
  });

  it("returns null for tarball .tar.gz", () => {
    expect(parsePeerSpec("plugin.tar.gz")).toBeNull();
  });

  it("returns null for no @ sign", () => {
    expect(parsePeerSpec("just-a-name")).toBeNull();
  });

  it("returns null for double @ (ambiguous)", () => {
    expect(parsePeerSpec("name@host@extra")).toBeNull();
  });

  it("returns null for invalid name (uppercase)", () => {
    expect(parsePeerSpec("BadName@host")).toBeNull();
  });

  it("returns null for invalid name (starts with digit)", () => {
    expect(parsePeerSpec("1plugin@host")).toBeNull();
  });

  it("allows hyphens in name", () => {
    const r = parsePeerSpec("my-plugin@host");
    expect(r).toEqual({ name: "my-plugin", peer: "host" });
  });

  it("allows dots in peer host", () => {
    const r = parsePeerSpec("plugin@my.host.com");
    expect(r).toEqual({ name: "plugin", peer: "my.host.com" });
  });

  it("allows underscores and hyphens in peer", () => {
    const r = parsePeerSpec("plugin@my_host-1");
    expect(r).toEqual({ name: "plugin", peer: "my_host-1" });
  });
});

// ─── detectMode ─────────────────────────────────────────────────────────

describe("detectMode", () => {
  it("detects URL", () => {
    const m = detectMode("https://example.com/plugin.tar.gz");
    expect(m.kind).toBe("url");
  });

  it("detects http URL", () => {
    const m = detectMode("http://example.com/plugin");
    expect(m.kind).toBe("url");
  });

  it("detects tarball by .tgz extension", () => {
    const m = detectMode("./plugin.tgz");
    expect(m.kind).toBe("tarball");
  });

  it("detects tarball by .tar.gz extension", () => {
    const m = detectMode("./plugin.tar.gz");
    expect(m.kind).toBe("tarball");
  });

  it("detects peer spec", () => {
    const m = detectMode("hello@myhost");
    expect(m.kind).toBe("peer");
    if (m.kind === "peer") {
      expect(m.name).toBe("hello");
      expect(m.peer).toBe("myhost");
    }
  });

  it("falls back to dir for plain path", () => {
    const m = detectMode("./my-plugin");
    expect(m.kind).toBe("dir");
  });

  it("falls back to dir for bare name without @", () => {
    const m = detectMode("my-plugin");
    expect(m.kind).toBe("dir");
  });

  it("resolves dir src to absolute path", () => {
    const m = detectMode("./relative-dir");
    expect(m.kind).toBe("dir");
    if (m.kind === "dir") {
      expect(m.src.startsWith("/")).toBe(true);
    }
  });

  it("resolves tarball src to absolute path", () => {
    const m = detectMode("./plugin.tgz");
    if (m.kind === "tarball") {
      expect(m.src.startsWith("/")).toBe(true);
    }
  });
});
