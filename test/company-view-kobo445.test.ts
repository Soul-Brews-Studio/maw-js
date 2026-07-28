import { describe, expect, test } from "bun:test";
import { companyStatusHtml } from "../src/views/company-status";

// kobo-445 review round 2 (kobo-527's own scar, %8): a test that only asserts
// "the source contains this line" stays green even if the BEHAVIOR is destroyed —
// %8 proved it by mutating `load()` to append `loadInFlight = false;` right after
// `loadInFlight = true;` (both original lines untouched, byte-for-byte) and the
// old string-pin test still passed with 0 fail. Extract the real `load` function
// out of the served string via `new Function` (reviewer's suggested approach),
// stub `getJson` to hang forever, call load() twice back-to-back (synchronously,
// so the second call's guard check runs before the first call's first `await`
// suspends it), and assert getJson was only invoked by the FIRST call.
function extractLoad(html: string) {
  const start = html.indexOf("let loadInFlight = false;");
  const end = html.indexOf("function render(roster, held, pending, presence, worklog) {");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("extractLoad: markers not found — company-status.ts's load()/render() boundary text changed, update this test's markers");
  }
  const src = html.slice(start, end);
  const factory = new Function("document", "window", "companyInput", "gridEl", "statusEl", "getJson", `${src}\nreturn load;`);
  return factory;
}

// kobo-445 — Tony's own explicit constraint: the company-status page is READ-ONLY,
// no command buttons at all (a second card covers write actions later). Pin it so a
// future edit that adds a POST/PUT/DELETE fetch here can't slip past review. The
// board is a single-file HTML+JS template (no runtime here) — same string-pin
// approach as kobo-198/kobo-263 (no jsdom in repo).
describe("company-status view — kobo-445 read-only gate", () => {
  const html = companyStatusHtml();

  test("no POST/PUT/DELETE anywhere in the served page", () => {
    expect(html).not.toMatch(/method\s*:\s*['"](POST|PUT|DELETE)['"]/i);
    expect(html).not.toMatch(/\.method\s*=\s*['"](POST|PUT|DELETE)['"]/i);
  });

  test("only fetch()es GET endpoints — no postJson/write helper exists on this page", () => {
    // every getJson(...) call target a GET-only read route; postJson doesn't exist here at all
    expect(html).not.toContain("postJson");
    expect(html).toContain("getJson('/api/roster?company=");
    expect(html).toContain("getJson('/api/presence?company=");
    expect(html).toContain("getJson('/api/worklog/feed?company=");
    // kobo-445 review round 1: /api/tasks dropped entirely — /api/roster's `pending`
    // field replaced it instead of a second 848KB/532-file scan (measured once by
    // the author, 32554 bytes on a real company — not independently re-verified).
    expect(html).not.toContain("/api/tasks");
  });

  test("missing data renders an explicit no-data message, never a fabricated 0/empty-looking value", () => {
    expect(html).toContain("pct == null ? 'ctx —'"); // no presence sample → em-dash, not "ctx 0%"
    expect(html).toContain("'no live pane'"); // no panes for this oracle → says so
    expect(html).toContain("'nothing pending'"); // no pending cards → says so
    expect(html).toContain("'no recent activity'"); // no worklog entries → says so
    expect(html).toContain("'no roster members'"); // empty roster → says so
  });

  test("pending list has no client-side done/rejected filter — the server (pendingTasksByOracle) already excludes terminal states, so a closed card is simply absent", () => {
    // if this ever reads `pending[member.oracle]` through an extra done/rejected check,
    // that's a second, driftable copy of the filter — it should stay server-only.
    expect(html).not.toMatch(/state\s*===\s*['"]done['"]/);
    expect(html).not.toMatch(/state\s*===\s*['"]rejected['"]/);
    expect(html).toContain("const oraclePending = pending[member.oracle] || [];");
  });

  test("polling never overlaps a still-in-flight request (behavioral, not a string-pin)", async () => {
    const factory = extractLoad(html);
    let getJsonCalls = 0;
    const pending: Array<(v: unknown) => void> = [];
    const getJson = (_url: string) => {
      getJsonCalls++;
      return new Promise((resolve) => pending.push(resolve as (v: unknown) => void)); // hangs until released below
    };
    const load = factory(
      { hidden: false },
      { location: { href: "http://x/company-status?company=kobo" }, history: { replaceState: () => {} } },
      { value: "kobo" },
      { replaceChildren: () => {} },
      { textContent: "", className: "" },
      getJson,
    );

    const first = load(); // runs synchronously up to its `await Promise.all(...)`, sets loadInFlight = true, then suspends
    const second = load(); // must see loadInFlight already true and return immediately WITHOUT calling getJson again
    expect(getJsonCalls).toBe(3); // exactly one load()'s worth of fetches (roster/presence/worklog) — not 6

    pending.forEach((resolve) => resolve({})); // release the hung getJson calls so `first` can finish (avoid an unresolved-promise leak)
    await Promise.all([first, second]);
  });

  test("skips polling entirely while the tab is hidden (document.hidden)", async () => {
    const factory = extractLoad(html);
    let getJsonCalls = 0;
    const getJson = (_url: string) => { getJsonCalls++; return new Promise(() => {}); };
    const load = factory(
      { hidden: true }, // backgrounded tab
      { location: { href: "http://x/company-status?company=kobo" }, history: { replaceState: () => {} } },
      { value: "kobo" },
      { replaceChildren: () => {} },
      { textContent: "", className: "" },
      getJson,
    );

    await load();
    expect(getJsonCalls).toBe(0);
  });
});
