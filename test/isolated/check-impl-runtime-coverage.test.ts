import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SpawnResult = { stdout?: string; stderr?: string; status?: number; error?: Error };
let spawnCalls: Array<{ command: string; args: string[] }> = [];
let spawnResults: Record<string, SpawnResult> = {};
let logs: string[] = [];
const originalLog = console.log;

mock.module("child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const result = spawnResults[key] ?? { stdout: `${command} 1.2.3\n`, stderr: "", status: 0 };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
      error: result.error,
    };
  },
}));

mock.module("maw-js/core/util/terminal", () => ({
  tlink: (url: string) => `<${url}>`,
}));

const { TOOLS, checkTool, cmdCheck } = await import("../../src/vendor/mpr-plugins/check/impl");

function output(): string {
  return logs.join("\n");
}

beforeEach(() => {
  spawnCalls = [];
  spawnResults = {};
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

describe("vendor check impl runtime coverage", () => {
  test("declares required and optional tool metadata", () => {
    expect(TOOLS.map(t => t.name)).toEqual(["bun", "gh", "ghq", "git", "tmux", "uv", "uvx"]);
    expect(TOOLS.filter(t => t.required).map(t => t.name)).toEqual(["bun", "gh", "ghq", "git", "tmux"]);
    expect(TOOLS.find(t => t.name === "uvx")?.notes).toBe("provided by uv");
  });

  test("checkTool uses tmux -V, generic --version, absent errors, and uvx via which plus uv version", () => {
    spawnResults["tmux -V"] = { stdout: "tmux 3.4\n", status: 0 };
    spawnResults["git --version"] = { stdout: "git version 2.51.0\n", status: 0 };
    spawnResults["gh --version"] = { error: new Error("ENOENT"), status: 1 };
    spawnResults["which uvx"] = { stdout: "/usr/bin/uvx\n", status: 0 };
    spawnResults["uv --version"] = { stderr: "uv 0.7.2\n", status: 0 };
    spawnResults["which missing"] = { status: 1 };

    expect(checkTool("tmux")).toEqual({ present: true, version: "3.4" });
    expect(checkTool("git")).toEqual({ present: true, version: "2.51.0" });
    expect(checkTool("gh")).toEqual({ present: false });
    expect(checkTool("uvx")).toEqual({ present: true, version: "0.7.2" });
    expect(checkTool("missing")).toEqual({ present: true, version: "1.2.3" });
    expect(spawnCalls).toContainEqual({ command: "tmux", args: ["-V"] });
    expect(spawnCalls).toContainEqual({ command: "git", args: ["--version"] });
  });

  test("checkTool reports uvx absent when which fails", () => {
    spawnResults["which uvx"] = { status: 1 };

    expect(checkTool("uvx")).toEqual({ present: false });
  });

  test("cmdCheck prints usage for unknown subcommands", () => {
    cmdCheck("status", []);

    expect(output()).toContain("unknown subcommand: status");
    expect(output()).toContain("usage: maw check [tools]");
    expect(spawnCalls).toEqual([]);
  });

  test("cmdCheck renders present and missing tools with install links and summary", () => {
    for (const tool of ["bun", "gh", "ghq", "git", "tmux", "uv"]) {
      spawnResults[`${tool} ${tool === "tmux" ? "-V" : "--version"}`] = { stdout: `${tool} 9.8.7\n`, status: 0 };
    }
    spawnResults["which uvx"] = { status: 1 };

    cmdCheck("tools", []);

    const rendered = output();
    expect(rendered).toContain("maw check tools");
    expect(rendered).toContain("Required:");
    expect(rendered).toContain("Optional (Python plugins):");
    expect(rendered).toContain("bun");
    expect(rendered).toContain("9.8.7");
    expect(rendered).toContain("uvx");
    expect(rendered).toContain("<https://docs.astral.sh/uv/>");
    expect(rendered).toContain("5 required");
    expect(rendered).toContain("1 optional");
    expect(rendered).toContain("1 missing");
  });
});
