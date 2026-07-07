import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-127 — the company board is a single-file HTML+CSS+JS template (companyHtml).
// It has no runtime here to unit-test the DOM, so pin the STRUCTURAL markers the
// five Phase-A display features add, so a refactor that drops one is visible.
describe("company board view — kobo-127 board UX Phase A (display)", () => {
  const html = companyHtml();

  test("State tab: state.md moved out of Kanban into its own tab", () => {
    expect(html).toContain('data-tab="state"'); // nav tab + tabpanel
    expect(html).toContain('id="tab-count-state"');
    // the state panel now lives in the state tabpanel, not below the board
    expect(html).toContain('id="state-panel"');
    expect(html).toMatch(/data-tab="state"[^]*id="state-panel"/); // panel is inside the state section
  });

  test("assignee chip: full-name colored chip with click-to-filter", () => {
    expect(html).toContain("function assigneeChip");
    expect(html).toContain("assignee-chip");
    expect(html).toContain("setAssigneeFilter"); // click handler
    expect(html).toContain('id="assignee-bar"'); // the active-filter clear bar
  });

  test("collapse: 1-line title clamp + latest-note-faint / full-notes on Blocked (kobo-199 grid col)", () => {
    expect(html).toContain("t-note-latest"); // flow-lane cards → latest note only
    expect(html).toContain("t-notes-full"); // Blocked column → every note in full (decision queue)
    expect(html).toContain("{ notes: 'full' }"); // the Blocked branch passes the flag
    expect(html).toContain("text-overflow:ellipsis; white-space:nowrap"); // title clamp
  });

  test("Done lane fold: newest 5 + show-all toggle", () => {
    expect(html).toContain("function renderDoneLane");
    expect(html).toContain("done-fold");
    expect(html).toContain("show all ");
    expect(html).toContain("doneExpanded");
  });

  test("epic rollup counts DIRECT children only (verified, not deep)", () => {
    // childrenOf is keyed on the direct epic parent → rollupOf counts direct kids
    expect(html).toContain("taskIndex.childrenOf.get(task.id)");
  });
});
