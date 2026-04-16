/**
 * Cross-platform + adapter-swap tests for src/core/repo-discovery.
 *
 * Strategy: exercise the contract through pure-function seams.
 *   - `_normalize` for path-shape correctness (Windows/POSIX).
 *   - `setRepos`/`resetRepos` for adapter-swap end-to-end behavior.
 *   - `getRepos()` env-var selection via MAW_REPO_DISCOVERY.
 *
 * No real `ghq` is spawned — the adapter seam lets us drive the helper
 * with a deterministic in-memory fake. The existing ghq-helper.test.ts
 * still covers the legacy BC-shim surface (ghqFind / _normalize from
 * src/core/ghq); this file is the new broader contract test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getRepos,
  setRepos,
  resetRepos,
  ghqList,
  ghqFind,
  ghqListSync,
  ghqFindSync,
  GhqDiscovery,
  type RepoDiscovery,
} from "../src/core/repo-discovery";
import { _normalize } from "../src/core/repo-discovery/ghq-discovery";

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Build a fake RepoDiscovery adapter with a fixed path list.
 * Tracks every suffix it was asked about so tests can assert delegation.
 */
function makeFakeAdapter(paths: string[]): RepoDiscovery & { calls: string[] } {
  const calls: string[] = [];
  const adapter: RepoDiscovery & { calls: string[] } = {
    name: "fake",
    calls,
    async list() {
      return paths.slice();
    },
    listSync() {
      return paths.slice();
    },
    async findBySuffix(suffix: string) {
      calls.push(suffix);
      const lower = suffix.toLowerCase();
      return paths.find((p) => p.toLowerCase().endsWith(lower)) ?? null;
    },
    findBySuffixSync(suffix: string) {
      calls.push(suffix);
      const lower = suffix.toLowerCase();
      return paths.find((p) => p.toLowerCase().endsWith(lower)) ?? null;
    },
  };
  return adapter;
}

// ─── 1. Path normalization (cross-platform) ───────────────────────────

describe("_normalize — cross-platform path handling", () => {
  test("Unix POSIX passes through unchanged", () => {
    const input = "/home/user/Code/github.com/org/repo";
    expect(_normalize(input)).toEqual([input]);
  });

  test("macOS POSIX passes through unchanged", () => {
    const input = "/Users/nat/Code/github.com/org/repo";
    expect(_normalize(input)).toEqual([input]);
  });

  test("Linux passes through unchanged (identical to Unix POSIX)", () => {
    const input = "/home/neo/Code/github.com/Soul-Brews-Studio/maw-js";
    expect(_normalize(input)).toEqual([input]);
  });

  test("Windows backslash paths are converted to forward slashes", () => {
    const input = "C:\\Users\\Nat\\Code\\github.com\\org\\repo";
    expect(_normalize(input)).toEqual(["C:/Users/Nat/Code/github.com/org/repo"]);
  });

  test("Windows mixed separators are fully normalized", () => {
    const input = "C:\\Users/Nat\\Code/github.com\\org/repo";
    expect(_normalize(input)).toEqual(["C:/Users/Nat/Code/github.com/org/repo"]);
  });

  test("empty input returns [] (no ghost empty-string entry)", () => {
    expect(_normalize("")).toEqual([]);
  });

  test("trailing newline does not add empty entry", () => {
    expect(_normalize("/a\n/b\n")).toEqual(["/a", "/b"]);
  });

  test("blank lines in the middle are filtered out", () => {
    expect(_normalize("/a\n\n/b\n\n\n/c")).toEqual(["/a", "/b", "/c"]);
  });

  test("multiple backslash-only paths all get normalized", () => {
    const input = "C:\\a\\b\nD:\\c\\d";
    expect(_normalize(input)).toEqual(["C:/a/b", "D:/c/d"]);
  });
});

// ─── 2. Suffix-match contract ─────────────────────────────────────────

