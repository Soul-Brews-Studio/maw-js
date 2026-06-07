import { describe, expect, test } from "bun:test";
import { dependencyStatus, enablePlanFor, pluginDependencyNames } from "../src/plugin/dependencies";
import type { LoadedPlugin, PluginManifest } from "../src/plugin/types";

function plugin(name: string, deps: string[] = [], disabled = false): LoadedPlugin {
  const manifest: PluginManifest = {
    name,
    version: "1.0.0",
    sdk: "^1.0.0",
    entry: "index.ts",
    ...(deps.length ? { dependencies: { plugins: deps } } : {}),
  };
  return {
    manifest,
    dir: `/tmp/${name}`,
    wasmPath: "",
    entryPath: `/tmp/${name}/index.ts`,
    kind: "ts",
    ...(disabled ? { disabled: true } : {}),
  };
}

describe("plugin dependency helpers", () => {
  test("pluginDependencyNames returns declared dependencies or an empty list", () => {
    expect(pluginDependencyNames(plugin("plain"))).toEqual([]);
    expect(pluginDependencyNames(plugin("consumer", ["trace", "dig"]))).toEqual(["trace", "dig"]);
  });

  test("dependencyStatus reports recursive disabled and missing dependencies", () => {
    const target = plugin("target", ["trace", "ghost"]);
    const trace = plugin("trace", ["dig"], true);
    const dig = plugin("dig", [], true);

    expect(dependencyStatus(target, [target, trace, dig])).toEqual({
      disabled: ["dig", "trace"],
      missing: ["ghost"],
    });
  });

  test("dependencyStatus de-duplicates shared dependencies and survives cycles", () => {
    const target = plugin("target", ["a", "b", "missing", "missing"]);
    const a = plugin("a", ["shared", "b"], true);
    const b = plugin("b", ["a", "shared"], true);
    const shared = plugin("shared", [], true);

    expect(dependencyStatus(target, [target, a, b, shared])).toEqual({
      disabled: ["shared", "b", "a"],
      missing: ["missing"],
    });
  });

  test("enablePlanFor returns disabled dependencies and optionally the target plugin", () => {
    const target = plugin("target", ["trace", "dig"], true);
    const trace = plugin("trace", [], true);
    const dig = plugin("dig", [], false);

    expect(enablePlanFor(target, [target, trace, dig], false)).toEqual(["trace"]);
    expect(enablePlanFor(target, [target, trace, dig], true)).toEqual(["trace", "target"]);
  });

  test("enablePlanFor keeps a stable unique plan when self also appears as a dependency", () => {
    const target = plugin("target", ["target"], true);
    expect(enablePlanFor(target, [target], true)).toEqual(["target"]);
  });
});
