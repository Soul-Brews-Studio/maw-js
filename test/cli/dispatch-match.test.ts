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
import { ALIAS_DESCRIPTIONS, parseBringArgs, parseLsAliasOpts, resolveTopAlias } from "../../src/cli/top-aliases";
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

  test("#1500: disabled plugins are skipped by default but detectable for UX hints", () => {
    const team = plugin("team", "team");
    team.disabled = true;

    const skipped = resolvePluginMatch([team], "team status");
    expect(skipped.kind).toBe("none");

    const detected = resolvePluginMatch([team], "team status", { includeDisabled: true });
    expect(detected.kind).toBe("match");
    if (detected.kind === "match") {
      expect(detected.plugin.manifest.name).toBe("team");
      expect(detected.matchedName).toBe("team");
    }
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

  test("entry-backed API or capability plugins without cli are skipped as headless", () => {
    const apiOnly: LoadedPlugin = {
      manifest: {
        name: "cross-team-queue",
        version: "1.0.0",
        sdk: "^1.0.0",
        api: { path: "/cross-team-queue", methods: ["GET"] },
      } as LoadedPlugin["manifest"],
      dir: "/tmp/cross-team-queue",
      wasmPath: "",
      entryPath: "/tmp/cross-team-queue/src/index.ts",
      kind: "ts",
    };
    const strategy: LoadedPlugin = {
      manifest: {
        name: "attach-ssh",
        version: "1.0.0",
        sdk: "^1.0.0",
        capabilities: ["attach:strategy"],
      } as LoadedPlugin["manifest"],
      dir: "/tmp/attach-ssh",
      wasmPath: "",
      entryPath: "/tmp/attach-ssh/index.ts",
      kind: "ts",
    };

    expect(resolvePluginMatch([apiOnly], "cross-team-queue").kind).toBe("none");
    expect(resolvePluginMatch([strategy], "attach-ssh").kind).toBe("none");
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

  test("canonical exact command beats another plugin's exact alias", () => {
    // #1339 vendored mpr plugins include both:
    // - attach: canonical command "attach"
    // - view: alias "attach"
    // The canonical command must win so bundling both does not make
    // `maw attach ...` ambiguous.
    const view = plugin("view", "view", ["attach", "a"]);
    const attach = plugin("attach", "attach");
    const out = resolvePluginMatch([view, attach], "attach");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("attach");
      expect(out.matchedName).toBe("attach");
    }
  });

  test("canonical prefix command beats another plugin's prefix alias", () => {
    const view = plugin("view", "view", ["attach", "a"]);
    const attach = plugin("attach", "attach");
    const out = resolvePluginMatch([view, attach], "attach homekeeper");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("attach");
      expect(out.matchedName).toBe("attach");
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

describe("resolveTopAlias — RFC #954 verb aliases", () => {
  test("`ls` → direct-handler cmdLs (detail default)", () => {
    const out = resolveTopAlias(["ls"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toBe("cmdLs");
      expect(out!.argv).toEqual([]);
    }
  });

  test("`ls -a` → direct-handler cmdLs with -a (compact roster)", () => {
    const out = resolveTopAlias(["ls", "-a"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toBe("cmdLs");
      expect(out!.argv).toEqual(["-a"]);
    }
  });

  test("`ls -v` → direct-handler cmdLs with -v (no-op detail alias)", () => {
    const out = resolveTopAlias(["ls", "-v"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toBe("cmdLs");
      expect(out!.argv).toEqual(["-v"]);
    }
  });

  test("#1556 parse ls opts: default and -v both render per-pane detail", () => {
    expect(parseLsAliasOpts([])).toEqual({
      all: true,
      compact: false,
      verbose: true,
      roster: false,
      json: false,
    });
    expect(parseLsAliasOpts(["-v"])).toEqual({
      all: true,
      compact: false,
      verbose: true,
      roster: false,
      json: false,
    });
  });

  test("#1556 parse ls opts: -c/--compact opt into condensed summary", () => {
    expect(parseLsAliasOpts(["-c"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
    });
    expect(parseLsAliasOpts(["--compact"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: false,
      json: false,
    });
  });

  test("#1556 parse ls opts: -a keeps legacy compact roster behavior", () => {
    expect(parseLsAliasOpts(["-a"])).toEqual({
      all: true,
      compact: true,
      verbose: false,
      roster: true,
      json: false,
    });
  });

  test("`a neo` → argv rewrite to ['tmux', 'attach', 'neo']", () => {
    const out = resolveTopAlias(["a", "neo"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("argv");
    if (out!.kind === "argv") expect(out!.argv).toEqual(["tmux", "attach", "neo"]);
  });

  test("`peek` is not a tmux top-alias; top-level peek is handled by routeComm", () => {
    const out = resolveTopAlias(["peek", "m5:mawjs"]);
    expect(out).toBeNull();
  });

  test("`attach` is not a registered alias (removed — use `a`)", () => {
    const out = resolveTopAlias(["attach", "neo"]);
    expect(out).toBeNull();
  });

  test("`wake neo --task X` → direct-handler form with cmdWake handler", () => {
    const out = resolveTopAlias(["wake", "neo", "--task", "X"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toContain("wake-cmd");
      expect(out!.handler).toContain("cmdWake");
      // argv passed to handler is everything AFTER the verb
      expect(out!.argv).toEqual(["neo", "--task", "X"]);
    }
  });

  test("`awake neo -e codex` → direct launch handler, not awaken prefix", () => {
    const out = resolveTopAlias(["awake", "neo", "-e", "codex"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toContain("wake-cmd");
      expect(out!.handler).toContain("cmdAwake");
      expect(out!.argv).toEqual(["neo", "-e", "codex"]);
    }
    expect(ALIAS_DESCRIPTIONS.awake).toContain("Launch");
    expect(ALIAS_DESCRIPTIONS.awake).toContain("does not trigger /awaken");
  });

  test("`new neo --no-attach` → direct-handler cmdNew friendly creation door", () => {
    const out = resolveTopAlias(["new", "neo", "--no-attach"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toContain("cmdNew");
      expect(out!.argv).toEqual(["neo", "--no-attach"]);
    }
    expect(ALIAS_DESCRIPTIONS.new).toContain("Create a new oracle");
  });

  test("`bring neo` defaults to v1 split-and-attach mode", () => {
    const parsed = parseBringArgs(["neo"]);
    expect(parsed).toEqual({ oracle: "neo", opts: { split: true } });
  });

  test("`b neo` is a direct shorthand for bring", () => {
    const out = resolveTopAlias(["b", "neo"]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("direct");
    if (out!.kind === "direct") {
      expect(out!.handler).toContain("wake-cmd");
      expect(out!.handler).toContain("cmdBring");
      expect(out!.argv).toEqual(["neo"]);
    }
    expect(ALIAS_DESCRIPTIONS.b).toContain("short form of `bring`");
  });

  test("`bring neo --split` remains an explicit alias of split mode", () => {
    const parsed = parseBringArgs(["neo", "--split", "-e", "codex"]);
    expect(parsed).toEqual({ oracle: "neo", opts: { split: true, engine: "codex" } });
  });

  test("`bring neo --tab` opts into non-destructive background-tab mode", () => {
    const parsed = parseBringArgs(["neo", "--tab"]);
    expect(parsed).toEqual({ oracle: "neo", opts: { bring: true, tab: true } });
  });

  test("`audit` → null (does NOT shadow CORE_ROUTES)", () => {
    // audit is a core route handled by routeTools BEFORE alias resolution;
    // top-aliases must not register it. Returning null keeps the existing
    // route untouched even if alias logic is reached out-of-order.
    const out = resolveTopAlias(["audit"]);
    expect(out).toBeNull();
  });
});
