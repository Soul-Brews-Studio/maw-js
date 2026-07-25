import { describe, expect, test } from "bun:test";
import { escapeHtml, inlineMd, mdToHtml } from "./md";

describe("md.ts — shared escape-first markdown renderer (kobo-396)", () => {
  test("escapeHtml escapes & < > \" ' (order matters: & first, so entities aren't double-escaped)", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("<img onerror=alert(1) src=x>")).toBe("&lt;img onerror=alert(1) src=x&gt;");
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  test("mdToHtml renders bold", () => {
    expect(mdToHtml("this is **bold** text")).toContain("<strong>bold</strong>");
  });

  test("mdToHtml renders headings h1-h6", () => {
    expect(mdToHtml("# H1")).toBe("<h1>H1</h1>");
    expect(mdToHtml("### H3")).toBe("<h3>H3</h3>");
  });

  test("mdToHtml renders an unordered list", () => {
    const out = mdToHtml("- one\n- two");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).toContain("</ul>");
  });

  test("mdToHtml renders a fenced code block", () => {
    const out = mdToHtml("```\nconst x = 1;\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("</code></pre>");
  });

  test("mdToHtml renders inline code spans via inlineMd", () => {
    expect(inlineMd("run `npm test`")).toBe("run <code>npm test</code>");
  });

  // 🔴 XSS: escape-first must survive markdown structuring — a payload embedded
  // INSIDE markdown syntax (not just as plain text) must still render inert.
  test("XSS: a <script> payload inside a message renders INERT, never as a live tag", () => {
    const out = mdToHtml("hello <script>alert(1)</script> world");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("XSS: an <img onerror> payload renders INERT (escaped, no live img tag)", () => {
    const out = mdToHtml('gotcha <img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img src=x onerror=");
    expect(out).toContain("&lt;img src=x onerror=");
  });

  test("XSS: a payload disguised as markdown bold/list syntax still escapes first", () => {
    const bold = mdToHtml("**<script>alert(1)</script>**");
    expect(bold).not.toContain("<script>");
    expect(bold).toBe("<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>");

    const list = mdToHtml("- <img src=x onerror=alert(1)>");
    expect(list).not.toContain("<img src=x onerror=");
    expect(list).toContain("&lt;img src=x onerror=");
  });

  test("XSS: a markdown-link payload can't inject an event-handler attribute", () => {
    // the md-link pattern only accepts a bare http(s) URL as the href — an
    // attempted attribute-injection payload just fails to match and renders as
    // escaped literal text instead of a link.
    const out = mdToHtml('[click](javascript:alert(1))');
    expect(out).not.toContain("<a href=\"javascript:");
  });

  // 🔴 kobo-396 request-change (reviewer PoC): the md-link URL pattern allows a
  // double-quote (only excludes `)` + whitespace) — an unescaped `"` in the URL
  // closes the href="..." attribute early, letting the rest of the URL text land
  // as a NEW attribute (e.g. onmouseover=). escapeHtml runs FIRST on the whole
  // source, so the quote is &quot; by the time inlineMd builds the <a>, and can
  // never break out of the attribute.
  test("XSS: a quote-breakout payload inside a markdown-link URL can't inject an attribute", () => {
    const out = mdToHtml('[click](https://a.com/"onmouseover=alert(1))');
    // exact match: onmouseover= lands INSIDE the quoted href value (harmless text,
    // since &quot; is an entity not a real delimiter) — never as a second, live
    // attribute on the <a> tag (which would require a REAL unescaped " to open it).
    expect(out).toBe('<p><a href="https://a.com/&quot;onmouseover=alert(1" target="_blank" rel="noopener">click</a>)</p>');
    expect(out).not.toContain('" onmouseover='); // the tell-tale shape of a broken-out attribute
  });
});
