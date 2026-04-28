/**
 * findPluginRoot — wrapper-dir resolution unit tests (#864).
 *
 * Covers the three real-world tarball layouts:
 *   • flat    — `maw plugin build` output, plugin.json at root
 *   • github  — github-archive `<repo>-<ref>/` wrapping dir
 *   • npm     — npm `package/` wrapping dir
 *
 * Plus negative cases that must return null (multi-entry, no manifest, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findPluginRoot } from "./install-manifest-helpers";

let suiteRoot: string;
let staging: string;

beforeEach(() => {
  suiteRoot = mkdtempSync(join(tmpdir(), "find-plugin-root-"));
  staging = join(suiteRoot, "staging");
  mkdirSync(staging, { recursive: true });
});

afterEach(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe("findPluginRoot — positive cases", () => {
  it("flat tarball: plugin.json at root → returns staging", () => {
    writeFileSync(join(staging, "plugin.json"), "{}");
    writeFileSync(join(staging, "index.js"), "");
    expect(findPluginRoot(staging)).toBe(staging);
  });

  it("github-archive wrapper: plugin.json one level down → returns subdir", () => {
    const inner = join(staging, "maw-shellenv-v0.1.0");
    mkdirSync(inner);
    writeFileSync(join(inner, "plugin.json"), "{}");
    writeFileSync(join(inner, "index.js"), "");
    expect(findPluginRoot(staging)).toBe(inner);
  });

  it("npm-style 'package/' wrapper → returns subdir", () => {
    const inner = join(staging, "package");
    mkdirSync(inner);
    writeFileSync(join(inner, "plugin.json"), "{}");
    expect(findPluginRoot(staging)).toBe(inner);
  });

  it("flat with sibling files takes precedence over walking → returns staging", () => {
    writeFileSync(join(staging, "plugin.json"), "{}");
    mkdirSync(join(staging, "tests"));
    expect(findPluginRoot(staging)).toBe(staging);
  });
});

describe("findPluginRoot — negative cases", () => {
  it("empty staging → null", () => {
    expect(findPluginRoot(staging)).toBeNull();
  });

  it("multiple top-level entries with no plugin.json at root → null (ambiguous)", () => {
    mkdirSync(join(staging, "alpha"));
    mkdirSync(join(staging, "beta"));
    writeFileSync(join(staging, "alpha", "plugin.json"), "{}");
    expect(findPluginRoot(staging)).toBeNull();
  });

  it("single subdir without plugin.json → null", () => {
    mkdirSync(join(staging, "lonely"));
    writeFileSync(join(staging, "lonely", "README.md"), "");
    expect(findPluginRoot(staging)).toBeNull();
  });

  it("single top-level file (not a directory) → null", () => {
    writeFileSync(join(staging, "stray.txt"), "");
    expect(findPluginRoot(staging)).toBeNull();
  });

  it("nonexistent staging dir → null", () => {
    expect(findPluginRoot(join(suiteRoot, "does-not-exist"))).toBeNull();
  });
});
