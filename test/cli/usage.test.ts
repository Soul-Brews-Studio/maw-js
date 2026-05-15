import { describe, expect, test } from "bun:test";
import { formatUsage } from "../../src/cli/usage";
import type { LoadedPlugin } from "../../src/plugin/types";

function plugin(command: string, description: string, weight = 1): LoadedPlugin {
  return {
    manifest: {
      name: command,
      version: "1.0.0",
      sdk: "^1.0.0",
      weight,
      description,
      cli: { command },
    } as LoadedPlugin["manifest"],
    dir: `/tmp/${command}`,
    wasmPath: "",
    kind: "ts",
  };
}

describe("usage alias grouping", () => {
  test("groups equivalent aliases inline instead of listing duplicates", () => {
    const output = formatUsage([
      plugin("attach", "Smart attach: live tmux session, or wake from fleet"),
      plugin("team", "Team — create, spawn, send, shutdown"),
      plugin("wake", "Wake an oracle session"),
      plugin("tile", "Tile current window"),
    ]);

    expect(output).toContain("maw attach (a)");
    expect(output).toContain("maw bring (b)");
    expect(output).toContain("maw team (t)");
    expect(output).not.toMatch(/^\s+maw a\s/m);
    expect(output).not.toMatch(/^\s+maw b\s/m);
    expect(output).not.toMatch(/^\s+maw t\s/m);
    expect(output).toContain("commands active");
  });
});
