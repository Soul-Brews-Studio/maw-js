import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  isStaleServeSession,
  reapStaleServeSessions,
  serve,
} from "../../src/vendor-plugins/serve-session-reaper/index.ts?plugin-serve-session-reaper-standalone";

const root = join(import.meta.dir, "../..");

describe("serve-session-reaper plugin standalone boundary", () => {
  test("declares best-effort serve hook for startup stale session cleanup", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-session-reaper/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "best-effort" });
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("reapStaleServeSessions");
  });

  test("boundary drift is explicit for this core lifecycle plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-session-reaper",
      pluginDir: "src/vendor-plugins/serve-session-reaper",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/core\/transport\/ssh$/,
        /^\.\.\/\.\.\/core\/transport\/tmux$/,
      ],
    });
  });

  test("classifies stale PTY and view sessions only", () => {
    expect(isStaleServeSession("maw-pty-abc")).toBe(true);
    expect(isStaleServeSession("neo-view")).toBe(true);
    expect(isStaleServeSession("mawjs")).toBe(false);
    expect(isStaleServeSession("view-master")).toBe(false);
  });

  test("reaps stale sessions and preserves startup log shape", async () => {
    const killed: string[] = [];
    const lines: string[] = [];
    const result = await reapStaleServeSessions({
      listSessions: async () => [
        { name: "maw-pty-old" },
        { name: "alpha-view" },
        { name: "mawjs" },
      ],
      createReaper: () => ({ killSession: async (name: string) => { killed.push(name); } }),
    }, { info: (line) => lines.push(String(line)) });

    expect(result).toEqual({ ok: true, killed: ["maw-pty-old", "alpha-view"], checked: 3 });
    expect(killed).toEqual(["maw-pty-old", "alpha-view"]);
    expect(lines).toEqual([
      "[startup] reaped orphan: maw-pty-old",
      "[startup] reaped orphan: alpha-view",
      "[startup] cleaned 2 orphaned sessions",
    ]);
  });

  test("tmux/list failures remain best-effort and quiet", async () => {
    const result = await reapStaleServeSessions({
      listSessions: async () => { throw new Error("tmux down"); },
    });
    expect(result).toEqual({ ok: true, killed: [], checked: 0 });
  });

  test("serve hook delegates to the reaper", async () => {
    const result = await serve({}, {
      listSessions: async () => [{ name: "maw-pty-one" }],
      createReaper: () => ({ killSession: async () => {} }),
    });
    expect(result).toEqual({ ok: true, killed: ["maw-pty-one"], checked: 1 });
  });
});
