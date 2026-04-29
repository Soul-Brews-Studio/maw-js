/**
 * send — argument parser tests (#757).
 */

import { test, expect } from "bun:test";
import { parseSendArgs } from "./impl";

test("parseSendArgs: target + single-word text", () => {
  const opts = parseSendArgs(["mba:sloworacle", "echo"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.text).toBe("echo");
});

test("parseSendArgs: target + multi-word text joined with spaces", () => {
  const opts = parseSendArgs(["mba:sloworacle", "echo", "hello", "world"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.text).toBe("echo hello world");
});

test("parseSendArgs: text with shell metacharacters preserved", () => {
  const opts = parseSendArgs(["local:bash-pane", "ls", "|", "grep", "foo"]);
  expect(opts.text).toBe("ls | grep foo");
});

test("parseSendArgs: missing target throws", () => {
  expect(() => parseSendArgs([])).toThrow(/usage/);
});

test("parseSendArgs: missing text throws", () => {
  expect(() => parseSendArgs(["mba:sloworacle"])).toThrow(/text is required/);
});

test("parseSendArgs: cross-node target accepted", () => {
  const opts = parseSendArgs(["clinic:01-mawjs", "make", "test"]);
  expect(opts.target).toBe("clinic:01-mawjs");
  expect(opts.text).toBe("make test");
});

test("parseSendArgs: pane-specific target accepted", () => {
  const opts = parseSendArgs(["session:1.2", "exit"]);
  expect(opts.target).toBe("session:1.2");
  expect(opts.text).toBe("exit");
});
