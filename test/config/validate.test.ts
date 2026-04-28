/**
 * Tests for src/config/validate.ts — validateBasicFields + validateConfigShape.
 *
 * Pure validation functions with no side effects, so no mocks needed.
 */
import { describe, it, expect } from "bun:test";
import { validateBasicFields, validateConfigShape } from "../../src/config/validate";

// ─── helpers ───────────────────────────────────────────────────────
function runBasic(raw: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  const warnings: string[] = [];
  validateBasicFields(raw, result, (field, msg) => warnings.push(`${field}: ${msg}`));
  return { result, warnings };
}

// ─── validateBasicFields ───────────────────────────────────────────

describe("validateBasicFields", () => {
  // host
  describe("host", () => {
    it("accepts a valid non-empty string", () => {
      const { result, warnings } = runBasic({ host: "my-host" });
      expect(result.host).toBe("my-host");
      expect(warnings).toHaveLength(0);
    });

    it("trims whitespace", () => {
      const { result } = runBasic({ host: "  trimmed  " });
      expect(result.host).toBe("trimmed");
    });

    it("rejects empty string", () => {
      const { result, warnings } = runBasic({ host: "" });
      expect(result.host).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects whitespace-only string", () => {
      const { result, warnings } = runBasic({ host: "   " });
      expect(result.host).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects non-string", () => {
      const { result, warnings } = runBasic({ host: 123 });
      expect(result.host).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("is optional — no warning when absent", () => {
      const { result, warnings } = runBasic({});
      expect(result.host).toBeUndefined();
      expect(warnings).toHaveLength(0);
    });
  });

  // port
  describe("port", () => {
    it("accepts valid port 3456", () => {
      const { result } = runBasic({ port: 3456 });
      expect(result.port).toBe(3456);
    });

    it("accepts port 1 (min)", () => {
      const { result } = runBasic({ port: 1 });
      expect(result.port).toBe(1);
    });

    it("accepts port 65535 (max)", () => {
      const { result } = runBasic({ port: 65535 });
      expect(result.port).toBe(65535);
    });

    it("coerces string '8080' to number", () => {
      const { result } = runBasic({ port: "8080" });
      expect(result.port).toBe(8080);
    });

    it("rejects port 0", () => {
      const { result, warnings } = runBasic({ port: 0 });
      expect(result.port).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects port 65536", () => {
      const { result, warnings } = runBasic({ port: 65536 });
      expect(result.port).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects negative port", () => {
      const { result, warnings } = runBasic({ port: -1 });
      expect(result.port).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects float port", () => {
      const { result, warnings } = runBasic({ port: 3.14 });
      expect(result.port).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects NaN string", () => {
      const { result, warnings } = runBasic({ port: "abc" });
      expect(result.port).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });

  // ghqRoot
  describe("ghqRoot", () => {
    it("accepts valid path", () => {
      const { result } = runBasic({ ghqRoot: "/home/user/Code" });
      expect(result.ghqRoot).toBe("/home/user/Code");
    });

    it("rejects empty string", () => {
      const { result, warnings } = runBasic({ ghqRoot: "" });
      expect(result.ghqRoot).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects non-string", () => {
      const { result, warnings } = runBasic({ ghqRoot: 42 });
      expect(result.ghqRoot).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });

  // oracleUrl
  describe("oracleUrl", () => {
    it("accepts valid URL string", () => {
      const { result } = runBasic({ oracleUrl: "http://localhost:47779" });
      expect(result.oracleUrl).toBe("http://localhost:47779");
    });

    it("rejects empty string", () => {
      const { warnings } = runBasic({ oracleUrl: "" });
      expect(warnings).toHaveLength(1);
    });
  });

  // env
  describe("env", () => {
    it("accepts valid object", () => {
      const { result } = runBasic({ env: { FOO: "bar", BAZ: "qux" } });
      expect(result.env).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("accepts empty object", () => {
      const { result, warnings } = runBasic({ env: {} });
      expect(result.env).toEqual({});
      expect(warnings).toHaveLength(0);
    });

    it("rejects array", () => {
      const { result, warnings } = runBasic({ env: ["a", "b"] });
      expect(result.env).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects null", () => {
      const { result, warnings } = runBasic({ env: null });
      expect(result.env).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });

  // commands
  describe("commands", () => {
    it("accepts valid commands with 'default' key", () => {
      const cmds = { default: "claude", "neo-*": "claude --resume abc" };
      const { result } = runBasic({ commands: cmds });
      expect(result.commands).toEqual(cmds);
    });

    it("rejects commands without 'default' key", () => {
      const { result, warnings } = runBasic({ commands: { foo: "bar" } });
      expect(result.commands).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("default");
    });

    it("rejects commands where default is not a string", () => {
      const { result, warnings } = runBasic({ commands: { default: 123 } });
      expect(result.commands).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it("rejects array", () => {
      const { warnings } = runBasic({ commands: ["a"] });
      expect(warnings).toHaveLength(1);
    });
  });

  // sessions
  describe("sessions", () => {
    it("accepts valid sessions object", () => {
      const { result } = runBasic({ sessions: { neo: "/path/to/session" } });
      expect(result.sessions).toEqual({ neo: "/path/to/session" });
    });

    it("rejects array", () => {
      const { warnings } = runBasic({ sessions: [] });
      expect(warnings).toHaveLength(1);
    });
  });

  // tmuxSocket
  describe("tmuxSocket", () => {
    it("accepts string", () => {
      const { result } = runBasic({ tmuxSocket: "maw" });
      expect(result.tmuxSocket).toBe("maw");
    });

    it("rejects non-string", () => {
      const { warnings } = runBasic({ tmuxSocket: 42 });
      expect(warnings).toHaveLength(1);
    });
  });

  // multiple fields at once
  it("validates multiple fields in one pass", () => {
    const { result, warnings } = runBasic({
      host: "prod",
      port: 4000,
      ghqRoot: "/code",
      env: { KEY: "val" },
      commands: { default: "claude" },
      sessions: {},
    });
    expect(warnings).toHaveLength(0);
    expect(result.host).toBe("prod");
    expect(result.port).toBe(4000);
  });

  it("collects warnings for multiple bad fields", () => {
    const { warnings } = runBasic({
      host: "",
      port: -1,
      env: null,
      commands: [],
    });
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── validateConfigShape ───────────────────────────────────────────

describe("validateConfigShape", () => {
  it("returns empty array for valid minimal config", () => {
    expect(validateConfigShape({ host: "local", port: 3456 })).toEqual([]);
  });

  it("returns empty array for empty object", () => {
    expect(validateConfigShape({})).toEqual([]);
  });

  it("rejects null", () => {
    const errors = validateConfigShape(null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("object");
  });

  it("rejects non-object", () => {
    expect(validateConfigShape("string")).toHaveLength(1);
    expect(validateConfigShape(42)).toHaveLength(1);
  });

  it("catches invalid host type", () => {
    const errors = validateConfigShape({ host: 123 });
    expect(errors.some(e => e.includes("host"))).toBe(true);
  });

  it("catches invalid port — float", () => {
    const errors = validateConfigShape({ port: 3.14 });
    expect(errors.some(e => e.includes("port"))).toBe(true);
  });

  it("catches invalid port — out of range", () => {
    expect(validateConfigShape({ port: 0 }).some(e => e.includes("port"))).toBe(true);
    expect(validateConfigShape({ port: 70000 }).some(e => e.includes("port"))).toBe(true);
  });

  it("catches invalid env — array", () => {
    const errors = validateConfigShape({ env: [1, 2] });
    expect(errors.some(e => e.includes("env"))).toBe(true);
  });

  it("catches invalid env values — non-string", () => {
    const errors = validateConfigShape({ env: { FOO: 123 } });
    expect(errors.some(e => e.includes("env.FOO"))).toBe(true);
  });

  it("catches invalid commands — array", () => {
    const errors = validateConfigShape({ commands: [] });
    expect(errors.some(e => e.includes("commands"))).toBe(true);
  });

  it("catches invalid commands values", () => {
    const errors = validateConfigShape({ commands: { default: 42 } });
    expect(errors.some(e => e.includes("commands.default"))).toBe(true);
  });

  it("catches invalid sessions", () => {
    const errors = validateConfigShape({ sessions: "nope" });
    expect(errors.some(e => e.includes("sessions"))).toBe(true);
  });

  it("catches invalid peers — not array", () => {
    const errors = validateConfigShape({ peers: "nope" });
    expect(errors.some(e => e.includes("peers"))).toBe(true);
  });

  it("catches invalid peer entries", () => {
    const errors = validateConfigShape({ peers: [123, "ok"] });
    expect(errors.some(e => e.includes("peers[0]"))).toBe(true);
  });

  it("catches invalid federationToken type", () => {
    const errors = validateConfigShape({ federationToken: 123 });
    expect(errors.some(e => e.includes("federationToken"))).toBe(true);
  });

  it("accepts valid full config", () => {
    const errors = validateConfigShape({
      host: "prod",
      port: 3456,
      ghqRoot: "/code",
      oracleUrl: "http://localhost:47779",
      tmuxSocket: "maw",
      federationToken: "abc123",
      env: { KEY: "val" },
      commands: { default: "claude" },
      sessions: { neo: "sess1" },
      peers: ["http://peer1:3456"],
    });
    expect(errors).toEqual([]);
  });

  it("accumulates multiple errors", () => {
    const errors = validateConfigShape({
      host: 123,
      port: "abc",
      env: [],
      commands: null,
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
