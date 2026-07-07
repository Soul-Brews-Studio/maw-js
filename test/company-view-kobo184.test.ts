import { describe, expect, test } from "bun:test";
import { companyHtml, stateBadge } from "../src/views/company";

// kobo-184 — state/lane badge in the card-detail modal header. The badge color
// reuses the board lane tokens (.col-* / .task.st-*) so state reads the same in
// the modal and on the board. Logic lives in the pure stateBadge() map (tested
// directly); the CSS + client wiring are pinned via companyHtml() markers.
describe("stateBadge — pure state → { cls, label } map", () => {
  test("each state maps to its st-<state> class + readable label", () => {
    expect(stateBadge({ state: "backlog" })).toEqual({ cls: "pill state st-backlog", label: "Backlog" });
    expect(stateBadge({ state: "todo" })).toEqual({ cls: "pill state st-todo", label: "Todo" });
    expect(stateBadge({ state: "ready" })).toEqual({ cls: "pill state st-ready", label: "Ready" });
    expect(stateBadge({ state: "in-progress" })).toEqual({ cls: "pill state st-in-progress", label: "In Progress" });
    expect(stateBadge({ state: "review" })).toEqual({ cls: "pill state st-review", label: "Review" });
    expect(stateBadge({ state: "done" })).toEqual({ cls: "pill state st-done", label: "Done" });
    expect(stateBadge({ state: "rejected" })).toEqual({ cls: "pill state st-rejected", label: "Rejected" });
  });

  test("missing state defaults to todo", () => {
    expect(stateBadge({})).toEqual({ cls: "pill state st-todo", label: "Todo" });
  });

  test("unknown state passes through as its own class + label (forward-compat)", () => {
    expect(stateBadge({ state: "archived" })).toEqual({ cls: "pill state st-archived", label: "archived" });
  });

  test("blocked appends for-who when task.block.for is set", () => {
    expect(stateBadge({ state: "blocked", block: { for: "tony" } })).toEqual({ cls: "pill state st-blocked", label: "Blocked →tony" });
  });

  test("blocked with no for stays bare", () => {
    expect(stateBadge({ state: "blocked" })).toEqual({ cls: "pill state st-blocked", label: "Blocked" });
    expect(stateBadge({ state: "blocked", block: {} })).toEqual({ cls: "pill state st-blocked", label: "Blocked" });
  });
});

describe("company board view — kobo-184 state badge wiring", () => {
  const html = companyHtml();

  test("stateBadge is serialized into the client script (renderDetailMeta uses it)", () => {
    expect(html).toContain("function stateBadge");
    expect(html).toContain("stateBadge(task)"); // called in renderDetailMeta
  });

  test("state-badge CSS reuses the lane tokens", () => {
    expect(html).toContain(".pill.state.st-in-progress { color:var(--accent)");
    expect(html).toContain(".pill.state.st-review { color:var(--epic)");
    expect(html).toContain(".pill.state.st-blocked { color:var(--bad)");
    expect(html).toContain(".pill.state.st-done { color:var(--ok)");
  });
});
