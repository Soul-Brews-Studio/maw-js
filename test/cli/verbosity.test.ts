/**
 * Tests for src/cli/verbosity.ts — #343 part A (task #2).
 *
 * verbosity.ts holds module-level state, so beforeEach resets both the stored
 * flags and the env vars to guarantee test isolation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isQuiet,
  isSilent,
  setVerbosityFlags,
  verbose,
  warn,
  info,
  error,
} from "../../src/cli/verbosity";

describe("verbosity", () => {
  // process.argv is mutated by some tests below; snapshot + restore.
  const origArgv = process.argv;

  beforeEach(() => {
    setVerbosityFlags({});
    delete process.env.MAW_QUIET;
    delete process.env.MAW_SILENT;
    process.argv = [...origArgv];
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  test("default: no flag, no env → neither quiet nor silent", () => {
    expect(isQuiet()).toBe(false);
    expect(isSilent()).toBe(false);
  });

  test("--quiet flag: quiet true, silent false", () => {
    setVerbosityFlags({ quiet: true });
    expect(isQuiet()).toBe(true);
    expect(isSilent()).toBe(false);
  });

  test("--silent flag: silent true AND implies quiet", () => {
    setVerbosityFlags({ silent: true });
    expect(isSilent()).toBe(true);
    expect(isQuiet()).toBe(true);
  });

  test("env-only MAW_QUIET=1 → quiet true without any flag", () => {
    process.env.MAW_QUIET = "1";
    expect(isQuiet()).toBe(true);
    expect(isSilent()).toBe(false);
  });

  test("flag overrides env: explicit quiet:false beats MAW_QUIET=1", () => {
    process.env.MAW_QUIET = "1";
    setVerbosityFlags({ quiet: false });
    expect(isQuiet()).toBe(false);
  });

  test("silent implies quiet even when quiet flag is explicitly false", () => {
    setVerbosityFlags({ quiet: false, silent: true });
    expect(isSilent()).toBe(true);
    expect(isQuiet()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // FIX-A — selected verbs suppress bootstrap chatter.
  // Their output is user-facing or machine-readable and doesn't need
  // plugin-loading narration.
  // ---------------------------------------------------------------------------

  describe("bootstrap suppression (FIX-A)", () => {
    test("`maw ls` → quiet (suppress 'loaded config:' / 'loaded N plugins')", () => {
      process.argv = ["bun", "/path/to/cli.ts", "ls"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw ls --fix` → still quiet (verb position is what matters)", () => {
      process.argv = ["bun", "/path/to/cli.ts", "ls", "--fix"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw a <name>` → quiet", () => {
      process.argv = ["bun", "/path/to/cli.ts", "a", "neo"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw attach <name>` → quiet", () => {
      process.argv = ["bun", "/path/to/cli.ts", "attach", "neo"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw wake <name>` → quiet (cmdWake is direct-handler, no plugin shell-out)", () => {
      process.argv = ["bun", "/path/to/cli.ts", "wake", "neo"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw activity --all --json` → quiet (JSON must stay parseable)", () => {
      process.argv = ["bun", "/path/to/cli.ts", "activity", "--all", "--json"];
      expect(isQuiet()).toBe(true);
    });

    test.each(["capture", "locate", "messages", "oracle", "peek"])(
      "`maw %s` diagnostic command -> quiet",
      (verb) => {
        process.argv = ["bun", "/path/to/cli.ts", verb];
        expect(isQuiet()).toBe(true);
      },
    );

    test("`maw locate mira --json` -> quiet for parseable JSON output", () => {
      process.argv = ["bun", "/path/to/cli.ts", "locate", "mira", "--json"];
      expect(isQuiet()).toBe(true);
    });

    test("`maw bud --as ls` → NOT quiet (positional check at argv[2], not .some)", () => {
      // Regression guard: an `--as ls` value buried later in argv must not
      // false-positive into the suppression path.
      process.argv = ["bun", "/path/to/cli.ts", "bud", "--as", "ls"];
      expect(isQuiet()).toBe(false);
    });

    test("`maw fleet status` → NOT quiet (non-alias verb)", () => {
      process.argv = ["bun", "/path/to/cli.ts", "fleet", "status"];
      expect(isQuiet()).toBe(false);
    });

    test("verb is case-insensitive (LS == ls)", () => {
      process.argv = ["bun", "/path/to/cli.ts", "LS"];
      expect(isQuiet()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Surface behavior — verify gating matches the predicates above.
  // ---------------------------------------------------------------------------

  describe("surfaces", () => {
    let stderrChunks: string[] = [];
    let originalWrite: typeof process.stderr.write;

    beforeEach(() => {
      stderrChunks = [];
      originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: any) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as any;
    });

    afterEach(() => {
      process.stderr.write = originalWrite;
    });

    test("verbose() runs fn when not quiet, skips when quiet", () => {
      let hit = 0;
      verbose(() => { hit++; });
      expect(hit).toBe(1);

      setVerbosityFlags({ quiet: true });
      verbose(() => { hit++; });
      expect(hit).toBe(1);
    });

    test("warn/info suppressed when quiet; error always prints", () => {
      setVerbosityFlags({ silent: true });
      warn("w");
      info("i");
      error("e");
      const joined = stderrChunks.join("");
      expect(joined).not.toContain("w");
      expect(joined).not.toContain("i");
      expect(joined).toContain("e");
    });
  });
});
