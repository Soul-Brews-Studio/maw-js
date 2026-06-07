import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runPluginEventHooks } from "../src/plugin/event-hooks";
import type { LoadedPlugin } from "../src/plugin/types";

function pluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-plugin-event-hooks-"));
  return dir;
}

describe("runPluginEventHooks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  test("dispatches event-specific handler from plugin entry", async () => {
    const dir = pluginDir();
    dirs.push(dir);
    const entry = join(dir, "index.ts");
    writeFileSync(entry, "export function onTransportAfterSend(evt) { (globalThis as any).__transportAfterSend = evt; }\n");
    const plugin: LoadedPlugin = {
      manifest: {
        name: "relay",
        version: "1.0.0",
        sdk: "*",
        hooks: { on: ["transport:after_send"] },
      },
      dir,
      wasmPath: "",
      entryPath: entry,
      kind: "ts",
    };

    (globalThis as any).__transportAfterSend = undefined;
    const summary = await runPluginEventHooks("transport:after_send", { from: "a", to: "b", message: "m", result: { ok: true }, via: "tmux" }, () => [plugin]);

    expect(summary).toEqual({ eventName: "transport:after_send", matched: 1, skipped: 0, invoked: 1, failed: 0 });
    expect((globalThis as any).__transportAfterSend).toEqual({
      from: "a",
      to: "b",
      message: "m",
      via: "tmux",
      result: { ok: true },
      plugin: { name: "relay", dir },
    });
  });

  test("uses fallback handler for plugin exports without event-specific name", async () => {
    const dir = pluginDir();
    dirs.push(dir);
    const entry = join(dir, "index.ts");
    writeFileSync(entry, "export function on(evt) { (globalThis as any).__fallbackHandler = evt; }\n");
    const plugin: LoadedPlugin = {
      manifest: {
        name: "legacy",
        version: "1.0.0",
        sdk: "*",
        hooks: { on: ["transport:after_send"] },
      },
      dir,
      wasmPath: "",
      entryPath: entry,
      kind: "ts",
    };

    (globalThis as any).__fallbackHandler = undefined;
    const summary = await runPluginEventHooks("transport:after_send", { route: "local", result: { ok: true } }, () => [plugin]);

    expect(summary).toEqual({ eventName: "transport:after_send", matched: 1, skipped: 0, invoked: 1, failed: 0 });
    expect((globalThis as any).__fallbackHandler).toMatchObject({
      route: "local",
      result: { ok: true },
      plugin: { name: "legacy", dir },
    });
  });
});
