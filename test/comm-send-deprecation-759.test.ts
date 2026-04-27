/**
 * #759 Phase 1 — bare-name deprecation warning emitted by `maw hey`.
 *
 * The formatter is tested directly (pure function). The behavior wiring
 * inside cmdSend (gating on `!query.includes(":")`, MAW_QUIET, config.node)
 * is verified by inspecting the cmdSend source, since the full async path
 * pulls in tmux + sessions + sdk and is covered by isolated tests already.
 */
import { describe, test, expect } from "bun:test";
import { formatBareNameDeprecation } from "../src/commands/shared/comm-send";

describe("#759 — bare-name deprecation warning", () => {
  test("warning marker, query, and canonical suggestion are all present", () => {
    const out = formatBareNameDeprecation("white", "mawjs-oracle");
    expect(out).toContain("deprecation");
    expect(out).toContain("#759");
    expect(out).toContain("'mawjs-oracle'");
    // Canonical suggestion line uses the configured node, not "local"
    expect(out).toContain("maw hey white:mawjs-oracle");
  });

  test("references `maw locate <agent>` for cross-node enumeration", () => {
    const out = formatBareNameDeprecation("white", "mawjs-oracle");
    expect(out).toContain("maw locate mawjs-oracle");
  });

  test("query is interpolated literally — no shell mangling", () => {
    // Defense in depth: the formatter is purely string-building. If this ever
    // gets wired through a shell, the test fails loudly so we know to escape.
    const out = formatBareNameDeprecation("oracle-world", "weird name with spaces");
    expect(out).toContain("'weird name with spaces'");
    expect(out).toContain("maw hey oracle-world:weird name with spaces");
  });

  test("output is multi-line and matches the issue suggestion shape", () => {
    const out = formatBareNameDeprecation("white", "mawjs-oracle");
    // Strip ANSI for shape assertions — color codes don't matter here.
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = stripped.split("\n");
    expect(lines.some(l => l.includes("this node:"))).toBe(true);
    expect(lines.some(l => l.trim().startsWith("maw hey white:mawjs-oracle"))).toBe(true);
  });
});
