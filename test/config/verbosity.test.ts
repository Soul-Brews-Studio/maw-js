/**
 * Tests for verbosity flags from src/cli/verbosity.ts.
 * Tests the pure predicate logic — setVerbosityFlags, isQuiet, isSilent.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setVerbosityFlags, isQuiet, isSilent } from "../../src/cli/verbosity";

describe("verbosity", () => {
  const origQuiet = process.env.MAW_QUIET;
  const origSilent = process.env.MAW_SILENT;
  const origArgv = [...process.argv];

  beforeEach(() => {
    setVerbosityFlags({});
    delete process.env.MAW_QUIET;
    delete process.env.MAW_SILENT;
    process.argv = ["bun", "test"];
  });

  afterEach(() => {
    if (origQuiet !== undefined) process.env.MAW_QUIET = origQuiet;
    else delete process.env.MAW_QUIET;
    if (origSilent !== undefined) process.env.MAW_SILENT = origSilent;
    else delete process.env.MAW_SILENT;
    process.argv = origArgv;
    setVerbosityFlags({});
  });

  describe("isSilent", () => {
    it("returns false by default", () => {
      expect(isSilent()).toBe(false);
    });

    it("returns true when flag set", () => {
      setVerbosityFlags({ silent: true });
      expect(isSilent()).toBe(true);
    });

    it("returns true from env MAW_SILENT=1", () => {
      process.env.MAW_SILENT = "1";
      expect(isSilent()).toBe(true);
    });

    it("flag overrides env", () => {
      process.env.MAW_SILENT = "1";
      setVerbosityFlags({ silent: false });
      expect(isSilent()).toBe(false);
    });
  });

  describe("isQuiet", () => {
    it("returns false by default", () => {
      expect(isQuiet()).toBe(false);
    });

    it("returns true when quiet flag set", () => {
      setVerbosityFlags({ quiet: true });
      expect(isQuiet()).toBe(true);
    });

    it("returns true when silent flag set (silent implies quiet)", () => {
      setVerbosityFlags({ silent: true });
      expect(isQuiet()).toBe(true);
    });

    it("returns true from env MAW_QUIET=1", () => {
      process.env.MAW_QUIET = "1";
      expect(isQuiet()).toBe(true);
    });

    it("flag overrides env", () => {
      process.env.MAW_QUIET = "1";
      setVerbosityFlags({ quiet: false });
      expect(isQuiet()).toBe(false);
    });

    it("returns true when argv contains --help", () => {
      process.argv = ["bun", "test", "--help"];
      setVerbosityFlags({});
      expect(isQuiet()).toBe(true);
    });

    it("returns true when argv contains -h", () => {
      process.argv = ["bun", "test", "-h"];
      setVerbosityFlags({});
      expect(isQuiet()).toBe(true);
    });

    it("returns true when argv contains --version", () => {
      process.argv = ["bun", "test", "--version"];
      setVerbosityFlags({});
      expect(isQuiet()).toBe(true);
    });
  });
});
