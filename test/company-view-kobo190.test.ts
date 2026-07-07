import { describe, expect, test } from "bun:test";
import { companyHtml } from "../src/views/company";

// kobo-190 — card-detail #detail-approve block: an approve-only decision summary
// (merge PR#N → repo + link-out) + a MARK-ONLY [✅ Approve] button. The block is
// client-side (inside the serialized <script>), so it can't be import-unit-tested
// directly; instead we pin the behavior contract via markers on the REAL companyHtml()
// output and prove the whole client script is valid browser JS (new Function parse —
// the exact backtick-in-template trap that broke kobo-194).
// ponytail: DOM-render behavior (approve renders / non-approve hides) is asserted by
//   markers, not a live jsdom run — this repo has no DOM harness. Add a happy-dom
//   render test if the block grows real branching.
describe("company board view — kobo-190 approve block wiring", () => {
  const html = companyHtml();

  test("approve block DOM slot sits between #detail-meta and #detail-deps", () => {
    const meta = html.indexOf('<div id="detail-meta">');
    const approve = html.indexOf('<div id="detail-approve" hidden>');
    const deps = html.indexOf('<div id="detail-deps" hidden>');
    expect(meta).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(meta);
    expect(deps).toBeGreaterThan(approve);
  });

  test("renderDetailApprove is defined and wired into openDetail", () => {
    expect(html).toContain("function renderDetailApprove");
    expect(html).toContain("renderDetailApprove(task);");
  });

  test("renders ONLY for state === 'approve'", () => {
    expect(html).toContain("task.state !== 'approve'");
  });

  test("merge-case summary + link-out (no fetch/diff)", () => {
    expect(html).toContain("'merge PR #' + task.pr");
    expect(html).toContain("'✓ reviewed by ' + task.reviewer");
    expect(html).toContain("'https://github.com/' + repo + '/pull/' + task.pr");
    // no PR content fetch / diff render (kobo-190 Q3=a)
    expect(html).not.toContain("/pull/' + task.pr + '.diff");
  });

  test("Approve button is MARK-ONLY: posts a comment, never merges", () => {
    expect(html).toContain("'✅ Tony approved'");
    expect(html).toContain("'/api/tasks/comment'");
    // mark-only — no merge / PR-write path in the approve block
    expect(html).not.toContain("gh pr merge");
    expect(html).not.toContain("/api/tasks/merge");
  });

  test("link href is scheme-safe (fixed https prefix + slug-guarded repo)", () => {
    // slug pattern must survive the enclosing template literal intact (no '/' or
    // backslash escape that the template would eat — the kobo-190 regex trap).
    expect(html).toContain("/^[A-Za-z0-9_.-]+$/");
    expect(html).toContain("repoParts.length === 2");
  });

  test("client <script> parses as valid browser JS (backtick-trap guard)", () => {
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));
    expect(script.length).toBeGreaterThan(1000);
    // new Function compiles (parses) the script without executing it — a stray
    // backtick inside the companyBody template literal would break the string long
    // before here, but a syntax error in our added code surfaces as a throw.
    expect(() => new Function(script)).not.toThrow();
  });
});
