/**
 * #1572 — bare-name local-only error formatter.
 *
 * Bare names are accepted only when they resolve to a local tmux window.
 * Misses stay local-only and must not silently fall through to remote peer
 * routing.
 */
import { describe, test, expect } from "bun:test";
import { formatBareNameAmbiguousError, formatBareNameError } from "../src/commands/shared/comm-send";

describe("#1572 — bare-name local-only errors", () => {
  test("error marker, local miss, and cross-node demand are all present", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("error");
    expect(out).toContain("not found locally");
    expect(out).toContain("bare names are local-only");
  });

  test("shows local: form with the user's bare query substituted", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("same-node targets:");
    expect(out).toContain("maw hey local:mawjs-oracle");
  });

  test("shows explicit cross-node placeholder forms", () => {
    const out = formatBareNameError("mawjs-oracle");
    expect(out).toContain("cross-node targets:");
    expect(out).toContain("maw hey <node>:mawjs-oracle");
    expect(out).toContain("maw hey <node>:<session>:<window>");
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
    expect(lines[0]).toBe("error: bare target 'mawjs-oracle' not found locally");
    expect(lines.some(l => l.trim() === "same-node targets:")).toBe(true);
    expect(lines.some(l => l.trim().startsWith("maw hey local:mawjs-oracle"))).toBe(true);
    expect(lines.some(l => l.trim() === "cross-node targets:")).toBe(true);
    expect(lines.some(l => l.trim().startsWith("maw hey <node>:mawjs-oracle"))).toBe(true);
    expect(lines.some(l => l.includes("maw locate mawjs-oracle"))).toBe(true);
  });

  test("ambiguous formatter lists local candidates", () => {
    const out = formatBareNameAmbiguousError("mawjs-oracle", [
      "47-mawjs:mawjs-oracle",
      "54-mawjs:mawjs-oracle",
    ]).replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("ambiguous");
    expect(out).toContain("matches 2 local windows");
    expect(out).toContain("47-mawjs:mawjs-oracle");
    expect(out).toContain("maw hey 47-mawjs:mawjs-oracle");
  });
});