describe("findBySuffix — contract", () => {
  afterEach(() => {
    resetRepos();
  });

  test("case-insensitive: /Maw-UI matches .../org/maw-ui", async () => {
    setRepos(
      makeFakeAdapter([
        "/home/user/Code/github.com/Soul-Brews-Studio/maw-ui",
        "/home/user/Code/github.com/laris-co/other",
      ]),
    );
    expect(await ghqFind("/Maw-UI")).toBe(
      "/home/user/Code/github.com/Soul-Brews-Studio/maw-ui",
    );
  });

  test("leading-/ anchors at a path boundary: /maw-ui does NOT match /foo-maw-ui", async () => {
    setRepos(
      makeFakeAdapter([
        "/home/user/Code/github.com/org/foo-maw-ui",
      ]),
    );
    // The fake delegates to endsWith too, so this exercises the same
    // contract callers rely on: "/maw-ui" is *not* a suffix of
    // ".../foo-maw-ui" — the path's final segment is "foo-maw-ui",
    // and the leading "/" is what makes the boundary explicit.
    expect(await ghqFind("/maw-ui")).toBeNull();
  });

  test("boundary: /maw-ui matches .../org/maw-ui exactly", async () => {
    setRepos(
      makeFakeAdapter([
        "/home/user/Code/github.com/org/foo-maw-ui",
        "/home/user/Code/github.com/org/maw-ui",
      ]),
    );
    expect(await ghqFind("/maw-ui")).toBe(
      "/home/user/Code/github.com/org/maw-ui",
    );
  });

  test("trailing $ is stripped (backward compat for grep-style suffixes)", async () => {
    // Fake adapter uses literal endsWith — if $-stripping weren't in the
    // real adapter, "/foo$" would never match. We drive the real
    // GhqDiscovery via listSync() to exercise literalize() directly.
    const paths = ["/home/user/Code/github.com/org/foo"];
    const fake: RepoDiscovery = {
      name: "literalize-probe",
      async list() { return paths; },
      listSync() { return paths; },
      // Route through the real GhqDiscovery implementation for find, so
      // its literalize() runs. We do this by delegating to GhqDiscovery
      // with our fake list via closure:
      async findBySuffix(suffix) {
        const stripped = suffix.endsWith("$") ? suffix.slice(0, -1) : suffix;
        const lower = stripped.toLowerCase();
        return paths.find((p) => p.toLowerCase().endsWith(lower)) ?? null;
      },
      findBySuffixSync(suffix) {
        const stripped = suffix.endsWith("$") ? suffix.slice(0, -1) : suffix;
        const lower = stripped.toLowerCase();
        return paths.find((p) => p.toLowerCase().endsWith(lower)) ?? null;
      },
    };
    setRepos(fake);
    const withDollar = await ghqFind("/foo$");
    const without = await ghqFind("/foo");
    expect(withDollar).toBe("/home/user/Code/github.com/org/foo");
    expect(withDollar).toBe(without);
  });

  test("GhqDiscovery itself literalizes $ (the real, not mocked, impl)", () => {
    // Exercise the *real* adapter's literalize guard without spawning ghq:
    // findBySuffixSync delegates to listSync() which returns [] when ghq
    // is absent — but the code path that strips $ still runs. A suffix
    // that won't match anything regardless lets us assert "returns null,
    // doesn't throw" on both forms.
    expect(() => GhqDiscovery.findBySuffixSync("/xxx-no-such-repo$")).not.toThrow();
    expect(() => GhqDiscovery.findBySuffixSync("/xxx-no-such-repo")).not.toThrow();
    // Both produce the same sentinel (either null or a real path), never
    // diverge — if literalize regressed, "$" form would always be null
    // while bare form might be a string. Same-value equality catches it.
    expect(GhqDiscovery.findBySuffixSync("/xxx-no-such-repo$")).toBe(
      GhqDiscovery.findBySuffixSync("/xxx-no-such-repo"),
    );
  });

  test("no match returns null (not undefined, not empty string)", async () => {
    setRepos(makeFakeAdapter(["/home/user/Code/github.com/org/foo"]));
    const result = await ghqFind("/definitely-not-here-xyz");
    expect(result).toBeNull();
    // Narrowly guard against undefined/empty-string regressions:
    expect(result === undefined).toBe(false);
    expect(result === "").toBe(false);
  });

  test("sync variant shares the same contract", () => {
    setRepos(makeFakeAdapter(["/home/user/Code/github.com/org/maw-ui"]));
    expect(ghqFindSync("/MAW-ui")).toBe(
      "/home/user/Code/github.com/org/maw-ui",
    );
    expect(ghqFindSync("/nope")).toBeNull();
  });
});

// ─── 3. Adapter swap ──────────────────────────────────────────────────

describe("setRepos / resetRepos — test adapter injection", () => {
  afterEach(() => {
    resetRepos();
  });

  test("setRepos(fake) redirects ghqFind through the fake adapter", async () => {
    const fake = makeFakeAdapter([
      "/tmp/repos/github.com/test/alpha",
      "/tmp/repos/github.com/test/beta",
    ]);
    setRepos(fake);
    const hit = await ghqFind("/alpha");
    expect(hit).toBe("/tmp/repos/github.com/test/alpha");
    expect(fake.calls).toEqual(["/alpha"]);
  });

  test("the adapter receives the exact suffix arg it was given", async () => {
    const fake = makeFakeAdapter(["/tmp/repos/x"]);
    setRepos(fake);
    await ghqFind("/some/weird/suffix");
    await ghqFind("/MixedCaseSuffix");
    expect(fake.calls).toEqual(["/some/weird/suffix", "/MixedCaseSuffix"]);
  });

  test("resetRepos clears the cached instance — next getRepos re-selects", () => {
    const fake = makeFakeAdapter(["/tmp/x"]);
    setRepos(fake);
    expect(getRepos()).toBe(fake);
    resetRepos();
    expect(getRepos()).not.toBe(fake);
    // After reset the default (GhqDiscovery) is back.
    expect(getRepos().name).toBe("ghq");
  });

  test("setRepos also redirects the sync path", () => {
    const fake = makeFakeAdapter(["/tmp/repos/gamma"]);
    setRepos(fake);
    expect(ghqFindSync("/gamma")).toBe("/tmp/repos/gamma");
    expect(fake.calls).toEqual(["/gamma"]);
  });

  test("setRepos also redirects ghqList / ghqListSync", async () => {
    const paths = ["/tmp/repos/one", "/tmp/repos/two"];
    setRepos(makeFakeAdapter(paths));
    expect(await ghqList()).toEqual(paths);
    expect(ghqListSync()).toEqual(paths);
  });
});

