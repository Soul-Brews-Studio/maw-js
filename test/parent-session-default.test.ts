import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  prefixCommandWithSpawnSessionEnv,
  resolveParentSessionId,
  spawnSessionEnv,
} from "../src/core/fleet/parent-session";

const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `maw-parent-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

import { resolve } from "path";

function encodeProjectPath(path: string): string {
  const absolute = resolve(path).replace(/\\/g, "/");
  const withDriveMarker = absolute.replace(/^([A-Za-z]):\//, "/$1--");
  return withDriveMarker.replace(/^\//, "-").replace(/\//g, "-");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parent session resolution", () => {
  test("prefers explicit parent over inherited session env", () => {
    expect(resolveParentSessionId({
      explicit: "parent-explicit",
      env: { CLAUDE_SESSION_ID: "claude-current" } as NodeJS.ProcessEnv,
      cwd: "/tmp/unused",
    })).toBe("parent-explicit");
  });

  test("falls back through Claude session env before project jsonl scan", () => {
    expect(resolveParentSessionId({
      env: { CLAUDE_SESSION_ID: "claude-current" } as NodeJS.ProcessEnv,
      cwd: "/tmp/unused",
    })).toBe("claude-current");
  });

  test("uses newest Claude project jsonl when env does not identify the caller", () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const projects = join(root, "projects");
    const projectDir = join(projects, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const older = join(projectDir, "older.jsonl");
    const newer = join(projectDir, "newer.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    utimesSync(older, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    utimesSync(newer, new Date(), new Date());
    writeFileSync(join(projectDir, "newest-subagents.jsonl"), "{}\n");

    expect(resolveParentSessionId({
      cwd,
      env: { MAW_CLAUDE_PROJECTS_DIR: projects } as NodeJS.ProcessEnv,
    })).toBe("newer");
  });

  test("builds spawn env and shell prefix without empty values", () => {
    expect(spawnSessionEnv({
      explicit: "parent-1",
      sessionId: "child-1",
      env: {} as NodeJS.ProcessEnv,
    })).toEqual({
      MAW_PARENT_SESSION_ID: "parent-1",
      MAW_SESSION_ID: "child-1",
    });
    expect(prefixCommandWithSpawnSessionEnv("claude", {
      explicit: "parent 1",
      sessionId: "child'1",
      env: {} as NodeJS.ProcessEnv,
    })).toBe("MAW_PARENT_SESSION_ID='parent 1' MAW_SESSION_ID='child'\\''1' claude");
  });
});
