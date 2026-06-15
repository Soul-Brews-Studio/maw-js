import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/mega");

const tempHome = mkdtempSync(join(tmpdir(), "maw-mega-plugin-"));

let paneIds: Set<string>;
let killedPanes: string[];

mock.module("os", () => ({
  homedir: () => tempHome,
}));

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  tmux: {
    listPaneIds: async () => paneIds,
    killPane: async (paneId: string) => {
      killedPanes.push(paneId);
    },
  },
}));

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }

  return [...specs];
}

function loadMegaPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadMegaPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

function writeTeam(name: string, config: Record<string, unknown>) {
  const dir = join(tempHome, ".claude", "teams", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function writeTask(team: string, id: string, task: Record<string, unknown>) {
  const dir = join(tempHome, ".claude", "tasks", team);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, ...task }));
}

beforeEach(() => {
  rmSync(join(tempHome, ".claude"), { recursive: true, force: true });
  process.env.HOME = tempHome;
  paneIds = new Set(["%1"]);
  killedPanes = [];
});

afterAll(() => {
  if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
});

describe("mega plugin standalone coverage", () => {
  test("plugin sources stay off direct core/shared/lib/config imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config")).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk"]));
  });

  test("plugin loads from manifest and reports an empty team tree", async () => {
    const plugin = loadMegaPlugin();
    expect(plugin.manifest.name).toBe("mega");

    const { result, output } = await invokeCli([]);

    expect(result.ok).toBe(true);
    expect(output).toContain("No teams found");
  });

  test("status renders live teams and task progress through SDK tmux", async () => {
    writeTeam("mega-scout", {
      name: "mega-scout",
      description: "Scout lane",
      createdAt: Date.now(),
      members: [
        { name: "team-lead", model: "inherit", tmuxPaneId: "%1" },
        { name: "finder", color: "cyan", model: "claude-3-haiku", tmuxPaneId: "%2", backendType: "tmux" },
      ],
    });
    writeTask("mega-scout", "task-1", { subject: "Map plugin boundary", status: "completed", owner: "finder" });

    const { result, output } = await invokeCli(["status"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("MEGA-SCOUT");
    expect(output).toContain("Scout lane");
    expect(output).toContain("1/1 tasks");
    expect(output).toContain("team-lead");
    expect(output).toContain("finder");
    expect(output).toContain("Map plugin boundary");
  });

  test("stop kills live team panes and leaves in-process members alone", async () => {
    writeTeam("mega-live", {
      name: "mega-live",
      description: "Live lane",
      createdAt: Date.now(),
      members: [
        { name: "team-lead", tmuxPaneId: "%1" },
        { name: "memory", tmuxPaneId: "in-process" },
        { name: "stale", tmuxPaneId: "%9" },
      ],
    });

    const { result, output } = await invokeCli(["stop"]);

    expect(result.ok).toBe(true);
    expect(killedPanes).toEqual(["%1"]);
    expect(output).toContain("Stopping 1 team");
    expect(output).toContain("killed pane %1");
  });

  test("unknown subcommand prints local usage", async () => {
    const { result, output } = await invokeCli(["wat"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("maw mega");
    expect(output).toContain("maw mega stop");
  });
});
