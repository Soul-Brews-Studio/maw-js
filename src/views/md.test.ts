import { describe, expect, test } from "bun:test";
import { escapeHtml, inlineMd, mdToHtml, renderNoteBody } from "./md";

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

  // kobo-398 review fix (L2) — the fence info-string capture (mermaid vs any
  // other/none) was shipped without a lock in this shared-renderer test file,
  // same shape as the 396 review scar (behavior verified by hand, never pinned).
  test("kobo-398: a ```mermaid fence renders as a .mermaid-src <pre>, source text HTML-escaped (escape-first, before mermaid ever sees it)", () => {
    const out = mdToHtml('```mermaid\ngraph TD\nA["<script>alert(1)</script>"]\n```');
    expect(out).toContain('<pre class="mermaid-src">');
    expect(out).toContain('</pre>');
    expect(out).not.toContain('<pre><code>'); // mermaid fences never fall into the generic code-block path
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); // escaped BEFORE mermaid touches it
    expect(out).not.toContain('<script>alert(1)</script>'); // never a live tag in the source text
  });

  test("kobo-398: a ```js fence (any non-mermaid lang) is unchanged — still a normal <pre><code> block", () => {
    const out = mdToHtml("```js\nconst x = 1;\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("</code></pre>");
    expect(out).not.toContain("mermaid-src");
  });

  test("kobo-398: a bare fence (no lang) is unchanged — still a normal <pre><code> block", () => {
    const out = mdToHtml("```\nplain text\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("plain text");
    expect(out).toContain("</code></pre>");
    expect(out).not.toContain("mermaid-src");
  });

  test("kobo-398: an unclosed ```mermaid fence still closes its </pre> (mirrors the pre-existing unclosed-code-fence behavior)", () => {
    const out = mdToHtml('```mermaid\ngraph TD\nA-->B');
    expect(out).toContain('<pre class="mermaid-src">');
    expect(out.trim().endsWith('</pre>')).toBe(true);
  });

  // kobo-398 review fix (L3 regression guard): the mermaid element changed from
  // <div> to <pre> so it inherits white-space:pre on both room AND the board
  // (same shared renderer) — this pins that the UNRELATED, pre-existing
  // <pre><code> path for every non-mermaid fence is byte-for-byte untouched,
  // not just "doesn't say mermaid-src somewhere".
  test("kobo-398 L3 regression guard: a non-mermaid fence emits exactly <pre><code>...</code></pre>, never <pre class=\"mermaid-src\">", () => {
    const out = mdToHtml("```js\nconst x = 1;\n```");
    expect(out).toBe("<pre><code>\nconst x = 1;\n</code></pre>");
    expect(out).not.toContain('mermaid-src');
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

describe("renderNoteBody — maw:// image-ref swap (kobo-397, extracted from company.ts kobo-116)", () => {
  test("swaps an allowlisted-ext maw:// ref for a real <img>, src built from OUR OWN /api/files/ + the matched filename", () => {
    const out = renderNoteBody("here: maw://local/abc123.png done");
    expect(out).toContain('<img class="note-img" loading="lazy" src="/api/files/abc123.png" alt="abc123.png">');
    expect(out).toContain('<a class="note-img-link" href="/api/files/abc123.png"');
  });

  test("a non-allowlisted extension (e.g. svg — not in png/jpg/gif/webp) is left as plain text, not an <img>", () => {
    const out = renderNoteBody("maw://local/evil.svg");
    expect(out).not.toContain("<img");
    expect(out).toContain("maw://local/evil.svg"); // untouched, rendered as inert text
  });

  // 🔴 XSS (card AC): a maw://-disguised or javascript:/data: ref must NEVER become
  // a live src — renderNoteBody only ever builds src from ITS OWN regex-captured,
  // charset-allowlisted filename; it never echoes a caller-supplied URL/scheme.
  test("XSS: a bare javascript:/data: URI (no maw:// prefix) never becomes an <img src>", () => {
    const out = renderNoteBody('gotcha javascript:alert(1) and data:text/html,<script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("src=\"javascript:");
    expect(out).not.toContain("src=\"data:");
  });

  test("XSS: a maw:// ref carrying a quote/attribute-breakout payload in the filename position fails to match (charset-only) and renders inert", () => {
    // escapeHtml already ran (quotes → &quot;) before this regex sees the text, and
    // the filename charset ([A-Za-z0-9._-]+) excludes quotes/slashes/parens anyway —
    // double protection. No <img> is emitted, and no live onerror/onload attribute
    // appears anywhere in the output.
    const out = renderNoteBody('maw://local/x.png"onerror=alert(1).png');
    expect(out).not.toMatch(/<img[^>]*\bonerror=/);
    expect(out).not.toContain('.png"onerror=');
  });

  test("a real render call from a room message still runs mdToHtml first (bold + image together)", () => {
    const out = renderNoteBody("**shipped** maw://local/shot.jpg");
    expect(out).toContain("<strong>shipped</strong>");
    expect(out).toContain('src="/api/files/shot.jpg"');
  });
});
