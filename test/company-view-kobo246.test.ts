import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-246 — a done/terminal card whose parent is still pending was showing the
// derived "🚫 รอ" dep-block pill AND getting pulled into the Blocked lane, because the
// render consumed dependencyBlock() without gating on the card's own terminal state.
// The board is a single-file HTML+JS template (no runtime here), so pin the structural
// markers of the display gate a refactor must not silently drop.
describe("company board view — kobo-246 dep-block terminal gate", () => {
  const html = companyHtml();

  test("a shared browser isTerminal helper exists (mirrors core TERMINAL_STATES)", () => {
    expect(html).toContain("function isTerminal(state)");
    expect(html).toContain("state === 'done' || state === 'rejected' || state === 'archived'");
  });

  test("the 🚫 dep-block pill is gated on !isTerminal (a done card no longer shows it)", () => {
    expect(html).toContain("if (!isTerminal(task.state) && task.dependency && task.dependency.blockedBy.length)");
  });

  test("lane placement gates the derived dep-block on !isTerminal (terminal card stays in its lane)", () => {
    expect(html).toContain("(!isTerminal(task.state) && task.dependency && task.dependency.blockedBy.length > 0)");
  });
});
