import { describe, expect, test } from "bun:test";
import { formatUsage } from "../src/cli/usage";
import { parseCli } from "../src/plugin/manifest-validate";
import type { LoadedPlugin } from "../src/plugin/types";

function plugin(command: string, description: string, hidden?: boolean, weight = 1): LoadedPlugin {
  return {
    manifest: {
      name: command,
      version: "1.0.0",
      sdk: "^1.0.0",
      weight,
      description,
      cli: { command, ...(hidden !== undefined ? { hidden } : {}) },
    } as LoadedPlugin["manifest"],
    dir: `/tmp/${command}`,
    wasmPath: "",
    kind: "ts",
  };
}

describe("usage hidden plugins", () => {
  test("hidden plugin is excluded from listing and count, normal stays", () => {
    const output = formatUsage([
      plugin("status", "Show fleet status"),
      plugin("watch", "Activity worklog", true),
    ]);

    expect(output).toContain("maw status");
    expect(output).not.toContain("maw watch");
    // count reflects only the one visible command
    expect(output).toContain("1 commands active.");
  });

  test("plugin without hidden (undefined) still shows (back-compat)", () => {
    const output = formatUsage([plugin("status", "Show fleet status")]);
    expect(output).toContain("maw status");
    expect(output).toContain("1 commands active.");
  });
});

describe("parseCli hidden preservation", () => {
  test("preserves hidden:true", () => {
    expect(parseCli({ cli: { command: "x", hidden: true } })).toEqual({
      command: "x",
      hidden: true,
    });
  });

  test("omits hidden key when absent", () => {
    const result = parseCli({ cli: { command: "x" } });
    expect(result).toEqual({ command: "x" });
    expect(result && "hidden" in result).toBe(false);
  });

  test("escape-hatch intact: command preserved even when hidden", () => {
    // hiding from help must NOT strip command — dispatch still matches it
    const result = parseCli({ cli: { command: "watch", hidden: true } });
    expect(result?.command).toBe("watch");
  });
});
