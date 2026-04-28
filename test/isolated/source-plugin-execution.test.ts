/**
 * #899 — source-plugin execution dispatch.
 *
 * After the install cascade (#857 + #861 + #866 + #870 + #880 + #897), source
 * plugins land cleanly in `~/.maw/plugins/<name>/`. But running `maw <name>`
 * still returned `unknown command: <name>` because the dispatcher's gate
 * (resolvePluginMatch + cli.ts knownCommands) skipped any plugin whose
 * plugin.json omitted the `cli` field — and every community plugin extracted
 * during the cascade was missing that field.
 *
 * Fix contract (mirrored across dispatch-match + cli.ts + registry-invoke):
 *   - When manifest.cli is present → use cli.command + cli.aliases (existing).
 *   - When manifest.cli is absent  → default the command to manifest.name IFF
 *     the plugin is dispatchable (has entryPath or wasmPath). Headless plugins
 *     (api-only / hooks-only / cron-only) remain skipped — their absence
 *     should still surface as an unknown command, not silently route into a
 *     plugin that has nothing to run.
 *
 * Tests pin both branches: explicit cli wins, default-name path resolves,
 * non-dispatchable plugins stay unknown, and unknown commands still error
 * with the same fuzzy-suggest UX as before.
 */

import { describe, test, expect } from "bun:test";
import { resolvePluginMatch, pluginCliNames } from "../../src/cli/dispatch-match";
import type { LoadedPlugin } from "../../src/plugin/types";

// ─── Fixture builders ────────────────────────────────────────────────────────

function tsPlugin(opts: {
  name: string;
  cli?: { command: string; aliases?: string[] };
  entry?: boolean;
}): LoadedPlugin {
  return {
    manifest: {
      name: opts.name,
      version: "1.0.0",
      sdk: "^1.0.0",
      ...(opts.cli ? { cli: { command: opts.cli.command, aliases: opts.cli.aliases ?? [], help: "" } } : {}),
    } as LoadedPlugin["manifest"],
    dir: `/tmp/${opts.name}`,
    wasmPath: "",
    ...(opts.entry !== false ? { entryPath: `/tmp/${opts.name}/src/index.ts` } : {}),
    kind: "ts",
  };
}

function wasmPlugin(opts: {
  name: string;
  cli?: { command: string; aliases?: string[] };
  wasm?: boolean;
}): LoadedPlugin {
  return {
    manifest: {
      name: opts.name,
      version: "1.0.0",
      sdk: "^1.0.0",
      ...(opts.cli ? { cli: { command: opts.cli.command, aliases: opts.cli.aliases ?? [], help: "" } } : {}),
    } as LoadedPlugin["manifest"],
    dir: `/tmp/${opts.name}`,
    wasmPath: opts.wasm !== false ? `/tmp/${opts.name}/${opts.name}.wasm` : "",
    kind: "wasm",
  };
}

// ─── pluginCliNames — unit contract ──────────────────────────────────────────

describe("#899 — pluginCliNames default-name derivation", () => {
  test("explicit cli field is used verbatim (canonical command + aliases)", () => {
    const p = tsPlugin({ name: "shellenv", cli: { command: "shellenv", aliases: ["se"] } });
    expect(pluginCliNames(p)).toEqual({ command: "shellenv", aliases: ["se"] });
  });

  test("missing cli field defaults to manifest.name for dispatchable TS plugins", () => {
    // Canonical community-plugin shape: plugin.json without `cli`, entry → src/index.ts.
    const p = tsPlugin({ name: "shellenv" });
    expect(pluginCliNames(p)).toEqual({ command: "shellenv", aliases: [] });
  });

  test("missing cli field defaults to manifest.name for dispatchable WASM plugins", () => {
    const p = wasmPlugin({ name: "wasmer" });
    expect(pluginCliNames(p)).toEqual({ command: "wasmer", aliases: [] });
  });

  test("non-dispatchable plugin (no entry, no wasm) → null (skipped from CLI)", () => {
    // Hooks-only / api-only plugin: no entry path on disk, no wasm. Should
    // NOT register a default cli command — its name still needs to surface
    // as an unknown command if a user types it.
    const p: LoadedPlugin = {
      manifest: { name: "hooks-only", version: "1.0.0", sdk: "^1.0.0" } as LoadedPlugin["manifest"],
      dir: "/tmp/hooks-only",
      wasmPath: "",
      kind: "ts",
      // no entryPath
    };
    expect(pluginCliNames(p)).toBeNull();
  });

  test("aliases default to empty array when cli omits them", () => {
    const p = tsPlugin({ name: "rename", cli: { command: "rename" } });
    expect(pluginCliNames(p)).toEqual({ command: "rename", aliases: [] });
  });
});

// ─── resolvePluginMatch — dispatch through default-name path ─────────────────

