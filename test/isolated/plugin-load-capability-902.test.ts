/**
 * #902 — runtime / load-time capability validator must use the canonical
 *        KNOWN_CAPABILITY_NAMESPACES from src/plugin/manifest-constants.ts.
 *
 * Background:
 *   • #874 / #880 added `tmux` and `shell` to KNOWN_CAPABILITY_NAMESPACES so
 *     community plugins (bg, rename, park, shellenv) install cleanly.
 *   • alpha.41 still emitted `unknown capability namespace "tmux"` warnings
 *     on every CLI invocation — i.e. the *load-time* path warned with a
 *     stale 6-namespace list (`net, fs, peer, sdk, proc, ffi`).
 *   • Root cause: a second validator path can drift from the install-time
 *     validator if it ever hardcodes its own list.
 *
 * Single source of truth (asserted below): the validator wired into
 *   loadManifestFromDir → parseManifest → parseCapabilities
 * uses KNOWN_CAPABILITY_NAMESPACES verbatim. Any future drift surfaces
 * here as a failing test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  KNOWN_CAPABILITY_NAMESPACES,
  loadManifestFromDir,
} from "../../src/plugin/manifest";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
function tmpDir(prefix = "maw-load-cap-902-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

let warnings: string[];
let origWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  origWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
});

afterEach(() => {
  console.warn = origWarn;
  for (const d of created.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

/** Write a minimal plugin.json + entry.ts pair into a fresh tmpdir. */
function makePluginDir(opts: {
  name: string;
  capabilities?: string[];
  extra?: Record<string, unknown>;
}): string {
  const dir = tmpDir();
  writeFileSync(join(dir, "index.ts"), "export default () => {};");
  const manifest: Record<string, unknown> = {
    name: opts.name,
    version: "0.1.0",
    sdk: "^1.0.0",
    entry: "./index.ts",
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.extra ?? {}),
  };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("#902 — load-time capability validator (single source of truth)", () => {
  test("KNOWN_CAPABILITY_NAMESPACES is the canonical set (#874 baseline)", () => {
    expect([...KNOWN_CAPABILITY_NAMESPACES].sort()).toEqual(
      ["ffi", "fs", "net", "peer", "proc", "sdk", "shell", "tmux"],
    );
  });

  test("load-time: plugin with `tmux` capability does NOT warn", () => {
    const dir = makePluginDir({ name: "bg", capabilities: ["tmux"] });
    const loaded = loadManifestFromDir(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.capabilities).toEqual(["tmux"]);
    const tmuxWarns = warnings.filter((w) =>
      w.includes('unknown capability namespace "tmux"'),
    );
    expect(tmuxWarns).toEqual([]);
  });

  test("load-time: plugin with `shell` capability does NOT warn", () => {
    const dir = makePluginDir({ name: "shellenv", capabilities: ["shell"] });
    const loaded = loadManifestFromDir(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.capabilities).toEqual(["shell"]);
    const shellWarns = warnings.filter((w) =>
      w.includes('unknown capability namespace "shell"'),
    );
    expect(shellWarns).toEqual([]);
  });

  test("load-time: plugin with bogus namespace `foo` DOES warn", () => {
    const dir = makePluginDir({ name: "bogus-cap", capabilities: ["foo:bar"] });
    const loaded = loadManifestFromDir(dir);
    expect(loaded).not.toBeNull();
    const fooWarns = warnings.filter((w) =>
      w.includes('unknown capability namespace "foo"'),
    );
    expect(fooWarns.length).toBe(1);
  });

  test("load-time warning text lists ALL canonical namespaces (no stale 6-name list)", () => {
    // The bug in alpha.41 was the warning saying `(known: net, fs, peer, sdk,
    // proc, ffi)` — missing tmux/shell. Lock the warning text to the canonical
    // set so any future drift surfaces here.
    const dir = makePluginDir({ name: "bogus-list-check", capabilities: ["foo"] });
    loadManifestFromDir(dir);
    const fooWarn = warnings.find((w) =>
      w.includes('unknown capability namespace "foo"'),
    );
    expect(fooWarn).toBeDefined();
    for (const ns of KNOWN_CAPABILITY_NAMESPACES) {
      expect(fooWarn!).toContain(ns);
    }
    // Specifically tmux + shell — the two #874 added — must appear.
    expect(fooWarn!).toContain("tmux");
    expect(fooWarn!).toContain("shell");
  });

  test("load-time: every canonical namespace passes silently (no warning per known ns)", () => {
    // Belt-and-suspenders: iterate the full canonical set and confirm none of
    // them trigger a warning at load. This is the integration check that
    // proves the load-time validator and manifest-constants agree completely.
    for (const ns of KNOWN_CAPABILITY_NAMESPACES) {
      warnings.length = 0;
      const dir = makePluginDir({
        name: `cap-${ns}`,
        capabilities: [`${ns}:test`],
      });
      const loaded = loadManifestFromDir(dir);
      expect(loaded).not.toBeNull();
      const nsWarns = warnings.filter((w) =>
        w.includes(`unknown capability namespace "${ns}"`),
      );
      expect(nsWarns).toEqual([]);
    }
  });

  test("load-time: multi-capability plugin (tmux+shell+sdk) loads cleanly", () => {
    // Mirrors the #880 install-time test (plugin declaring multiple new
    // namespaces together) for the load path.
    const dir = makePluginDir({
      name: "multi-cap",
      capabilities: ["tmux", "shell", "sdk:identity"],
    });
    const loaded = loadManifestFromDir(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.capabilities).toEqual([
      "tmux",
      "shell",
      "sdk:identity",
    ]);
    const unknownWarns = warnings.filter((w) =>
      w.includes("unknown capability namespace"),
    );
    expect(unknownWarns).toEqual([]);
  });
});
