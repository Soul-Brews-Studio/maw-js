import { describe, expect, test } from "bun:test";
import { companyHtml, stateBadge } from "../src/views/company";

// Cell v2: external-wait is a real board lane. It must not fall back to Todo in
// the browser renderer when a card waits on a named external trigger.
describe("company board view — Cell v2 external-wait lane", () => {
  const html = companyHtml();

  test("served HTML contains an external-wait column and counter", () => {
    expect(html).toContain('class="col col-external-wait"');
    expect(html).toContain('id="c-external-wait"');
    expect(html).toContain('id="external-wait"');
  });

  test("client renderer routes external-wait via COLS/counts instead of Todo fallback", () => {
    expect(html).toContain("'external-wait', 'blocked'");
    expect(html).toContain("'external-wait': 0");
    expect(html).toContain("cols[task.state] ? task.state : 'todo'"); // fallback remains, but external-wait is now known
  });

  test("state badge labels external-wait explicitly", () => {
    expect(stateBadge({ state: "external-wait" })).toEqual({ cls: "pill state st-external-wait", label: "External wait" });
  });
});
