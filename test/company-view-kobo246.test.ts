import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-246 (terminal gate) → kobo-255 (render reads state). A dep-pending card used to
// keep its flow state and get a DERIVED "🚫 รอ" pill + Blocked-lane placement overlaid
// on top (so it looked like it held two lanes). slice-A makes a dep-pending card really
// state="blocked", so the render now gates the pill + lane on the REAL state — no derived
// overlay-on-other-state. The kobo-246 terminal-gate OUTCOME is preserved for free:
// state="blocked" is never a terminal state, so done/rejected/archived never show it.
// The board is a single-file HTML+JS template (no runtime here), so pin the structural
// markers of the display gate a refactor must not silently drop.
describe("company board view — kobo-255 dep-block label gated on real blocked state", () => {
  const html = companyHtml();

  test("the 🚫 dep-block pill renders ONLY on a blocked-state card (no overlay on review/in-progress)", () => {
    expect(html).toContain("if (task.state === 'blocked' && task.dependency && task.dependency.blockedBy.length)");
  });

  test("lane placement gates the Blocked lane on the real state, not a derived dep-block", () => {
    expect(html).toContain("task.state === 'blocked' || task.needsOwner");
    // the derived overlay term is gone — a card is off-flow by its own state, not by deriving it
    expect(html).not.toContain("!isTerminal(task.state) && task.dependency && task.dependency.blockedBy.length > 0");
  });

  test("terminal-gate outcome preserved: the removed client isTerminal helper is no longer needed", () => {
    // kobo-246 needed a browser isTerminal() to gate the pill; state-driving subsumes it
    // (blocked ≠ terminal), so the dead helper is dropped.
    expect(html).not.toContain("function isTerminal(state)");
  });
});
