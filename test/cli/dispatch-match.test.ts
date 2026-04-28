/**
 * Regression tests for two-pass plugin dispatch (#351 + #350).
 *
 * Verifies:
 *  - exact match wins over prefix collision (#351 `art`)
 *  - exact match wins when name-collides with a prefix candidate earlier in
 *    iteration order (#350 `hello`)
 *  - unique exact still resolves
 *  - prefix match with word boundary (e.g. `restart` != `rest`)
 */
import { describe, test, expect } from "bun:test";
import { resolvePluginMatch } from "../../src/cli/dispatch-match";
import type { LoadedPlugin } from "../../src/plugin/types";

function plugin(name: string, command: string, aliases: string[] = []): LoadedPlugin {
  return {
    manifest: {
      name,
      version: "1.0.0",
      sdk: "^1.0.0",
      cli: { command, aliases, help: "" },
    } as LoadedPlugin["manifest"],
    dir: `/tmp/${name}`,
    wasmPath: "",
    kind: "ts",
  };
}

describe("resolvePluginMatch — two-pass dispatch", () => {
  test("#351: exact `art` wins over prefix-colliding view plugin earlier in order", () => {
    // Simulate hypothetical view plugin with an `a` alias iterated first —
    // the bug would prefix-match view's "a" alias on some cmd like `art` if
    // shaped differently. Here we directly test the precedence contract: an
    // exact match on a later plugin must beat a prefix match on an earlier one.
    const view = plugin("view", "view", ["a", "attach"]);
    const artman = plugin("artifact-manager", "art");
    const out = resolvePluginMatch([view, artman], "art ls");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("artifact-manager");
      expect(out.matchedName).toBe("art");
    }
  });

  test("#350: exact `hello` wins even when earlier plugin's alias is a prefix candidate", () => {
    // An earlier plugin declares "h" alias — its prefix-match on "hello" has
    // no word boundary (should not prefix-match anyway), and even if some
    // other prefix collision were lurking, exact-match pass must short-circuit.
    const other = plugin("helper-tool", "help-me", ["h"]);
    const hello = plugin("hello", "hello");
    const out = resolvePluginMatch([other, hello], "hello");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("hello");
      expect(out.matchedName).toBe("hello");
    }
  });

  test("unique `view` command still resolves", () => {
    const view = plugin("view", "view", ["a", "attach"]);
    const art = plugin("artifact-manager", "art");
    const out = resolvePluginMatch([art, view], "view agent-7");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("view");
      expect(out.matchedName).toBe("view");
    }
  });

  test("`restart` does not collide with `rest` (word boundary on prefix)", () => {
    const rest = plugin("rest-plugin", "rest");
    const restart = plugin("restart-plugin", "restart");
    const out = resolvePluginMatch([rest, restart], "restart --now");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("restart-plugin");
      expect(out.matchedName).toBe("restart");
    }
  });

  test("unknown command returns none", () => {
    const art = plugin("artifact-manager", "art");
    const out = resolvePluginMatch([art], "nosuch --flag");
    expect(out.kind).toBe("none");
  });

  test("non-dispatchable plugins (no cli, no entry, no wasm) are skipped", () => {
    // #899 — pure-hooks/api/cron plugins still get filtered out: no `cli`
    // field AND no entry/wasm to default to. The default-name fallback
    // requires a dispatchable surface so unknown commands still error.
    const noCli: LoadedPlugin = {
      manifest: { name: "headless", version: "1.0.0", sdk: "^1.0.0" } as LoadedPlugin["manifest"],
      dir: "/tmp/headless",
      wasmPath: "",
      kind: "ts",
    };
    const art = plugin("artifact-manager", "art");
    const out = resolvePluginMatch([noCli, art], "art");
    expect(out.kind).toBe("match");
    if (out.kind === "match") expect(out.plugin.manifest.name).toBe("artifact-manager");

    // The headless plugin's name MUST NOT match — it has no executable surface.
    const miss = resolvePluginMatch([noCli, art], "headless");
    expect(miss.kind).toBe("none");
  });

  test("two plugins sharing same exact command → ambiguous", () => {
    const a = plugin("first", "share");
    const b = plugin("second", "share");
    const out = resolvePluginMatch([a, b], "share --x");
    // Exact is tried with " " suffix only for prefix; exact path requires
    // cmdName === name. "share --x" is not exact for "share", so this falls
    // to prefix pass. Both match prefix → ambiguous.
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.candidates.map(c => c.plugin).sort()).toEqual(["first", "second"]);
    }
  });

  test("two plugins sharing same exact command (no args) → ambiguous on exact pass", () => {
    const a = plugin("first", "dup");
    const b = plugin("second", "dup");
    const out = resolvePluginMatch([a, b], "dup");
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.candidates.map(c => c.plugin).sort()).toEqual(["first", "second"]);
    }
  });

  test("exact in pass-1 beats a DIFFERENT plugin's prefix candidate in pass-2", () => {
    // cmdName = "foo bar" — fooer plugin has prefix "foo" (startsWith "foo "),
    // but foo-bar plugin has exact "foo bar". Exact pass must win.
    const fooer = plugin("fooer", "foo");
    const fooBar = plugin("foo-bar", "foo bar");
    const out = resolvePluginMatch([fooer, fooBar], "foo bar");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("foo-bar");
      expect(out.matchedName).toBe("foo bar");
    }
  });

  test("matchedName reflects alias used (not canonical command)", () => {
    const view = plugin("view", "view", ["attach"]);
    const out = resolvePluginMatch([view], "attach agent-1");
    expect(out.kind).toBe("match");
    if (out.kind === "match") expect(out.matchedName).toBe("attach");
  });

  test("case-insensitive name matching (cmdName pre-lowercased by caller)", () => {
    const view = plugin("view", "View", ["Attach"]);
    const out = resolvePluginMatch([view], "attach");
    expect(out.kind).toBe("match");
    if (out.kind === "match") expect(out.matchedName).toBe("attach");
  });
});
