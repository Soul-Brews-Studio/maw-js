/**
 * Tests for src/commands/plugins/ui/ui-install.ts — buildGhReleaseArgs.
 * Pure CLI argument builder.
 */
import { describe, it, expect } from "bun:test";
import { buildGhReleaseArgs } from "../../src/commands/plugins/ui/ui-install";

describe("buildGhReleaseArgs", () => {
  it("builds args without ref (latest)", () => {
    const args = buildGhReleaseArgs("org/repo", undefined, "/tmp/dl");
    expect(args).toEqual(["release", "download", "-R", "org/repo", "--pattern", "maw-ui-dist.tar.gz", "--dir", "/tmp/dl"]);
  });

  it("includes ref tag when specified", () => {
    const args = buildGhReleaseArgs("org/repo", "v1.2.3", "/tmp/dl");
    expect(args).toContain("v1.2.3");
    expect(args.indexOf("v1.2.3")).toBe(2); // right after "download"
  });

  it("uses correct repo", () => {
    const args = buildGhReleaseArgs("Soul-Brews/maw-ui", undefined, "/d");
    expect(args).toContain("Soul-Brews/maw-ui");
  });

  it("uses correct dir", () => {
    const args = buildGhReleaseArgs("r", "v1", "/custom/dir");
    expect(args[args.length - 1]).toBe("/custom/dir");
  });

  it("always includes --pattern maw-ui-dist.tar.gz", () => {
    const args = buildGhReleaseArgs("r", undefined, "/d");
    const idx = args.indexOf("--pattern");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("maw-ui-dist.tar.gz");
  });

  it("does not include 'latest' string when ref is undefined", () => {
    const args = buildGhReleaseArgs("r", undefined, "/d");
    expect(args).not.toContain("latest");
  });
});
