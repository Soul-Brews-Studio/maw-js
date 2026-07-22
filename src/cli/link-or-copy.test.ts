import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readlinkSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { linkOrCopy } from "./link-or-copy";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "link-or-copy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("linkOrCopy", () => {
  test("creates symlink when filesystem supports it", () => {
    const src = join(root, "src"); writeFileSync(src, "hello");
    const dest = join(root, "dest");
    const result = linkOrCopy(src, dest);
    // On Linux/Mac with symlink support: "symlink"; on Windows non-admin: "copy"
    expect(["symlink", "copy"]).toContain(result);
    expect(existsSync(dest)).toBe(true);
    // Verify it's either a symlink (lstat is link) or a real file (lstat is file)
    const lst = lstatSync(dest);
    expect(lst.isSymbolicLink() || lst.isFile()).toBe(true);
  });

  test("idempotent: existing dest is left alone", () => {
    const src = join(root, "src"); writeFileSync(src, "hello");
    const dest = join(root, "dest"); writeFileSync(dest, "preexisting");
    const result = linkOrCopy(src, dest);
    expect(result).toBe("exists");
    expect(readlinkIfLink(dest) ?? "preexisting").toBe("preexisting");
  });

  test("works in worktree-style layout (mimics plugin bootstrap)", () => {
    const bundled = join(root, "bundled");
    const pluginDir = join(root, "plugins");
    const src = join(bundled, "alpha");
    mkdirSync(bundled, { recursive: true });
    writeFileSync(src, "alpha plugin content");
    const dest = join(pluginDir, "alpha");
    const result = linkOrCopy(src, dest);
    expect(["symlink", "copy"]).toContain(result);
    expect(existsSync(dest)).toBe(true);
  });
});

function readlinkIfLink(p: string): string | null {
  try { return readlinkSync(p); } catch { return null; }
}
