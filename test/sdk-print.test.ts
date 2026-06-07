import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { print } from "../src/core/runtime/sdk-print";

let originalLog: typeof console.log;
let lines: string[];

beforeEach(() => {
  originalLog = console.log;
  lines = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
});

afterEach(() => {
  console.log = originalLog;
});

describe("SDK print helpers", () => {
  test("renders colored single-line helpers", () => {
    print.header("Section");
    print.ok("done");
    print.warn("careful");
    print.err("broken");
    print.dim("quiet");
    print.kv("key", "value");
    print.nl();

    expect(lines).toEqual([
      "\n  \x1b[36mSection\x1b[0m\n",
      "  \x1b[32m✓\x1b[0m done",
      "  \x1b[33m⚠\x1b[0m careful",
      "  \x1b[31m✗\x1b[0m broken",
      "  \x1b[90mquiet\x1b[0m",
      "  \x1b[90mkey:\x1b[0m value",
      "",
    ]);
  });

  test("renders lists with default and custom markers", () => {
    print.list(["alpha", "beta"]);
    print.list(["warn"], "•", "\x1b[33m");

    expect(lines).toEqual([
      "    \x1b[32m●\x1b[0m alpha",
      "    \x1b[32m●\x1b[0m beta",
      "    \x1b[33m•\x1b[0m warn",
    ]);
  });

  test("renders aligned tables with and without headers", () => {
    print.table([
      ["a", "longer"],
      ["bbb", "x"],
    ], ["Key", "Value"]);
    print.table([["solo", "row"]]);

    expect(lines).toEqual([
      "  Key  Value ",
      "  ───  ──────",
      "  a    longer",
      "  bbb  x     ",
      "  solo  row",
    ]);
  });
});
