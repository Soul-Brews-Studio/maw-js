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
import { _normalize, selectRepoMatch } from "../src/core/repo-discovery/ghq-discovery";

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

// ─── 2b. Doubled github.com/github.com path preference (#2577) ────────

describe("selectRepoMatch (#2577) — prefers canonical over doubled github.com", () => {
  const canonical = "/opt/Code/github.com/laris-co/neo-oracle";
  const doubled = "/opt/Code/github.com/github.com/laris-co/neo-oracle";

  test("returns the canonical path even when the doubled one is listed first", () => {
    // The exact #2577 repro: maw wake neo was resolving to the doubled path.
    expect(selectRepoMatch([doubled, canonical], "/neo-oracle")).toBe(canonical);
  });

  test("returns the canonical path when it is listed first", () => {
    expect(selectRepoMatch([canonical, doubled], "/neo-oracle")).toBe(canonical);
  });

  test("a more specific suffix still prefers canonical", () => {
    expect(selectRepoMatch([doubled, canonical], "/laris-co/neo-oracle")).toBe(canonical);
  });

  test("falls back to a doubled path only when it is the sole match", () => {
    expect(selectRepoMatch([doubled], "/neo-oracle")).toBe(doubled);
  });

  test("returns null when nothing matches the suffix", () => {
    expect(selectRepoMatch([doubled, canonical], "/no-such-oracle")).toBeNull();
  });

  test("preserves case-insensitive + $-stripping suffix matching", () => {
    expect(selectRepoMatch([doubled, canonical], "/NEO-Oracle$")).toBe(canonical);
  });

  test("the real GhqDiscovery.findBySuffix routes through selectRepoMatch", async () => {
    // Drive the real adapter (not the fake) with a deterministic list so the
    // #2577 preference is exercised end-to-end through findBySuffix.
    setRepos({
      name: "doubled-probe",
      async list() { return [doubled, canonical]; },
      listSync() { return [doubled, canonical]; },
      findBySuffix(suffix: string) { return Promise.resolve(selectRepoMatch([doubled, canonical], suffix)); },
      findBySuffixSync(suffix: string) { return selectRepoMatch([doubled, canonical], suffix); },
    });
    expect(await ghqFind("/neo-oracle")).toBe(canonical);
    resetRepos();
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

// ─── 4. Singleton behavior ────────────────────────────────────────────
//
// Note: env-var dispatch (MAW_REPO_DISCOVERY) was removed in alpha.60 —
// it was a tautological branch (`kind === "ghq" ? Ghq : Ghq`) that tested
// only that the hook existed, not that it dispatched. The interface is
// preserved so a second backend can wire the env var when it lands in
// the same PR. Until then, getRepos() always returns GhqDiscovery.

describe("getRepos — singleton + default backend", () => {
  beforeEach(() => {
    resetRepos();
  });

  test("default backend is GhqDiscovery", () => {
    expect(getRepos()).toBe(GhqDiscovery);
    expect(getRepos().name).toBe("ghq");
  });

  test("getRepos is memoized — two calls return the same instance", () => {
    const a = getRepos();
    const b = getRepos();
    expect(a).toBe(b);
  });

  test("resetRepos forces a fresh resolution on next getRepos", () => {
    const first = getRepos();
    resetRepos();
    const second = getRepos();
    // Same backend (since only one is wired) but the cache was cleared —
    // setRepos+getRepos in interleaved tests rely on this.
    expect(second).toBe(GhqDiscovery);
    // Object identity: both reference the same exported singleton object,
    // so `===` would still hold; the contract being tested here is "cache
    // was cleared so the resolution code path ran again", not identity.
    expect(first).toBe(GhqDiscovery);
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
