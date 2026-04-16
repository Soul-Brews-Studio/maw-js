/**
 * Tests for `maw ui install` / `maw ui status`.
 *
 * Strategy: `buildGhReleaseArgs` is a pure function, so the gh command
 * construction is testable without mocking spawnSync or touching the
 * filesystem. `parseUiArgs` covers subcommand detection + flag routing.
 */

import { describe, test, expect } from "bun:test";
import { buildGhReleaseArgs } from "../src/commands/plugins/ui/ui-install";
import { parseUiArgs } from "../src/commands/plugins/ui/impl";

// ---- buildGhReleaseArgs — gh release download command construction --------

describe("buildGhReleaseArgs", () => {
  test("uses 'latest' when no version given", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", "/tmp/maw-ui-xxx");
    expect(args[0]).toBe("release");
    expect(args[1]).toBe("download");
    expect(args[2]).toBe("latest");
  });

  test("uses provided version tag", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "v1.15.0", "/tmp/maw-ui-xxx");
    expect(args[2]).toBe("v1.15.0");
  });

  test("includes -R <repo>", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", "/tmp/x");
    const rIdx = args.indexOf("-R");
    expect(rIdx).not.toBe(-1);
    expect(args[rIdx + 1]).toBe("Soul-Brews-Studio/maw-ui");
  });

  test("includes --pattern dist.tar.gz", () => {
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", "/tmp/x");
    const pIdx = args.indexOf("--pattern");
    expect(pIdx).not.toBe(-1);
    expect(args[pIdx + 1]).toBe("dist.tar.gz");
  });

  test("includes --dir pointing at provided tmpDir", () => {
    const tmpDir = "/tmp/maw-ui-abc123";
    const args = buildGhReleaseArgs("Soul-Brews-Studio/maw-ui", "latest", tmpDir);
    const dIdx = args.indexOf("--dir");
    expect(dIdx).not.toBe(-1);
    expect(args[dIdx + 1]).toBe(tmpDir);
  });

  test("works with an arbitrary repo slug", () => {
    const args = buildGhReleaseArgs("my-org/my-ui", "v2.0.0", "/tmp/x");
    expect(args[args.indexOf("-R") + 1]).toBe("my-org/my-ui");
    expect(args[2]).toBe("v2.0.0");
  });
});

// ---- parseUiArgs — install/status subcommand detection -------------------

describe("parseUiArgs — subcommands", () => {
  test("detects install subcommand", () => {
    const opts = parseUiArgs(["install"]);
    expect(opts.subcommand).toBe("install");
    expect(opts.version).toBeUndefined();
  });

  test("detects status subcommand", () => {
    const opts = parseUiArgs(["status"]);
    expect(opts.subcommand).toBe("status");
  });

  test("parses --version with install subcommand", () => {
    const opts = parseUiArgs(["install", "--version", "v1.15.0"]);
    expect(opts.subcommand).toBe("install");
    expect(opts.version).toBe("v1.15.0");
  });

  test("non-subcommand first arg treated as peer", () => {
    const opts = parseUiArgs(["white"]);
    expect(opts.subcommand).toBeUndefined();
    expect(opts.peer).toBe("white");
  });

  test("--install flag still works (backward compat)", () => {
    const opts = parseUiArgs(["--install"]);
    expect(opts.install).toBe(true);
    expect(opts.subcommand).toBeUndefined();
  });

  test("bare maw ui has no subcommand", () => {
    const opts = parseUiArgs([]);
    expect(opts.subcommand).toBeUndefined();
    expect(opts.install).toBeUndefined();
    expect(opts.peer).toBeUndefined();
  });

  test("status does not bleed into install path", () => {
    const opts = parseUiArgs(["status"]);
    expect(opts.subcommand).toBe("status");
    expect(opts.install).toBeUndefined();
  });
});
