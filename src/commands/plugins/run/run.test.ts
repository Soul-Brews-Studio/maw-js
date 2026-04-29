/**
 * run — argument parser tests (#757).
 */

import { test, expect } from "bun:test";
import { parseRunArgs } from "./impl";

test("parseRunArgs: target + single-word cmd", () => {
  const opts = parseRunArgs(["bash-pane", "ls"]);
  expect(opts.target).toBe("bash-pane");
  expect(opts.text).toBe("ls");
});

test("parseRunArgs: target + multi-word cmd", () => {
  const opts = parseRunArgs(["bash-pane", "ls", "-la", "/tmp"]);
  expect(opts.target).toBe("bash-pane");
  expect(opts.text).toBe("ls -la /tmp");
});

test("parseRunArgs: empty cmd allowed (bare Enter)", () => {
  const opts = parseRunArgs(["bash-pane"]);
  expect(opts.target).toBe("bash-pane");
  expect(opts.text).toBe("");
});

test("parseRunArgs: shell metacharacters preserved", () => {
  const opts = parseRunArgs(["local:bash-pane", "echo", "hi", "&&", "ls"]);
  expect(opts.text).toBe("echo hi && ls");
});

test("parseRunArgs: missing target throws", () => {
  expect(() => parseRunArgs([])).toThrow(/usage/);
});

test("parseRunArgs: cross-node target accepted", () => {
  const opts = parseRunArgs(["clinic:01-mawjs", "make", "test"]);
  expect(opts.target).toBe("clinic:01-mawjs");
  expect(opts.text).toBe("make test");
});

test("parseRunArgs: pane-specific target accepted", () => {
  const opts = parseRunArgs(["session:1.2", "exit"]);
  expect(opts.target).toBe("session:1.2");
  expect(opts.text).toBe("exit");
});
