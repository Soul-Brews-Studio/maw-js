import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const { archiveToTmp, surfaces, shortenHome, printTable } = await import("../src/commands/shared/plugins-ui");

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()!;
    rmSync(path, { recursive: true, force: true });
  }
});

function plugin(overrides: Record<string, unknown>) {
  const { manifest, ...rest } = overrides;
  return {
    kind: "ts",
    dir: "/tmp/demo",
    entryPath: "/tmp/demo/index.ts",
    wasmPath: "",
    ...rest,
    manifest: {
      name: "demo",
      version: "1.0.0",
      sdk: "^1.0.0",
      ...((manifest as Record<string, unknown>) ?? {}),
    },
  } as never;
}

function captureLogs(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("plugins UI helpers", () => {
  test("surfaces lists explicit CLI, default TS/WASM CLI, API, and empty plugins", () => {
    expect(surfaces(plugin({ manifest: { cli: { command: "demo" } } }))).toBe("cli:demo");
    expect(surfaces(plugin({ manifest: { api: { path: "/api/demo", methods: ["GET"] } } }))).toBe("cli:demo, api:/api/demo");
    expect(surfaces(plugin({ kind: "wasm", entryPath: undefined, wasmPath: "/tmp/demo/demo.wasm" }))).toBe("cli:demo");
    expect(surfaces(plugin({ entryPath: undefined, wasmPath: "" }))).toBe("—");
  });

  test("shortenHome replaces the homedir prefix only", () => {
    expect(shortenHome(join(homedir(), "Code", "repo"))).toBe(join("~", "Code", "repo"));
    expect(shortenHome("/opt/Code/repo")).toBe("/opt/Code/repo");
  });

  test("printTable pads headers and rows based on widest cell", () => {
    const lines = captureLogs(() => printTable(["name", "v"], [["alpha", "1"], ["b", "22"]]));

    expect(lines).toEqual([
      "name   v ",
      "─────  ──",
      "alpha  1 ",
      "b      22",
    ]);
  });

  test("archiveToTmp renames plugin directories to a timestamped /tmp path", () => {
    const source = mkdtempSync(join(tmpdir(), "maw-plugin-source-"));
    const name = `ui-${process.pid}`;
    const dest = `/tmp/maw-plugin-${name}-1700000000000`;
    rmSync(dest, { recursive: true, force: true });
    cleanupPaths.push(dest);

    const originalNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      archiveToTmp(name, source);
    } finally {
      Date.now = originalNow;
    }

    expect(existsSync(source)).toBe(false);
    expect(existsSync(dest)).toBe(true);
  });
});
