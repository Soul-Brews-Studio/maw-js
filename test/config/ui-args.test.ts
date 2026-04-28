/**
 * Tests for src/commands/plugins/ui/impl-render.ts — parseUiArgs.
 * Pure argument parsing.
 */
import { describe, it, expect } from "bun:test";
import { parseUiArgs } from "../../src/commands/plugins/ui/impl-render";

describe("parseUiArgs", () => {
  it("parses empty args", () => {
    const opts = parseUiArgs([]);
    expect(opts.peer).toBeUndefined();
    expect(opts.dev).toBeUndefined();
    expect(opts.tunnel).toBeUndefined();
  });

  it("parses --dev flag", () => {
    const opts = parseUiArgs(["--dev"]);
    expect(opts.dev).toBe(true);
  });

  it("parses --tunnel flag", () => {
    const opts = parseUiArgs(["--tunnel"]);
    expect(opts.tunnel).toBe(true);
  });

  it("parses --3d flag", () => {
    const opts = parseUiArgs(["--3d"]);
    expect(opts.threeD).toBe(true);
  });

  it("parses --install flag", () => {
    const opts = parseUiArgs(["--install"]);
    expect(opts.install).toBe(true);
  });

  it("parses peer as positional arg", () => {
    const opts = parseUiArgs(["myhost"]);
    expect(opts.peer).toBe("myhost");
  });

  it("parses --tunnel with peer", () => {
    const opts = parseUiArgs(["--tunnel", "oracle-world"]);
    expect(opts.tunnel).toBe(true);
    expect(opts.peer).toBe("oracle-world");
  });

  it("detects install subcommand", () => {
    const opts = parseUiArgs(["install"]);
    expect(opts.subcommand).toBe("install");
  });

  it("detects status subcommand", () => {
    const opts = parseUiArgs(["status"]);
    expect(opts.subcommand).toBe("status");
  });

  it("does not treat non-subcommand as subcommand", () => {
    const opts = parseUiArgs(["myhost"]);
    expect(opts.subcommand).toBeUndefined();
  });

  it("parses --version flag", () => {
    const opts = parseUiArgs(["--version", "1.2.3"]);
    expect(opts.version).toBe("1.2.3");
  });

  it("parses combined flags", () => {
    const opts = parseUiArgs(["--dev", "--3d"]);
    expect(opts.dev).toBe(true);
    expect(opts.threeD).toBe(true);
  });
});
