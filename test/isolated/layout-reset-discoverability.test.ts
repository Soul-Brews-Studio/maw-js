import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { invokeDirectHandler } from "../../src/cli/top-aliases";

const OLD_TEST_MODE = process.env.MAW_TEST_MODE;

let logs: string[] = [];
let errors: string[] = [];
let layoutCalls: Array<[string, string]> = [];

beforeEach(() => {
  process.env.MAW_TEST_MODE = "1";
  logs = [];
  errors = [];
  layoutCalls = [];
});

afterEach(() => {
  if (OLD_TEST_MODE === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = OLD_TEST_MODE;
});

const deps = () => ({
  cmdTmuxLayout: async (target: string, preset: string) => {
    layoutCalls.push([target, preset]);
  },
  log: (line: string) => logs.push(line),
  error: (line: string) => errors.push(line),
});

describe("maw layout reset discoverability (#1966)", () => {
  test("layout reset aliases to main-vertical on the current window", async () => {
    await invokeDirectHandler("cmdLayout", ["reset"], deps());

    expect(layoutCalls).toEqual([[".", "main-vertical"]]);
    expect(errors).toEqual([]);
  });

  test("layout help points users to reset and tile swap", async () => {
    await invokeDirectHandler("cmdLayout", ["--help"], deps());

    const help = logs.join("\n");
    expect(help).toContain("alias: reset → main-vertical");
    expect(help).toContain("maw tile swap <a> <b>");
    expect(layoutCalls).toEqual([]);
  });
});
