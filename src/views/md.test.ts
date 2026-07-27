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

  // kobo-425: blockquote never actually worked — `escapeHtml` (line 12) runs
  // BEFORE the line-split, turning a real `>` into `&gt;`, so the old regex
  // (which looked for a literal `>`) could never match. Fixed to match the
  // escaped form; these tests pin the fix AND the merge/split/no-nest rules
  // Tony required alongside it.
  test("kobo-425: mdToHtml renders a single `>` line as a <blockquote>", () => {
    expect(mdToHtml("> hello")).toBe("<blockquote>\nhello\n</blockquote>");
  });

  test("kobo-425: consecutive `>` lines merge into exactly ONE <blockquote> box", () => {
    const out = mdToHtml("> one\n> two\n> three");
    expect(out.match(/<blockquote>/g)?.length).toBe(1);
    expect(out.match(/<\/blockquote>/g)?.length).toBe(1);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("three");
    expect(out).toContain("<br>"); // merged lines are separated, not silently run together
  });

  test("kobo-425: a blank line between `>` groups starts a NEW box — 2 boxes, not 1", () => {
    const out = mdToHtml("> one\n\n> two");
    expect(out.match(/<blockquote>/g)?.length).toBe(2);
    expect(out.match(/<\/blockquote>/g)?.length).toBe(2);
  });

  test("kobo-425: `>>` (a nested marker on one line) still yields exactly ONE box, never a stacked/nested blockquote", () => {
    const out = mdToHtml(">> foo");
    expect(out.match(/<blockquote>/g)?.length).toBe(1);
    // the second `>` was only escaped to `&gt;`, never re-parsed as markdown —
    // it survives as inert text inside the single box, not a nested tag.
    expect(out).toContain("&gt; foo");
  });

  test("kobo-425: a `>` inside a fenced code block stays raw text, never becomes a blockquote", () => {
    const out = mdToHtml("```\n> not a quote\n```");
    expect(out).not.toContain("<blockquote>");
    expect(out).toContain("&gt; not a quote");
  });

  test("kobo-425: a non-blockquote line (heading) closes an open blockquote instead of absorbing into it", () => {
    const out = mdToHtml("> quoted\n# heading");
    expect(out).toBe("<blockquote>\nquoted\n</blockquote>\n<h1>heading</h1>");
  });

  // kobo-425 review (eq3 c-follow-up): closeBQ() is called at 8 separate exit
  // points (blank line, heading, and — the 5 below — fence/hr/ul/ol/paragraph,
  // plus end-of-input). Only blank-line and heading had a test; the other 5
  // could each silently lose their closeBQ() call and every test still passed
  // — the open box would swallow the rest of the message (and on the board,
  // the rest of the CARD, since md.ts is the shared renderer).
  test("kobo-425: an open blockquote closes before a FENCE starts, never swallowing the code block", () => {
    const out = mdToHtml("> a\n```\ncode\n```");
    expect(out).toBe("<blockquote>\na\n</blockquote>\n<pre><code>\ncode\n</code></pre>");
  });

  test("kobo-425: an open blockquote closes before an HR, never swallowing it", () => {
    const out = mdToHtml("> a\n---");
    expect(out).toBe("<blockquote>\na\n</blockquote>\n<hr/>");
  });

  test("kobo-425: an open blockquote closes before a UL starts, never swallowing the list", () => {
    const out = mdToHtml("> a\n- item");
    expect(out).toBe("<blockquote>\na\n</blockquote>\n<ul>\n<li>item</li>\n</ul>");
  });

  test("kobo-425: an open blockquote closes before an OL starts, never swallowing the list", () => {
    const out = mdToHtml("> a\n1. item");
    expect(out).toBe("<blockquote>\na\n</blockquote>\n<ol>\n<li>item</li>\n</ol>");
  });

  test("kobo-425: an open blockquote closes before a plain paragraph, never swallowing it", () => {
    const out = mdToHtml("> a\nplain text");
    expect(out).toBe('<blockquote>\na\n</blockquote>\n<p class="pg-0">plain text</p>');
  });

  test("XSS: a <script> payload inside a `>` line still escapes (blockquote content is not a new sink)", () => {
    const out = mdToHtml("> <script>alert(1)</script>");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  // kobo-456: 1 paragraph = 1 colour, alternating automatically — the writer
  // marks nothing. A "paragraph" is a run of CONSECUTIVE plain-text lines;
  // colouring per-<p> directly (as if every line were its own paragraph)
  // would turn a long message into a rainbow, the opposite of what was asked.
  const pgClasses = (html: string) => [...html.matchAll(/<p class="(pg-\d)">/g)].map((m) => m[1]);

  test("kobo-456: consecutive lines are ONE paragraph — same colour class on every line", () => {
    expect(pgClasses(mdToHtml("line one\nline two\nline three"))).toEqual(["pg-0", "pg-0", "pg-0"]);
  });

  test("kobo-456: a blank line between paragraphs alternates the colour", () => {
    expect(pgClasses(mdToHtml("para a\n\npara b"))).toEqual(["pg-0", "pg-1"]);
  });

  test("kobo-456: a single-paragraph message still gets a valid colour class, no crash", () => {
    expect(mdToHtml("just one line")).toBe('<p class="pg-0">just one line</p>');
  });

  // AC5: existing, unedited messages already in the room must get coloured
  // under the new rule with no text change. mdToHtml is a pure function of
  // the text with no legacy-vs-new branch, so this is currently implied by
  // every other test here — but "implied" quietly stops being true the
  // moment someone adds a branch (e.g. a message-age check) later. Naming
  // this explicitly is what would catch that regression.
  test("kobo-456: pre-existing, unedited message text (nothing marked up for this feature) still gets coloured through the SAME path as new messages", () => {
    const oldStyleMessage = "just some plain text someone wrote before this feature existed";
    expect(mdToHtml(oldStyleMessage)).toBe('<p class="pg-0">' + oldStyleMessage + '</p>');
  });

  // front's ruling that per-line seams are the ACCEPTED look (closer to a
  // real highlighter than a solid block) rests on the structure never
  // collapsing multi-line paragraphs into one merged element. Pin the
  // structure itself, not his opinion of it — a future "fix" that merges the
  // lines to remove the banding would break this even though every
  // colour-grouping test above would still pass (they check the CLASS, not
  // the element count).
  test("kobo-456: a MULTI-LINE paragraph group stays as SEPARATE <p> elements per line, never collapsed into one merged block", () => {
    const out = mdToHtml("line one\nline two\nline three");
    expect(out.match(/<p class="pg-0">/g)?.length).toBe(3); // 3 elements, not 1 merged <p>
    expect(out).not.toContain("<br>"); // <br>-joining is the blockquote merge pattern (kobo-425) — paragraphs never adopt it
  });

  // unhappy path (card): a message with no clear paragraph breaks (one very
  // long physical line) must not become one giant solid-colour block filling
  // the screen — it's exactly ONE ordinary paragraph, same shape as a short
  // one, just with more text. Splitting is on \n only, so length alone can
  // never multiply it into several bands or grow it past a normal <p>.
  test("kobo-456 unhappy: a single very long line (no paragraph breaks) does NOT become one solid colour block — it's exactly ONE normal paragraph, same shape as a short one", () => {
    const longLine = "word ".repeat(200).trim();
    const out = mdToHtml(longLine);
    expect(out).toBe('<p class="pg-0">' + longLine + '</p>');
    expect(out.match(/<p /g)?.length).toBe(1);
  });

  test("kobo-456: many paragraphs cycle back to the first colour — intentional, not broken", () => {
    expect(pgClasses(mdToHtml("p1\n\np2\n\np3\n\np4\n\np5"))).toEqual(["pg-0", "pg-1", "pg-2", "pg-3", "pg-0"]);
  });

  test("kobo-456: a heading between paragraph runs starts a fresh colour group on each side", () => {
    expect(pgClasses(mdToHtml("p1\n# head\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  test("kobo-456: a list between paragraph runs starts a fresh colour group on each side", () => {
    expect(pgClasses(mdToHtml("p1\n- item\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  // reviewer L1: the ol branch (md.ts) was the only list-type branch with no
  // test watching its endParaRun() call. No blank line on either side of the
  // list here — a blank line would mask the branch (same trap the blockquote
  // test above caught), so this must abut directly to actually exercise it.
  test("kobo-456: an ORDERED list between paragraph runs also starts a fresh colour group on each side", () => {
    expect(pgClasses(mdToHtml("p1\n1. item\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  test("kobo-456: an hr between paragraph runs starts a fresh colour group on each side", () => {
    expect(pgClasses(mdToHtml("p1\n---\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  test("kobo-456: a fenced code block between paragraph runs starts a fresh colour group on each side", () => {
    expect(pgClasses(mdToHtml("p1\n```\ncode\n```\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  // this directly abuts a blockquote line against a paragraph line with NO
  // blank line between them — the combined test below always has a blank
  // line on both sides of its quote, so it never actually exercises whether
  // entering a blockquote resets a paragraph run.
  test("kobo-456: a blockquote directly between paragraph lines (no blank line) also starts a fresh colour group", () => {
    expect(pgClasses(mdToHtml("p1\n> quoted\np2"))).toEqual(["pg-0", "pg-1"]);
  });

  // 🔴 AC: bold highlight + the ONE-box blockquote (kobo-425, deployed) + the
  // new paragraph colour must all coexist in the SAME message, none swallowing
  // the others — a single test covering all 3, not 3 separate ones.
  test("kobo-456: bold highlight + ONE blockquote box + paragraph colours all coexist in one message", () => {
    const out = mdToHtml("**bold** first line\nsecond line\n\n> quoted a\n> quoted b\n\nafter, plain");
    expect(out).toContain("<strong>bold</strong>"); // bold highlight untouched
    expect(out.match(/<blockquote>/g)?.length).toBe(1); // still ONE box, not per-line
    expect(out.match(/<\/blockquote>/g)?.length).toBe(1);
    expect(pgClasses(out)).toEqual(["pg-0", "pg-0", "pg-1"]); // run before the quote, fresh run after
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
    expect(bold).toBe('<p class="pg-0"><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>');

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
    expect(out).toBe('<p class="pg-0"><a href="https://a.com/&quot;onmouseover=alert(1" target="_blank" rel="noopener">click</a>)</p>');
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