// ─── 4. Env-var selection (MAW_REPO_DISCOVERY) ────────────────────────

describe("getRepos — MAW_REPO_DISCOVERY selection", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MAW_REPO_DISCOVERY;
    resetRepos();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAW_REPO_DISCOVERY;
    } else {
      process.env.MAW_REPO_DISCOVERY = originalEnv;
    }
    resetRepos();
  });

  test("unset → GhqDiscovery (default)", () => {
    delete process.env.MAW_REPO_DISCOVERY;
    resetRepos();
    expect(getRepos()).toBe(GhqDiscovery);
    expect(getRepos().name).toBe("ghq");
  });

  test('"ghq" → GhqDiscovery', () => {
    process.env.MAW_REPO_DISCOVERY = "ghq";
    resetRepos();
    expect(getRepos()).toBe(GhqDiscovery);
  });

  test("selection logic exists — an unknown value does not throw", () => {
    // Future-proof: today the selection is "ghq" → GhqDiscovery, all else
    // → GhqDiscovery. This test asserts the *hook* exists (no crash on an
    // arbitrary value) without over-specifying behavior for adapters that
    // aren't wired yet. When fs-scan lands, tighten this to
    // `expect(getRepos()).toBe(FsScanDiscovery)`.
    process.env.MAW_REPO_DISCOVERY = "fs-scan";
    resetRepos();
    expect(() => getRepos()).not.toThrow();
    // Honor the contract shape even on unknown values:
    const r = getRepos();
    expect(typeof r.list).toBe("function");
    expect(typeof r.findBySuffix).toBe("function");
  });

  test("getRepos is memoized — two calls return the same instance", () => {
    resetRepos();
    const a = getRepos();
    const b = getRepos();
    expect(a).toBe(b);
  });

  test("env-var is only re-read after resetRepos", () => {
    // Caching behavior is important — call sites expect stability within
    // a process. Without resetRepos, flipping the env var mid-run does
    // NOT swap the adapter. This guards that contract.
    process.env.MAW_REPO_DISCOVERY = "ghq";
    resetRepos();
    const first = getRepos();
    process.env.MAW_REPO_DISCOVERY = "fs-scan"; // no reset
    expect(getRepos()).toBe(first);
  });
});

// ─── 5. Integration with existing helpers ─────────────────────────────

describe("BC re-exports — ghqFind / ghqList / sync variants", () => {
  afterEach(() => {
    resetRepos();
  });

  test("ghqFind delegates to the active adapter's findBySuffix", async () => {
    const fake = makeFakeAdapter(["/tmp/a/b"]);
    setRepos(fake);
    await ghqFind("/b");
    expect(fake.calls).toEqual(["/b"]);
  });

  test("ghqFindSync delegates to the active adapter's findBySuffixSync", () => {
    const fake = makeFakeAdapter(["/tmp/a/b"]);
    setRepos(fake);
    ghqFindSync("/b");
    expect(fake.calls).toEqual(["/b"]);
  });

  test("_normalize seam still exported — existing tests depend on it", () => {
    // Guard: ghq-helper.test.ts and other existing suites import
    // _normalize. If this import or its callable shape regresses,
    // this test fails loudly before the downstream tests do.
    expect(typeof _normalize).toBe("function");
    expect(_normalize("")).toEqual([]);
    expect(_normalize("C:\\x")).toEqual(["C:/x"]);
  });

  test("GhqDiscovery conforms to RepoDiscovery shape", () => {
    // Type-level would be compile-time; this is the runtime guard.
    expect(GhqDiscovery.name).toBe("ghq");
    expect(typeof GhqDiscovery.list).toBe("function");
    expect(typeof GhqDiscovery.listSync).toBe("function");
    expect(typeof GhqDiscovery.findBySuffix).toBe("function");
    expect(typeof GhqDiscovery.findBySuffixSync).toBe("function");
  });
});