describe("#899 — resolvePluginMatch routes default-name plugins", () => {
  test("source plugin in ~/.maw/plugins/shellenv/ dispatches as `maw shellenv`", () => {
    const shellenv = tsPlugin({ name: "shellenv" }); // no cli field
    const out = resolvePluginMatch([shellenv], "shellenv zsh");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("shellenv");
      expect(out.matchedName).toBe("shellenv");
    }
  });

  test("explicit cli field wins over default-name when present", () => {
    // Plugin name and cli command differ — ensure cli wins (existing contract).
    const p = tsPlugin({ name: "internal-name", cli: { command: "public-cmd" } });
    const out = resolvePluginMatch([p], "public-cmd");
    expect(out.kind).toBe("match");
    if (out.kind === "match") expect(out.matchedName).toBe("public-cmd");

    // The internal plugin name should NOT match anymore — cli overrides it.
    const miss = resolvePluginMatch([p], "internal-name");
    expect(miss.kind).toBe("none");
  });

  test("default-name + explicit cli plugins coexist in registry without crosstalk", () => {
    // Mixed registry: canonical built-in (with cli) + community (without).
    const builtIn = tsPlugin({ name: "scope", cli: { command: "scope", aliases: ["scopes"] } });
    const community = tsPlugin({ name: "shellenv" });
    const a = resolvePluginMatch([builtIn, community], "scope list");
    expect(a.kind).toBe("match");
    if (a.kind === "match") expect(a.plugin.manifest.name).toBe("scope");
    const b = resolvePluginMatch([builtIn, community], "shellenv");
    expect(b.kind).toBe("match");
    if (b.kind === "match") expect(b.plugin.manifest.name).toBe("shellenv");
  });

  test("default-name plugin matches with subcommand args (prefix path)", () => {
    // `maw rename old new` — community plugin without cli, args follow the name.
    const rename = tsPlugin({ name: "rename" });
    const out = resolvePluginMatch([rename], "rename old new");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("rename");
      expect(out.matchedName).toBe("rename");
    }
  });

  test("non-dispatchable plugin's manifest.name is NOT a CLI surface", () => {
    // Headless plugin shape — should fall through to "unknown command" so the
    // top-level cli.ts fuzzy-suggest path still runs.
    const headless: LoadedPlugin = {
      manifest: { name: "ghost", version: "1.0.0", sdk: "^1.0.0" } as LoadedPlugin["manifest"],
      dir: "/tmp/ghost",
      wasmPath: "",
      kind: "ts",
    };
    const out = resolvePluginMatch([headless], "ghost");
    expect(out.kind).toBe("none");
  });

  test("unknown command still returns kind:none with a default-name registry", () => {
    const shellenv = tsPlugin({ name: "shellenv" });
    const rename = tsPlugin({ name: "rename" });
    const out = resolvePluginMatch([shellenv, rename], "definitely-not-a-plugin");
    expect(out.kind).toBe("none");
  });

  test("two source plugins sharing the same name → ambiguous (still reports)", () => {
    // Edge: two `~/.maw/plugins/foo/` dirs surfaced (e.g. dev-mode symlink +
    // tarball install of same name). The default-name path must still flag
    // ambiguity rather than picking the first silently.
    const a = tsPlugin({ name: "twin" });
    const b = tsPlugin({ name: "twin" });
    const out = resolvePluginMatch([a, b], "twin");
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.candidates.map(c => c.name)).toEqual(["twin", "twin"]);
    }
  });

  test("default-name plugin does NOT collide with a longer-prefixed default-name plugin", () => {
    // `bg` and `bg-helper` both default-named — typing `bg-helper` must not
    // route to `bg` (prefix word-boundary contract from #354).
    const bg = tsPlugin({ name: "bg" });
    const bgHelper = tsPlugin({ name: "bg-helper" });
    const out = resolvePluginMatch([bg, bgHelper], "bg-helper status");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("bg-helper");
      expect(out.matchedName).toBe("bg-helper");
    }
  });

  test("explicit cli command overrides plugin.name even when name is also typed", () => {
    // Plugin renamed its CLI surface — `maw <plugin-name>` should NOT match;
    // only the explicit `cli.command` does. Confirms default-name fallback
    // doesn't leak into plugins that opted into a custom CLI surface.
    const p = tsPlugin({ name: "ctq", cli: { command: "queue" } });
    const a = resolvePluginMatch([p], "queue list");
    expect(a.kind).toBe("match");
    if (a.kind === "match") expect(a.matchedName).toBe("queue");
    const b = resolvePluginMatch([p], "ctq");
    expect(b.kind).toBe("none");
  });

  test("WASM plugin without cli still dispatches via manifest.name", () => {
    // Phase A ships TS-first, but the contract must hold for wasm too — the
    // bundled `done.wasm` style plugin (if community-published without cli)
    // would otherwise be unreachable. Symmetric with TS path.
    const w = wasmPlugin({ name: "wasmcmd" });
    const out = resolvePluginMatch([w], "wasmcmd");
    expect(out.kind).toBe("match");
    if (out.kind === "match") expect(out.matchedName).toBe("wasmcmd");
  });

  test("backward-compat: built-in plugin with cli + aliases still dispatches via aliases", () => {
    // Sanity check that the default-name change didn't break alias matching
    // for canonical built-in plugins. Mirrors `maw finish <window>` → done.
    const done = tsPlugin({ name: "done", cli: { command: "done", aliases: ["finish"] } });
    const out = resolvePluginMatch([done], "finish my-window");
    expect(out.kind).toBe("match");
    if (out.kind === "match") {
      expect(out.plugin.manifest.name).toBe("done");
      expect(out.matchedName).toBe("finish");
    }
  });
});
