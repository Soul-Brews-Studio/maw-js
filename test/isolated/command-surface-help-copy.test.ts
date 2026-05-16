import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function json<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), rel), "utf8")) as T;
}

function help(rel: string): string {
  return json<{ cli?: { help?: string } }>(rel).cli?.help ?? "";
}

function desc(rel: string): string {
  return json<{ description?: string }>(rel).description ?? "";
}

function summary(rel: string): string {
  return json<{ summary?: string }>(rel).summary ?? "";
}

describe("#1531 command-surface help copy", () => {
  test("ls and fleet cross-reference live sessions vs registered fleet config", () => {
    expect(help("src/vendor/mpr-plugins/ls/plugin.json")).toContain("maw fleet ls");
    expect(help("src/commands/plugins/fleet/plugin.json")).toContain("maw ls");
    expect(desc("src/vendor/mpr-plugins/ls/plugin.json")).toContain("live sessions");
    expect(desc("src/commands/plugins/fleet/plugin.json")).toContain("persistent fleet registry");
  });

  test("pane, panes, and tile explain their distinct pane-management roles", () => {
    expect(help("src/vendor/mpr-plugins/panes/plugin.json")).toContain("maw pane swap");
    expect(help("src/vendor/mpr-plugins/panes/plugin.json")).toContain("maw tile");
    expect(help("src/commands/plugins/pane/plugin.json")).toContain("maw panes");
    expect(help("src/commands/plugins/pane/plugin.json")).toContain("maw tile");
    expect(help("src/commands/plugins/tile/plugin.json")).toContain("maw panes");
    expect(help("src/commands/plugins/tile/plugin.json")).toContain("maw pane swap");
  });

  test("peek, capture, and view clarify read-only glance, scrollback, and attach", () => {
    expect(help("src/vendor/mpr-plugins/peek/plugin.json")).toContain("maw capture");
    expect(help("src/vendor/mpr-plugins/peek/plugin.json")).toContain("maw view");
    expect(help("src/vendor/mpr-plugins/capture/plugin.json")).toContain("maw peek");
    expect(help("src/vendor/mpr-plugins/view/plugin.json")).toContain("maw peek/capture");
  });

  test("kill, sleep, and done clarify immediate, graceful, and worktree shutdown", () => {
    expect(help("src/vendor/mpr-plugins/kill/plugin.json")).toContain("maw sleep");
    expect(help("src/vendor/mpr-plugins/kill/plugin.json")).toContain("maw done");
    expect(help("src/vendor/mpr-plugins/sleep/plugin.json")).toContain("maw kill");
    expect(help("src/vendor/mpr-plugins/sleep/plugin.json")).toContain("maw done");
    expect(help("src/vendor/mpr-plugins/done/plugin.json")).toContain("maw sleep/kill");
  });

  test("tab, bg, and rename descriptions are concrete instead of vague", () => {
    expect(desc("src/vendor/mpr-plugins/tab/plugin.json")).toContain("peek a tab");
    expect(desc("src/vendor/mpr-plugins/bg/plugin.json")).toContain("without blocking");
    expect(desc("src/vendor/mpr-plugins/rename/plugin.json")).toContain("Oracle-prefix");
  });

  test("vendored registry summaries mirror updated manifest descriptions", () => {
    for (const name of [
      "ls", "peek", "capture", "view", "kill", "done", "sleep", "panes", "tab", "bg", "rename",
    ]) {
      expect(summary(`src/vendor/mpr-plugins/${name}/registry.meta.json`)).toBe(
        desc(`src/vendor/mpr-plugins/${name}/plugin.json`),
      );
    }
  });
});
