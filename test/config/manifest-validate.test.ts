/**
 * Tests for src/plugin/manifest-validate.ts — field validators.
 * Pure functions that validate manifest sections.
 */
import { describe, it, expect } from "bun:test";
import {
  parseCli, parseApi, parseHooks, parseCron, parseModule,
  parseTransport, parseTarget, parseCapabilities, parseArtifact,
} from "../../src/plugin/manifest-validate";

// ─── parseCli ─────────────────────────────────────────────────────

describe("parseCli", () => {
  it("returns undefined when cli is undefined", () => {
    expect(parseCli({})).toBeUndefined();
  });

  it("parses valid cli", () => {
    const result = parseCli({ cli: { command: "hello" } });
    expect(result?.command).toBe("hello");
  });

  it("parses cli with aliases", () => {
    const result = parseCli({ cli: { command: "hello", aliases: ["hi", "hey"] } });
    expect(result?.aliases).toEqual(["hi", "hey"]);
  });

  it("parses cli with flags", () => {
    const result = parseCli({ cli: { command: "hello", flags: { verbose: "boolean" } } });
    expect(result?.flags?.verbose).toBe("boolean");
  });

  it("throws for non-object cli", () => {
    expect(() => parseCli({ cli: "string" })).toThrow();
  });

  it("throws for missing command", () => {
    expect(() => parseCli({ cli: {} })).toThrow();
  });

  it("throws for invalid flag type", () => {
    expect(() => parseCli({ cli: { command: "x", flags: { v: "invalid" } } })).toThrow();
  });
});

// ─── parseApi ─────────────────────────────────────────────────────

describe("parseApi", () => {
  it("returns undefined when api is undefined", () => {
    expect(parseApi({})).toBeUndefined();
  });

  it("parses valid api", () => {
    const result = parseApi({ api: { path: "/test", methods: ["GET", "POST"] } });
    expect(result?.path).toBe("/test");
    expect(result?.methods).toEqual(["GET", "POST"]);
  });

  it("throws for missing path", () => {
    expect(() => parseApi({ api: { methods: ["GET"] } })).toThrow();
  });

  it("throws for invalid methods", () => {
    expect(() => parseApi({ api: { path: "/test", methods: ["PUT"] } })).toThrow();
  });
});

// ─── parseHooks ───────────────────────────────────────────────────

describe("parseHooks", () => {
  it("returns undefined when hooks is undefined", () => {
    expect(parseHooks({})).toBeUndefined();
  });

  it("parses valid hooks", () => {
    const result = parseHooks({ hooks: { gate: ["perm-check"], on: ["startup"] } });
    expect(result?.gate).toEqual(["perm-check"]);
    expect(result?.on).toEqual(["startup"]);
  });

  it("throws for non-string array in hooks", () => {
    expect(() => parseHooks({ hooks: { gate: [42] } })).toThrow();
  });
});

// ─── parseCron ────────────────────────────────────────────────────

describe("parseCron", () => {
  it("returns undefined when cron is undefined", () => {
    expect(parseCron({})).toBeUndefined();
  });

  it("parses valid cron", () => {
    const result = parseCron({ cron: { schedule: "*/5 * * * *" } });
    expect(result?.schedule).toBe("*/5 * * * *");
  });

  it("parses cron with handler", () => {
    const result = parseCron({ cron: { schedule: "* * * * *", handler: "onCron" } });
    expect(result?.handler).toBe("onCron");
  });

  it("throws for missing schedule", () => {
    expect(() => parseCron({ cron: {} })).toThrow();
  });
});

// ─── parseModule ──────────────────────────────────────────────────

describe("parseModule", () => {
  it("returns undefined when module is undefined", () => {
    expect(parseModule({})).toBeUndefined();
  });

  it("parses valid module", () => {
    const result = parseModule({ module: { exports: ["init"], path: "./dist/index.js" } });
    expect(result?.exports).toEqual(["init"]);
    expect(result?.path).toBe("./dist/index.js");
  });

  it("throws for empty exports", () => {
    expect(() => parseModule({ module: { exports: [], path: "./x" } })).toThrow();
  });
});

// ─── parseTransport ───────────────────────────────────────────────

describe("parseTransport", () => {
  it("returns undefined when transport is undefined", () => {
    expect(parseTransport({})).toBeUndefined();
  });

  it("parses with peer boolean", () => {
    expect(parseTransport({ transport: { peer: true } })?.peer).toBe(true);
  });

  it("throws for non-boolean peer", () => {
    expect(() => parseTransport({ transport: { peer: "yes" } })).toThrow();
  });
});

// ─── parseTarget ──────────────────────────────────────────────────

describe("parseTarget", () => {
  it("returns undefined when target is undefined", () => {
    expect(parseTarget({})).toBeUndefined();
  });

  it("accepts 'js' target", () => {
    expect(parseTarget({ target: "js" })).toBe("js");
  });

  it("throws for 'wasm' (not yet supported)", () => {
    expect(() => parseTarget({ target: "wasm" })).toThrow(/not yet supported/);
  });

  it("throws for unknown target", () => {
    expect(() => parseTarget({ target: "python" })).toThrow();
  });
});

// ─── parseArtifact ────────────────────────────────────────────────

describe("parseArtifact", () => {
  it("returns undefined when artifact is undefined", () => {
    expect(parseArtifact({})).toBeUndefined();
  });

  it("parses valid artifact", () => {
    const result = parseArtifact({ artifact: { path: "./dist/bundle.js", sha256: "abc123" } });
    expect(result?.path).toBe("./dist/bundle.js");
    expect(result?.sha256).toBe("abc123");
  });

  it("accepts null sha256", () => {
    const result = parseArtifact({ artifact: { path: "./x", sha256: null } });
    expect(result?.sha256).toBeNull();
  });

  it("throws for missing path", () => {
    expect(() => parseArtifact({ artifact: { sha256: "abc" } })).toThrow();
  });
});
