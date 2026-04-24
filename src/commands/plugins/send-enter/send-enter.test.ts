/**
 * send-enter — argument parser tests (#728).
 */

import { test, expect } from "bun:test";
import { parseSendEnterArgs } from "./impl";

test("parseSendEnterArgs: positional target only", () => {
  const opts = parseSendEnterArgs(["mba:sloworacle"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.count).toBe(1);
});

test("parseSendEnterArgs: target then --N", () => {
  const opts = parseSendEnterArgs(["mba:sloworacle", "--N", "3"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.count).toBe(3);
});

test("parseSendEnterArgs: --N then target", () => {
  const opts = parseSendEnterArgs(["--N", "5", "mba:sloworacle"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.count).toBe(5);
});

test("parseSendEnterArgs: --N=N inline form", () => {
  const opts = parseSendEnterArgs(["mba:sloworacle", "--N=4"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.count).toBe(4);
});

test("parseSendEnterArgs: lowercase --n", () => {
  const opts = parseSendEnterArgs(["mba:sloworacle", "--n", "2"]);
  expect(opts.target).toBe("mba:sloworacle");
  expect(opts.count).toBe(2);
});

test("parseSendEnterArgs: missing target throws", () => {
  expect(() => parseSendEnterArgs([])).toThrow(/usage/);
  expect(() => parseSendEnterArgs(["--N", "3"])).toThrow(/usage/);
});

test("parseSendEnterArgs: invalid --N value throws", () => {
  expect(() => parseSendEnterArgs(["target", "--N", "foo"])).toThrow(/positive integer/);
  expect(() => parseSendEnterArgs(["target", "--N", "0"])).toThrow(/positive integer/);
  expect(() => parseSendEnterArgs(["target", "--N", "-1"])).toThrow(/positive integer/);
});

test("parseSendEnterArgs: --N missing value throws", () => {
  expect(() => parseSendEnterArgs(["target", "--N"])).toThrow();
});
