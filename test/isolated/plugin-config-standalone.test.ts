/**
 * Standalone coverage for src/commands/plugins/config/index.ts.
 *
 * Current state: this plugin still imports `loadConfigWithProvenance` directly from
 * `src/config` (not yet from `@maw-js/sdk`). The test mocks that local surface so
 * extraction-ready behavior can be validated now and can switch to SDK import once
 * the symbol is exported in `packages/sdk`.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { beforeEach } from "bun:test";
import type { InvokeContext, InvokeResult } from "../../src/plugin/types";
import { mockConfigModule } from "../helpers/mock-config";
afterAll(() => { mock.restore(); });

const loadedConfig = {
  config: {
    host: "local",
    port: 3456,
    teams: {
      default: ["a", "b"],
    },
    limits: {
      maxConcurrentAgents: 20,
    },
  },
  sources: [
    {
      path: "/etc/maw/core.config.json",
      weight: 10,
      isLocal: false,
      scope: "core",
      scopeRank: 100,
      depth: 1,
      mtimeMs: 111,
    },
    {
      path: "/cwd/maw.config.json",
      weight: 0,
      isLocal: true,
      scope: "project",
      scopeRank: 10,
      depth: 0,
      mtimeMs: 222,
    },
  ],
  provenance: {
    "limits": [
      {
        path: "/etc/maw/core.config.json",
        weight: 10,
        isLocal: false,
        scope: "core",
        action: "set",
        value: { maxConcurrentAgents: 10 },
      },
    ],
    "limits.maxConcurrentAgents": [
      {
        path: "/cwd/maw.config.json",
        weight: 0,
        isLocal: true,
        scope: "project",
        action: "set",
        value: 20,
      },
    ],
    "teams.default": [
      {
        path: "/etc/maw/core.config.json",
        weight: 10,
        isLocal: false,
        scope: "core",
        action: "set",
        value: ["legacy"],
      },
      {
        path: "/cwd/maw.config.json",
        weight: 0,
        isLocal: true,
        scope: "project",
        action: "set",
        value: ["a", "b"],
      },
    ],
  },
  warnings: ["project-level key overridden"],
};

let loadCallCount = 0;
let lastLoadOptions: unknown;
let savedPatch: unknown;

mock.module(import.meta.resolve("../../src/config.ts"), () => ({
  ...mockConfigModule(() => loadedConfig.config as any),
  saveConfig: (patch: unknown) => {
    savedPatch = patch;
    return { ...loadedConfig.config, limits: { maxConcurrentAgents: 25 } };
  },
  loadConfigWithProvenance: (opts?: unknown) => {
    loadCallCount += 1;
    lastLoadOptions = opts;
    return loadedConfig;
  },
}));

const { command, default: configHandler } = await import("../../src/commands/plugins/config/index.ts");

function run(args: string[], writer: ((...parts: unknown[]) => void) | undefined = undefined): Promise<InvokeResult> {
  return configHandler({
    source: "cli",
    args,
    writer,
  } as InvokeContext);
}

describe("src/commands/plugins/config/index.ts", () => {
  beforeEach(() => {
    loadCallCount = 0;
    lastLoadOptions = undefined;
    savedPatch = undefined;
  });

  test("exports metadata", () => {
    expect(command).toEqual({
      name: "config",
      description: "Inspect cwd-aware maw config layers and provenance.",
    });
  });

  test("show renders merged config JSON", async () => {
    const logs: string[] = [];
    const result = await run(["show"], (...parts) => logs.push(parts.map(String).join(" ")));

    const parsed = JSON.parse(logs.join("\n"));
    expect(result).toEqual({ ok: true, output: undefined });
    expect(loadCallCount).toBe(1);
    expect(parsed).toMatchObject(loadedConfig.config);
    expect(lastLoadOptions).toEqual({ cwd: process.cwd() });
  });

  test("sources with --json returns structured rows + warnings", async () => {
    const logs: string[] = [];
    const result = await run(["sources", "--json"], (...parts) => logs.push(parts.map(String).join(" ")));

    const payload = JSON.parse(logs.join("\n"));
    expect(result.ok).toBe(true);
    expect(payload).toEqual({
      sources: [
        {
          weight: 10,
          scope: "core",
          local: false,
          file: "/etc/maw/core.config.json",
        },
        {
          weight: 0,
          scope: "project",
          local: true,
          file: "/cwd/maw.config.json",
        },
      ],
      warnings: ["project-level key overridden"],
    });
  });

  test("set accepts dot-path nested keys and numeric values", async () => {
    const logs: string[] = [];
    const result = await run(["set", "limits.maxConcurrentAgents", "25", "--json"], (...parts) => logs.push(parts.map(String).join(" ")));

    expect(result.ok).toBe(true);
    expect(savedPatch).toEqual({ limits: { maxConcurrentAgents: 25 } });
    expect(JSON.parse(logs.join("\n"))).toEqual({ key: "limits.maxConcurrentAgents", value: 25 });
  });

  test("explain returns provenance and final value", async () => {
    const logs: string[] = [];
    const result = await run(
      ["explain", "teams.default", "--json"],
      (...parts) => logs.push(parts.map(String).join(" ")),
    );

    const payload = JSON.parse(logs.join("\n"));
    expect(result.ok).toBe(true);
    expect(payload).toEqual({
      key: "teams.default",
      finalValue: ["a", "b"],
      entries: loadedConfig.provenance["teams.default"],
    });
  });

  test("explain resolves nested limits final value and provenance", async () => {
    const logs: string[] = [];
    const result = await run(["explain", "limits.maxConcurrentAgents", "--json"], (...parts) => logs.push(parts.map(String).join(" ")));

    const payload = JSON.parse(logs.join("\n"));
    expect(result.ok).toBe(true);
    expect(payload).toEqual({
      key: "limits.maxConcurrentAgents",
      finalValue: 20,
      entries: loadedConfig.provenance["limits.maxConcurrentAgents"],
    });
  });

  test("explain falls back to built-in defaults when no layer sets maxConcurrentAgents (#2692)", async () => {
    const originalLimit = loadedConfig.config.limits.maxConcurrentAgents;
    const originalProvenance = loadedConfig.provenance["limits.maxConcurrentAgents"];
    delete (loadedConfig.config.limits as Record<string, unknown>).maxConcurrentAgents;
    delete (loadedConfig.provenance as Record<string, unknown>)["limits.maxConcurrentAgents"];
    try {
      const logs: string[] = [];
      const result = await run(["explain", "limits.maxConcurrentAgents", "--json"], (...parts) => logs.push(parts.map(String).join(" ")));

      const payload = JSON.parse(logs.join("\n"));
      expect(result.ok).toBe(true);
      expect(payload.key).toBe("limits.maxConcurrentAgents");
      expect(payload.finalValue).toBe(40);
      expect(payload.entries[0]).toEqual({
        path: "built-in default",
        weight: null,
        scope: "built-in default",
        isLocal: false,
        action: "default",
        value: 40,
      });
    } finally {
      loadedConfig.config.limits.maxConcurrentAgents = originalLimit;
      loadedConfig.provenance["limits.maxConcurrentAgents"] = originalProvenance;
    }
  });

  test("explain text output prints the built-in default final value (#2692)", async () => {
    const logs: string[] = [];
    const result = await run(["explain", "limits.peerProbeRetries"], (...parts) => logs.push(parts.map(String).join(" ")));

    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("built-in default default built-in default");
    expect(logs.join("\n")).toContain("FINAL 2");
  });

  test("usage path for missing explain key", async () => {
    const result = await run(["explain"]);

    expect(result).toEqual({
      ok: false,
      error: "usage: maw config explain <key> [--json]",
    });
  });

  test("bad subcommand returns usage error", async () => {
    const result = await run(["unknown"]);

    expect(result).toEqual({
      ok: false,
      error: "usage: maw config <show|sources|explain <key>|set <key> <value>> [--json]",
    });
  });
});
