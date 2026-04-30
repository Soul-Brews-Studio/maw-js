import { expect, test } from "bun:test";
import type { MawConfig } from "../../../config";
import { parseHeyGaleArgs, resolveGaleTarget } from "./impl";

const baseConfig: MawConfig = {
  host: "local",
  port: 3456,
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: {},
  sessions: {},
  node: "sky",
};

test("parseHeyGaleArgs: message only", () => {
  const opts = parseHeyGaleArgs(["hello", "gale"]);
  expect(opts).toEqual({ message: "hello gale", wait: false });
});

test("parseHeyGaleArgs: strips --wait from message", () => {
  const opts = parseHeyGaleArgs(["hello", "--wait", "gale"]);
  expect(opts).toEqual({ message: "hello gale", wait: true });
});

test("parseHeyGaleArgs: -- preserves flag-looking message text", () => {
  const opts = parseHeyGaleArgs(["--", "--wait"]);
  expect(opts).toEqual({ message: "--wait", wait: false });
});

test("parseHeyGaleArgs: missing message throws", () => {
  expect(() => parseHeyGaleArgs([])).toThrow(/usage/);
  expect(() => parseHeyGaleArgs(["--wait"])).toThrow(/usage/);
});

test("resolveGaleTarget: uses configured gale agent node", () => {
  expect(resolveGaleTarget({ ...baseConfig, agents: { gale: "wind" } })).toBe("wind:gale");
});

test("resolveGaleTarget: normalizes local gale agent through config node", () => {
  expect(resolveGaleTarget({ ...baseConfig, agents: { gale: "local" } })).toBe("sky:gale");
});

test("resolveGaleTarget: local configured gale session uses config node", () => {
  expect(resolveGaleTarget({ ...baseConfig, sessions: { gale: "session-id" } })).toBe("sky:gale");
});

test("resolveGaleTarget: defaults to wind:gale", () => {
  expect(resolveGaleTarget(baseConfig)).toBe("wind:gale");
});
