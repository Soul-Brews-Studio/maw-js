import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { watchUserPlugins } from "../src/plugins/40_watcher";

const tempDirs: string[] = [];
const originalHotReload = process.env.MAW_HOT_RELOAD;
const fsModule = require("fs") as typeof import("fs") & {
  watch: (dir: string, opts: unknown, cb: (event: string, filename: string | null) => void) => { close: () => void };
  existsSync: (path: string) => boolean;
};
const originalWatch = fsModule.watch;
const originalExistsSync = fsModule.existsSync;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-plugin-watch-"));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 600): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
}

afterEach(() => {
  if (originalHotReload === undefined) delete process.env.MAW_HOT_RELOAD;
  else process.env.MAW_HOT_RELOAD = originalHotReload;
  fsModule.watch = originalWatch;
  fsModule.existsSync = originalExistsSync;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("watchUserPlugins", () => {
  test("returns a no-op closer when hot reload is disabled", () => {
    process.env.MAW_HOT_RELOAD = "0";
    const dir = tempDir();
    let calls = 0;

    const close = watchUserPlugins(dir, () => { calls += 1; }, 1);
    close();

    expect(calls).toBe(0);
  });

  test("returns a no-op closer for missing directories", () => {
    delete process.env.MAW_HOT_RELOAD;
    let calls = 0;

    const close = watchUserPlugins(join(tempDir(), "missing"), () => { calls += 1; }, 1);
    close();

    expect(calls).toBe(0);
  });

  test("debounces ts/js/wasm file changes and ignores unrelated files", async () => {
    delete process.env.MAW_HOT_RELOAD;
    let captured: ((event: string, filename: string | null) => void) | null = null;
    let closed = false;
    fsModule.existsSync = () => true;
    fsModule.watch = (_dir, _opts, cb) => {
      captured = cb;
      return { close: () => { closed = true; } };
    };
    const seen: string[] = [];

    const close = watchUserPlugins("/plugins", (changed) => { seen.push(changed); }, 10);
    captured?.("change", "notes.md");
    captured?.("change", "plugin.ts");
    captured?.("change", "plugin.js");
    await waitFor(() => seen.length > 0);
    close();

    expect(seen).toEqual(["plugin.js"]);
    expect(closed).toBe(true);
  });

  test("logs reload callback failures without throwing", async () => {
    delete process.env.MAW_HOT_RELOAD;
    let captured: ((event: string, filename: string | null) => void) | null = null;
    fsModule.existsSync = () => true;
    fsModule.watch = (_dir, _opts, cb) => {
      captured = cb;
      return { close: () => {} };
    };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    const close = watchUserPlugins("/plugins", () => { throw new Error("reload broke"); }, 10);

    try {
      captured?.("change", "plugin.js");
      await waitFor(() => errors.length > 0);
    } finally {
      close();
      console.error = originalError;
    }

    expect(errors.join("\n")).toContain("[plugin:reload] failed for plugin.js: reload broke");
  });
});
