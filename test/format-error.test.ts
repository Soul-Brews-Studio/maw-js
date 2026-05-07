// #1114 — formatError shape + hint formatting.
import { describe, expect, test } from "bun:test";
import { formatError } from "../src/lib/format-error";

describe("formatError (#1114)", () => {
  test("renders red 'error:' prefix without hint", () => {
    const out = formatError("something broke");
    expect(out).toBe("\x1b[31merror\x1b[0m: something broke");
  });

  test("appends dim hint line when provided", () => {
    const out = formatError("session not found", "run 'maw ls'");
    expect(out).toBe(
      "\x1b[31merror\x1b[0m: session not found\n\x1b[90m  hint: run 'maw ls'\x1b[0m",
    );
  });

  test("hint is omitted when undefined", () => {
    const out = formatError("oops", undefined);
    expect(out.includes("hint:")).toBe(false);
    expect(out.includes("\n")).toBe(false);
  });

  test("preserves message verbatim (no trimming, no extra punctuation)", () => {
    const msg = "  spaced  message  ";
    const out = formatError(msg);
    expect(out).toBe(`\x1b[31merror\x1b[0m: ${msg}`);
  });

  test("ANSI reset closes color spans for both lines", () => {
    const out = formatError("a", "b");
    // Each opener has a matching reset.
    const opens = (out.match(/\x1b\[(31|90)m/g) || []).length;
    const closes = (out.match(/\x1b\[0m/g) || []).length;
    expect(opens).toBe(closes);
  });
});
