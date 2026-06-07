import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedPlugin } from "../src/plugin/types";

import { mock } from "bun:test";

let eventLogPath = "";
let discoverPackagesResult: LoadedPlugin[] = [];

mock.module("../src/plugin/registry", () => ({
  discoverPackages: () => discoverPackagesResult,
}));

const eventHooks = await import("../src/plugin/event-hooks");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  eventLogPath = "";
  discoverPackagesResult = [];
  delete process.env.MAW_TEST_EVENT_HOOK_LOG;
});

function makePlugin(name: string, options: {
  hooksOn?: string[];
  disabled?: boolean;
  kind?: "ts" | "wasm";
} = {}): LoadedPlugin {
  const dir = mkdtempSync(join(tmpdir(), `maw-event-${name}-`));
  tmpDirs.push(dir);
  const indexPath = join(dir, "index.ts");
  writeFileSync(indexPath, "export function onTransportAfterSend(payload) { const fs = require(\"fs\"); fs.appendFileSync(process.env.MAW_TEST_EVENT_HOOK_LOG || '', JSON.stringify(payload) + \"\\n\"); }\n", { encoding: "utf8" });
  return {
    dir,
    entryPath: indexPath,
    wasmPath: "",
    kind: options.kind ?? "ts",
    disabled: options.disabled,
    manifest: {
      name,
      version: "1.0.0",
      sdk: "*",
      entry: "index.ts",
      hooks: {
        on: options.hooksOn,
      },
    },
  };
}

function pluginDir(): void {
  const logDir = mkdtempSync(join(tmpdir(), "maw-event-log-"));
  tmpDirs.push(logDir);
  eventLogPath = join(logDir, "events.ndjson");
  writeFileSync(eventLogPath, "", { encoding: "utf8" });
}

describe("plugin event-hooks runtime", () => {
  test("runs matching transport event handlers on matching manifest hooks", async () => {
    pluginDir();
    process.env.MAW_TEST_EVENT_HOOK_LOG = eventLogPath;
    discoverPackagesResult = [
      makePlugin("active", { hooksOn: ["transport:after_send"] }),
      makePlugin("ignore-other", { hooksOn: ["session:start"] }),
      makePlugin("disabled", { hooksOn: ["transport:after_send"], disabled: true }),
    ];

    await eventHooks.runPluginEventHooks("transport:after_send", {
      target: { oracle: "neo", tmuxTarget: "test:1" },
      message: "hello",
      from: "m5:volt",
      result: { ok: true, via: "http", retryable: false },
      via: "http",
    });

    const log = readFileSync(eventLogPath, "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0])).toMatchObject({
      from: "m5:volt",
      message: "hello",
      via: "http",
    });
  });

  test("ignores plugins missing the transport hook or non-ts plugins", async () => {
    pluginDir();
    process.env.MAW_TEST_EVENT_HOOK_LOG = eventLogPath;
    discoverPackagesResult = [
      makePlugin("wrong-shape", { hooksOn: undefined, kind: "ts" }),
      makePlugin("wasm", { hooksOn: ["transport:after_send"], kind: "wasm" }),
    ];

    await eventHooks.runPluginEventHooks("transport:after_send", {
      target: { oracle: "oracle" },
      message: "hello",
      from: "local:sender",
      result: { ok: true, via: "http", retryable: false },
      via: "http",
    });

    expect(readFileSync(eventLogPath, "utf8")).toBe("");
  });
});
