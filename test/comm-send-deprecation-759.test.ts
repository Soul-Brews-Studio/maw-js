/**
 * #759 Phase 2 — bare-name hard rejection error formatter.
 *
 * The Phase 1 deprecation warning has been converted into a hard error. The
 * formatter is tested directly (pure function). The cmdSend wiring (early
 * exit, gating on `!query.includes(":")`) is covered by the isolated test
 * `test/isolated/hey-bare-name-rejection.test.ts`.
 *
 * History: this file used to assert `formatBareNameDeprecation` — Phase 2
 * renamed the export to `formatBareNameError` and changed the shape from
 * yellow `⚠ deprecation` to red `error:`. See issue #759.
 */
import { describe, test, expect } from "bun:test";
import { formatBareNameError } from "../src/commands/shared/comm-send";

describe("#759 Phase 2 — bare-name hard rejection", () => {
  test("error marker, removal phrase, and node-prefix demand are all present", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("error");
    expect(out).toContain("bare-name target removed");
    expect(out).toContain("node prefix required");
  });

  test("shows local: form with the user's bare query substituted", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("this node:");
    expect(out).toContain("maw hey local:mawjs-oracle");
  });

  test("shows cross-node placeholder form with <node>:<session>: literal", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("cross-node candidates:");
    // <node> and <session> stay as literal placeholders — the user runs
    // `maw locate` to enumerate concrete candidates. Only <agent> substitutes.
    expect(out).toContain("maw hey <node>:<session>:mawjs-oracle");
  });

  test("references `maw locate <agent>` for federation enumeration", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("maw locate mawjs-oracle");
  });

  test("query is interpolated literally — no shell mangling", () => {
    // Defense in depth: the formatter is purely string-building. If this ever
    // gets wired through a shell, the test fails loudly so we know to escape.
    const out = formatBareNameError("weird name with spaces");
    expect(out).toContain("local:weird name with spaces");
    expect(out).toContain("maw locate weird name with spaces");
  });

  test("output shape (ANSI-stripped) matches the issue example", () => {
    const out = formatBareNameError("mawjs-oracle");
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = stripped.split("\n");
    // First line is the error header
    expect(lines[0]).toBe("error: bare-name target removed — node prefix required");
    expect(lines.some(l => l.trim() === "this node:")).toBe(true);
    expect(lines.some(l => l.trim().startsWith("maw hey local:mawjs-oracle"))).toBe(true);
    expect(lines.some(l => l.trim() === "cross-node candidates:")).toBe(true);
    expect(lines.some(l => l.trim().startsWith("maw hey <node>:<session>:mawjs-oracle"))).toBe(true);
    expect(lines.some(l => l.includes("maw locate mawjs-oracle"))).toBe(true);
  });
});
