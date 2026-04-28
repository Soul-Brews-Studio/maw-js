/**
 * Tests for src/core/util/terminal.ts — tlink, supportsHyperlinks.
 * Environment-dependent but testable with env var overrides.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tlink, supportsHyperlinks } from "../../src/core/util/terminal";

describe("tlink", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.NO_HYPERLINKS = process.env.NO_HYPERLINKS;
    savedEnv.FORCE_HYPERLINKS = process.env.FORCE_HYPERLINKS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns plain text when hyperlinks disabled", () => {
    process.env.NO_HYPERLINKS = "1";
    delete process.env.FORCE_HYPERLINKS;
    expect(tlink("https://example.com")).toBe("https://example.com");
  });

  it("returns custom text when hyperlinks disabled", () => {
    process.env.NO_HYPERLINKS = "1";
    expect(tlink("https://example.com", "Click here")).toBe("Click here");
  });

  it("returns OSC-8 when forced", () => {
    delete process.env.NO_HYPERLINKS;
    process.env.FORCE_HYPERLINKS = "1";
    const result = tlink("https://example.com", "Link");
    expect(result).toContain("\x1b]8;;https://example.com\x07");
    expect(result).toContain("Link");
  });
});

describe("supportsHyperlinks", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["NO_HYPERLINKS", "FORCE_HYPERLINKS", "TMUX", "TERM_PROGRAM", "TERM", "WT_SESSION"]) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns false when NO_HYPERLINKS set", () => {
    process.env.NO_HYPERLINKS = "1";
    expect(supportsHyperlinks()).toBe(false);
  });

  it("returns true when FORCE_HYPERLINKS set", () => {
    delete process.env.NO_HYPERLINKS;
    process.env.FORCE_HYPERLINKS = "1";
    expect(supportsHyperlinks()).toBe(true);
  });

  it("returns false in TMUX environment", () => {
    delete process.env.NO_HYPERLINKS;
    delete process.env.FORCE_HYPERLINKS;
    process.env.TMUX = "/tmp/tmux-501/default,1234,0";
    expect(supportsHyperlinks()).toBe(false);
  });
});
