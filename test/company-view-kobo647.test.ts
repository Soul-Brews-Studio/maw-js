import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-647 — the dependency-edge warning label said "parent" (⚠ parent ไม่พบ)
// even after kobo-640 renamed the CLI/MCP-facing flag to `needs` — a real
// user-visible drift point, same class as kobo-591 (renderTimeline filter
// parity). Extract the REAL injected `dependencyMissingLabel` and CALL it —
// mutation-provable, not a string-pin (kobo-445's own scar: `toContain` alone
// stays green even if the function is mutated back to the old wording).
describe("company board view — kobo-647 dependency-missing label says needs, not parent", () => {
  const html = companyHtml();

  function extractLabelFn(src: string): (task: unknown) => string | null {
    const start = src.indexOf("function dependencyMissingLabel(task)");
    const end = src.indexOf("function renderDetailMeta(task)");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("extractLabelFn: markers not found — the dependencyMissingLabel()/renderDetailMeta() boundary text changed, update this test's markers");
    }
    const body = src.slice(start, end);
    const factory = new Function(`${body}\nreturn dependencyMissingLabel;`);
    return factory();
  }

  test("the injected dependencyMissingLabel is present in the served HTML", () => {
    expect(html).toContain("function dependencyMissingLabel(task)");
  });

  test("extracted dependencyMissingLabel says 'needs', never 'parent', for a real missing-dep task", () => {
    const label = extractLabelFn(html);
    const text = label({ dependency: { missing: ["kobo-1", "kobo-2"] } });
    expect(text).toContain("needs");
    expect(text).not.toContain("parent");
    expect(text).toContain("kobo-1");
    expect(text).toContain("kobo-2");
  });

  test("no missing deps → null, no pill rendered", () => {
    const label = extractLabelFn(html);
    expect(label({ dependency: { missing: [] } })).toBeNull();
    expect(label({})).toBeNull();
  });

  test("taskCard is wired to CALL dependencyMissingLabel, not a hand-inlined duplicate string", () => {
    const tcStart = html.indexOf("function taskCard(task, opts)");
    const tcEnd = html.indexOf("function questionSubcards");
    expect(tcStart).toBeGreaterThan(-1);
    const taskCardSrc = tcEnd > tcStart ? html.slice(tcStart, tcEnd) : html.slice(tcStart, tcStart + 4000);
    expect(taskCardSrc).toContain("dependencyMissingLabel(task)");
    expect(taskCardSrc).not.toContain("parent ไม่พบ"); // the old inline string must be gone, not just supplemented
  });

  // SCOPE-OUT (per the card + conductor's ruling): the containment plane (epic
  // tooltip in renderDetailMeta / parentRefOf) still says "parent" on purpose —
  // 639's vocabulary table never assigned containment its own word, only the
  // needs/epic LINK NAMES. Changing it here would be a guess. Pin that it's
  // UNCHANGED (still there, not silently touched by this diff), not that it's
  // "fine" — that's eq3's call once 639 gets a containment-word answer.
  test("containment tooltip wording is UNTOUCHED by this card (still says parent — separate plane, no vocabulary answer yet)", () => {
    expect(html).toContain("containment parent");
    expect(html).toContain("parent id not on the board");
  });

  test("client <script> parses as valid browser JS (backtick-trap guard, kobo-588's exact class)", () => {
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
});
