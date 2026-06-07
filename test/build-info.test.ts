import { describe, expect, mock, test } from "bun:test";
import * as realChild from "child_process";

let mode: "success" | "throw" = "success";
const execCalls: string[] = [];

mock.module("child_process", () => ({
  ...realChild,
  execSync: (cmd: string, opts?: unknown) => {
    execCalls.push(`${cmd} cwd=${(opts as { cwd?: string } | undefined)?.cwd ?? ""}`);
    if (mode === "throw") throw new Error("git unavailable");
    if (cmd === "git rev-parse --short HEAD") return Buffer.from("abc1234\n");
    if (cmd === "git log -1 --format=%ci") return Buffer.from("2026-05-17 07:31:00 +0700\n");
    return realChild.execSync(cmd, opts as never);
  },
}));

async function importBuildInfo(label: string) {
  return import(`${process.cwd()}/src/core/runtime/build-info.ts?coverage=${label}-${Date.now()}-${Math.random()}`);
}

describe("getRuntimeVersionString", () => {
  test("renders version, git hash, build date, and caches the string", async () => {
    mode = "success";
    execCalls.length = 0;
    const { getRuntimeVersionString } = await importBuildInfo("success");

    const first = getRuntimeVersionString();
    const second = getRuntimeVersionString();

    expect(first).toBe(second);
    expect(first).toContain("maw v");
    expect(first).toContain("(abc1234)");
    expect(first).toContain("built 2026-05-17 Sun 07:31");
    expect(execCalls).toEqual([
      expect.stringContaining("git rev-parse --short HEAD cwd="),
      expect.stringContaining("git log -1 --format=%ci cwd="),
    ]);
  });

  test("falls back to package version when git metadata is unavailable", async () => {
    mode = "throw";
    execCalls.length = 0;
    const { getRuntimeVersionString } = await importBuildInfo("throw");

    const value = getRuntimeVersionString();

    expect(value).toMatch(/^maw v\d+\.\d+\.\d+/);
    expect(value).not.toContain("(");
    expect(value).not.toContain(" built ");
    expect(execCalls).toHaveLength(2);
  });
});
