import { describe, expect, test } from "bun:test";
import { roomHtml } from "./room";
import { isProtected } from "../lib/elysia-auth";

// kobo-258 — the /room page became a company-scoped 2-pane chat (UX spec eq3 2026-07-10):
// LEFT topic list · RIGHT thread, default partner = the company lead, 3-role attribution
// (you/lead/teammate) by pill + alignment + colour (a11y). The board is a single-file
// HTML+JS template (no runtime here), so pin the structural markers a refactor must keep.
describe("Brainstorm Room 2-pane chat view (kobo-258)", () => {
  const html = roomHtml();

  test("consumes the existing room engine endpoints (no new engine — view only)", () => {
    expect(html).toContain("/api/rooms"); // kobo-258 company-scoped list (topics + selector + lead)
    expect(html).toContain("/api/room/thread"); // persisted thread (kobo-241)
    expect(html).toContain("/api/room/send"); // hey to the lead (kobo-245/248)
    expect(html).toContain("/api/room/activity"); // who's-here strip (kobo-242)
    expect(html).toContain("/api/room/open"); // new topic
    expect(html).toContain("/api/room/distill"); // room → card (kobo-244)
    expect(html).toContain("/api/room/merge"); // consolidate (kobo-243)
    expect(html).toContain("/api/room/invite"); // kobo-260 pull a teammate in
    expect(html).not.toContain("/api/feed"); // never the ephemeral feed
  });

  test("kobo-260: invite affordance pulls a teammate in (reachable from the chat header)", () => {
    expect(html).toContain('id="inviteBtn"');
    expect(html).toContain("async function invite");
  });

  test("2-pane structure: company selector, topic list, thread, composer, lead label", () => {
    expect(html).toContain('id="company"'); // company selector (scope)
    expect(html).toContain('id="leadName"'); // "lead: <oracle>" — default partner
    expect(html).toContain('id="roomlist"'); // LEFT topic list
    expect(html).toContain('id="thread"'); // RIGHT conversation
    expect(html).toContain('id="text"'); // composer
    expect(html).toContain("class=\"app\""); // the 2-pane grid
  });

  // kobo-425: **bold** → highlighter-pen look, `>` → one solid red box, ROOM
  // ONLY. The board (company.ts) shares md.ts's renderer but scopes its CSS
  // under `.md` — room scopes under `.bubble .body`, a different selector
  // namespace, so the two surfaces can't collide (see company.test.ts for
  // the board-side half of this pin — its .md rules stay untouched).
  test("kobo-425: room-only CSS — **bold** highlights and `>` renders a red box with a left border, scoped to .bubble .body", () => {
    expect(html).toContain(".bubble .body strong {");
    expect(html).toContain(".bubble .body blockquote {");
    const strongRule = html.slice(html.indexOf(".bubble .body strong {"), html.indexOf("}", html.indexOf(".bubble .body strong {")) + 1);
    expect(strongRule).toContain("background:"); // a highlighter fill, not just bold text
    const bqRule = html.slice(html.indexOf(".bubble .body blockquote {"), html.indexOf("}", html.indexOf(".bubble .body blockquote {")) + 1);
    expect(bqRule).toContain("border-left:"); // left border, per spec
    expect(bqRule).toContain("var(--danger)"); // red, not the board's thin gray line
    expect(bqRule).toContain("background:"); // a filled BOX, not just a border/line
  });

  // kobo-493: kobo-456 added a `.bubble .body p.pg-N { background: ... }`
  // rule that coloured EVERY paragraph regardless of content — Tony rejected
  // it live. Regression guard: no p-level background rule may exist at all;
  // colour stays exclusively on the marked-up strong span (kobo-425, above).
  test("kobo-493: no paragraph-level background colour rule exists — highlighting is strong-only, never applied to a bare <p>", () => {
    expect(html).not.toMatch(/\.bubble \.body p\.pg-\d/);
    expect(html).not.toMatch(/\.bubble \.body p\s*\{[^}]*background/);
    expect(html).toContain(".bubble .body p { margin:4px 0; }"); // the base structural rule (kobo-396) — spacing only, no colour
  });

  test("default partner = the company lead (send targets `lead`, from the /api/rooms response)", () => {
    expect(html).toContain("body.lead"); // lead resolved server-side, carried in the list response
    expect(html).toContain("to: lead"); // the send defaults to the company lead
    expect(html).toContain("from: 'web'"); // web turn tagged human (kobo-248)
  });

  test("3-role attribution by pill + alignment + colour, not colour alone (a11y)", () => {
    expect(html).toContain(".bubble.you"); // human — right, sky
    expect(html).toContain(".bubble.lead"); // lead — left, green
    expect(html).toContain(".bubble.teammate"); // pulled-in teammate — left, violet
    expect(html).toContain("function roleOf"); // maps `from` → role (web→you, lead→lead)
    expect(html).toContain("function pillText"); // role-pill TEXT carries the role (colour-not-only)
    expect(html).toContain("align-self:flex-end"); // alignment also carries it
  });

  test("mobile single-pane slide + a11y basics", () => {
    expect(html).toContain("max-width:768px"); // mobile breakpoint
    expect(html).toContain("showchat"); // single-pane: topic list → slide to chat
    expect(html).toContain('aria-live="polite"'); // new messages announced
    expect(html).toContain(":focus-visible"); // keyboard focus ring
  });

  test("no nested backtick breaks the single template literal (renders non-empty)", () => {
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain("<!doctype html>");
  });

  test("kobo-379: close/reopen affordance in the chat header, toggles the composer", () => {
    expect(html).toContain('id="closeBtn"');
    expect(html).toContain("/api/room/close");
    expect(html).toContain("/api/room/reopen");
    expect(html).toContain("function toggleRoomOpen");
    expect(html).toContain("function updateRoomControls");
    expect(html).toContain("$('text').disabled = !open"); // closed room disables reply
  });

  // kobo-380 — auto-linkify: extract the linkify/isSafeUrl block straight out of the
  // template literal and run it against a minimal document stub (createElement/
  // createTextNode only) so the XSS-safety claim is BEHAVIORALLY proven, not just
  // grepped. No new DOM dependency — the stub is a plain object, disposed after.
  function loadLinkify() {
    const start = html.indexOf("const URL_RE =");
    const end = html.indexOf("// ── compose / send", start);
    const src = html.slice(start, end);
    return new Function(`${src}; return { isSafeUrl, linkify };`)();
  }

  test("kobo-380: URL auto-linkify (bare-URL post-pass) never touches innerHTML (textContent/createElement only)", () => {
    expect(html).toContain("function linkify");
    expect(html).toContain("function isSafeUrl");
    expect(html).toContain("createElement('a')");
  });

  test("kobo-396/397/398/527: only 3 KNOWN innerHTML sinks — escape-first renderNoteBody (x2) + mermaid's own trusted SVG", () => {
    expect(html).toContain("function mdToHtml"); // shared renderer (src/views/md.ts) injected verbatim
    expect(html).toContain("function escapeHtml");
    expect(html).toContain("function renderNoteBody"); // kobo-397: markdown + maw:// image-ref swap
    expect(html).toContain("bodyEl.innerHTML = renderNoteBody(m.text || '')"); // sink 1: escape-first, message body
    expect(html).toContain("bodyDiv.innerHTML = renderNoteBody(t.body)"); // sink 3 (kobo-527): SAME escape-first renderer, card-ref modal body
    expect(html).toContain("p.block.innerHTML = p.svg"); // sink 2: mermaid's OWN output (strict mode), not user text — one write site for both cache-hit and freshly-rendered
    const innerHtmlAssignments = (html.match(/\.innerHTML\s*=/g) || []).length;
    expect(innerHtmlAssignments).toBe(3); // no OTHER innerHTML= sink anywhere in the view
  });

  // kobo-398 review fix (B3): check 11 (strict must be hardcoded, no flag/env
  // can disable it in production) was previously enforced only by a human
  // grepping the PR — 0 hits for "securityLevel" existed in this test file. A
  // future edit that turned strict into an option/env would sail through green.
  // Exact-string match on the literal initialize() call closes that gap.
  test("kobo-398 check 11: securityLevel:'strict' + startOnLoad:false are hardcoded literals, no flag/env can disable them", () => {
    expect(html).toContain("window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'base', themeVariables: MERMAID_THEME_VARIABLES })");
  });

  // kobo-422 review (eq3 F1): MERMAID_ASSET_URL's ?v= was only kept in sync with
  // package.json's mermaid pin by a code comment ("bump alongside package.json's
  // exact pin") — nothing enforced it. assets.ts now serves this file with
  // cache-control: immutable, max-age=1yr, so a forgotten bump strands a browser
  // that already fetched the old asset on it for up to a year. Read the ACTUAL
  // installed version from package.json at test time (never hardcode it on
  // either side) so drift in EITHER direction — room.ts falling behind a
  // mermaid bump, or a package.json edit outpacing room.ts — fails CI.
  test("kobo-422 F1: MERMAID_ASSET_URL's ?v= is pinned to package.json's real mermaid version, not just a comment", () => {
    const pkg = require("../../package.json");
    const installedMermaidVersion = pkg.dependencies.mermaid;
    expect(html).toContain(`/assets/vendor/mermaid.js?v=${installedMermaidVersion}`);
  });

  // kobo-398 — extract the mermaid loader/renderer straight from the served client
  // script (same technique as loadLinkify above) and run it against stub
  // document/window objects so lazy-by-absence, load-once, and per-block
  // isolation are BEHAVIORALLY proven, not just grepped.
  function loadMermaidRenderer() {
    const start = html.indexOf("const MERMAID_ASSET_URL");
    const end = html.indexOf("async function loadThread", start);
    const src = html.slice(start, end);
    // kobo-422: setMermaidThemeIdForTest exists ONLY in this test-side return
    // statement — mermaidThemeId is a `let` inside the extracted source purely
    // so this harness can prove the cache key reacts to it; shipped code never
    // reassigns it (no runtime theme switcher exists).
    // kobo-426: setMermaidThemeVariableForTest exists ONLY here too — proves
    // the cache key reacts to MERMAID_THEME_VARIABLES itself changing, not
    // just to mermaidThemeId (the fix for "invalidation relied on someone
    // remembering to bump a comment-instructed string").
    return new Function(`${src}; return { loadMermaid, renderMermaidBlocks, setMermaidThemeIdForTest: (v) => { mermaidThemeId = v; }, setMermaidThemeVariableForTest: (k, v) => { MERMAID_THEME_VARIABLES[k] = v; } };`)();
  }
  // kobo-398 review fix (B2): the real querySelectorAll returns a NodeList, not
  // an Array — a plain-array stub is a MORE capable fake than the real DOM (it
  // has .map/.filter that NodeList lacks), which is exactly how the room.ts:402
  // `blocks.map(...)` bug (B1 — real TypeError in a browser) shipped past every
  // test here green. This fake has length + forEach + Symbol.iterator, like the
  // real thing, and deliberately NO map/filter, so a stray array-method call on
  // the querySelectorAll result fails the test instead of silently passing.
  function nodeList(items) {
    return {
      length: items.length,
      item: (i) => items[i],
      forEach: (cb) => items.forEach(cb),
      [Symbol.iterator]: () => items[Symbol.iterator](),
    };
  }
  function stubEnv(renderImpl) {
    const createdTags = [];
    const doc = {
      createElement: (tag) => { createdTags.push(tag); const el = { tag, onload: null, onerror: null }; Object.defineProperty(el, "src", { set() { queueMicrotask(() => el.onload && el.onload()); } }); return el; },
      head: { appendChild: () => {} },
    };
    const win = { mermaid: { initialize: () => {}, render: renderImpl } };
    return { doc, win, createdTags };
  }

  test("kobo-398 LAZY-BY-ABSENCE: no .mermaid-src block → the asset is NEVER loaded (no <script> created)", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win, createdTags } = stubEnv(async () => ({ svg: "<svg/>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const emptyRoot = { querySelectorAll: () => nodeList([]) };
      await renderMermaidBlocks(emptyRoot);
      expect(createdTags).toEqual([]); // absence proven: nothing was ever loaded
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  test("kobo-398 LAZY-BY-ABSENCE (present case): a .mermaid-src block DOES trigger the asset load", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win, createdTags } = stubEnv(async () => ({ svg: "<svg>ok</svg>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const block = { textContent: "graph TD; A-->B;", innerHTML: "", isConnected: true };
      const root = { querySelectorAll: () => nodeList([block]) };
      await renderMermaidBlocks(root);
      expect(createdTags).toEqual(["script"]); // present → loaded exactly once
      expect(block.innerHTML).toBe("<svg>ok</svg>");
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  test("kobo-398 LOAD-ONCE: two render passes (simulating two 2.5s polls) load the asset only ONCE", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win, createdTags } = stubEnv(async () => ({ svg: "<svg>x</svg>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([{ textContent: "graph TD; A-->B;", innerHTML: "", isConnected: true }]) });
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([{ textContent: "graph TD; C-->D;", innerHTML: "", isConnected: true }]) });
      expect(createdTags.length).toBe(1); // the module-level Promise cache holds across calls
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-398 review fix (M1) — loadThread rebuilds the thread's DOM every 2.5s
  // poll, so the OLD test above only proved the asset script tag loads once; it
  // never proved re-polling the SAME diagram avoids re-calling mermaid.render
  // (real cost: reparse + relayout every unchanged diagram every poll). Cache
  // by source text — a poll whose diagrams are unchanged must be a pure cache
  // hit, zero calls into mermaid.render.
  test("kobo-398 SVG CACHE: re-polling the SAME diagram source does NOT re-call mermaid.render", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    let renderCalls = 0;
    const { doc, win, createdTags } = stubEnv(async () => { renderCalls++; return { svg: "<svg>x</svg>" }; });
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const src = "graph TD; A-->B;";
      const block1 = { textContent: src, innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block1]) });
      // poll 2 rebuilds the thread → a brand-new DOM node, SAME source text
      const block2 = { textContent: src, innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block2]) });
      expect(renderCalls).toBe(1); // poll 2 was a cache hit — mermaid.render never called again
      expect(block2.innerHTML).toBe("<svg>x</svg>"); // cached SVG applied synchronously, no async gap
      expect(createdTags.length).toBe(1); // asset load still only-once too
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-398 review fix (M1) — the race the old cache-less code was exposed to:
  // if mermaid.render is still in flight when the NEXT 2.5s poll rebuilds the
  // thread (replaceChildren), the block this render call is targeting is
  // already detached. Writing innerHTML into a detached node is a silent no-op
  // for the user — this proves the fix drops that write instead of corrupting
  // a stale node, while still banking the SVG so the next poll's cache hits.
  test("kobo-398 RACE GUARD: block detaches mid-render (poll N+1 rebuilt the thread first) → write is dropped, not applied to the stale node; SVG is still cached for the next poll", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    let resolveRender;
    const renderPromise = new Promise((resolve) => { resolveRender = resolve; });
    const { doc, win } = stubEnv(() => renderPromise);
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const src = "graph TD; A-->B;";
      const block = { textContent: src, innerHTML: "", isConnected: true };
      const pending = renderMermaidBlocks({ querySelectorAll: () => nodeList([block]) });
      block.isConnected = false; // the next poll rebuilt the thread before this render settled
      resolveRender({ svg: "<svg>late</svg>" });
      await pending;
      expect(block.innerHTML).toBe(""); // never written — the node was already detached
      // next poll: a NEW connected node, same source — the cache (set even though
      // the write was dropped) means this is a hit, no second mermaid.render call.
      const block2 = { textContent: src, innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block2]) });
      expect(block2.innerHTML).toBe("<svg>late</svg>");
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-398 review re-verify criterion (a): the cache must never weaken
  // lazy-by-absence — a thread with NO mermaid block must still never touch the
  // asset, even once the SAME renderer instance already has cache entries from
  // rendering a PREVIOUS thread's diagram.
  test("kobo-398 CACHE + LAZY-BY-ABSENCE: a populated cache does not make an empty thread load the asset", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win, createdTags } = stubEnv(async () => ({ svg: "<svg>x</svg>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const block = { textContent: "graph TD; A-->B;", innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block]) }); // populates the cache
      expect(createdTags).toEqual(["script"]);
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([]) }); // a different thread, no diagrams at all
      expect(createdTags).toEqual(["script"]); // still exactly one load — absence still means absence
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-398 review re-verify criterion (b): a cache-hit write is still one
  // block among siblings — one throwing write must not skip the rest (the
  // ORIGINAL per-block try/catch guarantee, now proven for the cache-hit path
  // specifically, not just the freshly-rendered path already covered above).
  test("kobo-398 PER-BLOCK ISOLATION (cache-hit path): a throwing cache-hit write doesn't abort a sibling's write", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win } = stubEnv(async () => ({ svg: "<svg>ok</svg>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const src = "graph TD; A-->B;";
      const warm = { textContent: src, innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([warm]) }); // warm the cache for `src`
      const throwing = { textContent: src, isConnected: true, set innerHTML(_v) { throw new Error("boom"); } };
      const good = { textContent: src, innerHTML: "", isConnected: true };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([throwing, good]) }); // both cache hits
      expect(good.innerHTML).toBe("<svg>ok</svg>"); // sibling write still lands despite `throwing`'s failure
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  test("kobo-398 PER-BLOCK ISOLATION: 1 bad + 1 good diagram → the good one still renders (bad falls back to source)", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win } = stubEnv(async (_id, src) => {
      if (src.includes("BADSYNTAX")) throw new Error("mermaid parse error");
      return { svg: "<svg>good</svg>" };
    });
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const bad = { textContent: "BADSYNTAX ---", innerHTML: "", isConnected: true };
      const good = { textContent: "graph TD; A-->B;", innerHTML: "", isConnected: true };
      const root = { querySelectorAll: () => nodeList([bad, good]) };
      await renderMermaidBlocks(root); // must not throw — the bad block's error is caught PER-BLOCK
      expect(bad.innerHTML).toBe(""); // untouched — the escaped source text (its existing content) is the fallback
      expect(good.innerHTML).toBe("<svg>good</svg>"); // NOT aborted by the bad sibling
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-422 — thumbnail: a successfully-rendered block becomes clickable (the
  // CSS turns it visually small; the class is what makes it eligible at all).
  test("kobo-422 THUMBNAIL CLASS: a successfully rendered block gets the mermaid-thumb class", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win } = stubEnv(async () => ({ svg: "<svg>ok</svg>" }));
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const added: string[] = [];
      const block = { textContent: "graph TD; A-->B;", innerHTML: "", isConnected: true, classList: { add: (c: string) => added.push(c) } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block]) });
      expect(added).toEqual(["mermaid-thumb"]);
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  test("kobo-422 THUMBNAIL CLASS: a FAILED render never gets the mermaid-thumb class (fallback source stays non-clickable)", async () => {
    const { renderMermaidBlocks } = loadMermaidRenderer();
    const { doc, win } = stubEnv(async () => { throw new Error("bad syntax"); });
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const added: string[] = [];
      const block = { textContent: "BADSYNTAX ---", innerHTML: "", isConnected: true, classList: { add: (c: string) => added.push(c) } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block]) });
      expect(added).toEqual([]);
      expect(block.innerHTML).toBe("");
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-422 — cache KEY now includes the theme id (a SEPARATE concern from the
  // Map's unbounded size/growth, which this card explicitly does not touch).
  // Switching theme must invalidate every cached SVG for the SAME source text.
  test("kobo-422 CACHE KEY: switching theme invalidates the cache for the SAME source (re-renders, doesn't reuse the old-theme SVG)", async () => {
    const { renderMermaidBlocks, setMermaidThemeIdForTest } = loadMermaidRenderer();
    let renderCalls = 0;
    const { doc, win, createdTags } = stubEnv(async () => { renderCalls++; return { svg: "<svg>call-" + renderCalls + "</svg>" }; });
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const src = "graph TD; A-->B;";
      const block1 = { textContent: src, innerHTML: "", isConnected: true, classList: { add: () => {} } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block1]) });
      expect(renderCalls).toBe(1);
      expect(block1.innerHTML).toBe("<svg>call-1</svg>");

      // same theme, same source, new node (like a normal 2.5s poll) → cache hit
      const block2 = { textContent: src, innerHTML: "", isConnected: true, classList: { add: () => {} } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block2]) });
      expect(renderCalls).toBe(1); // still a hit — theme unchanged
      expect(block2.innerHTML).toBe("<svg>call-1</svg>");

      // theme changes → SAME source must be a cache MISS, re-rendered
      setMermaidThemeIdForTest("kobo-light-v1");
      const block3 = { textContent: src, innerHTML: "", isConnected: true, classList: { add: () => {} } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block3]) });
      expect(renderCalls).toBe(2); // re-rendered under the new theme
      expect(block3.innerHTML).toBe("<svg>call-2</svg>"); // NOT the old-theme SVG served stale
      expect(createdTags.length).toBe(1); // asset itself is still loaded only once — this is a key change, not a re-fetch
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  // kobo-426 — the debt this closes: invalidation depended on a HUMAN
  // remembering to bump mermaidThemeId whenever MERMAID_THEME_VARIABLES
  // changed; nothing enforced it. This proves the OTHER path: change a theme
  // variable directly, WITHOUT touching mermaidThemeId at all, and the cache
  // must still invalidate for the same source.
  test("kobo-426: changing MERMAID_THEME_VARIABLES invalidates the cache even if mermaidThemeId is never bumped", async () => {
    const { renderMermaidBlocks, setMermaidThemeVariableForTest } = loadMermaidRenderer();
    let renderCalls = 0;
    const { doc, win } = stubEnv(async () => { renderCalls++; return { svg: "<svg>call-" + renderCalls + "</svg>" }; });
    const prevDoc = (globalThis as any).document, prevWin = (globalThis as any).window;
    (globalThis as any).document = doc; (globalThis as any).window = win;
    try {
      const src = "graph TD; A-->B;";
      const block1 = { textContent: src, innerHTML: "", isConnected: true, classList: { add: () => {} } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block1]) });
      expect(renderCalls).toBe(1);

      // same source, new node, mermaidThemeId untouched — only a theme VALUE changed
      setMermaidThemeVariableForTest("background", "#000000");
      const block2 = { textContent: src, innerHTML: "", isConnected: true, classList: { add: () => {} } };
      await renderMermaidBlocks({ querySelectorAll: () => nodeList([block2]) });
      expect(renderCalls).toBe(2); // re-rendered — the old-palette SVG was NOT served stale
      expect(block2.innerHTML).toBe("<svg>call-2</svg>");
    } finally {
      (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin;
    }
  });

  test("kobo-422: mermaid.initialize uses theme:'base' + site-matched themeVariables, not mermaid's default palette", () => {
    expect(html).toContain("theme: 'base'");
    expect(html).toContain("themeVariables: MERMAID_THEME_VARIABLES");
    expect(html).toContain("background: '#0F172A'"); // --bg
    expect(html).toContain("primaryColor: '#1E293B'"); // --surface
    expect(html).toContain("primaryTextColor: '#F8FAFC'"); // --fg
  });

  test("kobo-422: thumbnail CSS shrinks the WHOLE diagram (max-height, no cropping) and signals it's clickable", () => {
    expect(html).toContain(".mermaid-src.mermaid-thumb { cursor:zoom-in; }");
    expect(html).toContain("max-height:120px");
    expect(html).not.toContain("overflow:hidden; }\n    .bubble .body .mermaid-src.mermaid-thumb svg"); // not a crop — the svg's own aspect ratio scales down
  });

  test("kobo-422: modal markup exists (dialog role, close button, backdrop) and starts hidden", () => {
    expect(html).toContain('id="mermaidModal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="mmdModalClose"');
    expect(html).toContain('id="mmdModalContent"');
    expect(html).toContain('class="mmd-modal-backdrop"');
    const modalOpenTag = html.slice(html.indexOf('id="mermaidModal"') - 40, html.indexOf('id="mermaidModal"') + 60);
    expect(modalOpenTag).toContain('style="display:none;"'); // starts hidden
  });

  test("kobo-422: exactly ONE delegated click listener is bound to #thread (survives loadThread's replaceChildren, never re-bound per diagram)", () => {
    const matches = html.match(/\$\('thread'\)\.addEventListener\('click'/g) || [];
    expect(matches.length).toBe(1);
  });

  // kobo-422 — extract the modal functions the same way loadLinkify/
  // loadMermaidRenderer do, with a minimal injected `$` so open/close/delegation
  // are BEHAVIORALLY proven against stub elements, not just grepped.
  function loadMermaidModal(elements: Record<string, any>) {
    const start = html.indexOf("function openMermaidModal");
    const end = html.indexOf("// ── wire", start);
    const src = html.slice(start, end);
    return new Function("$", `${src}; return { openMermaidModal, closeMermaidModal, onThreadClick, dedupeSvgIds };`)((id: string) => elements[id]);
  }
  // kobo-426: openMermaidModal now reads document.activeElement and calls
  // $('mmdModalClose').focus() — every modal test needs a close-button fake
  // and a stubbed global document, or these throw regardless of what they're
  // actually testing.
  function modalElements() {
    const content = { children: [] as any[], replaceChildren(...nodes: any[]) { this.children = nodes; } };
    const modal = { style: { display: "none" } };
    const closeBtn = { focusCalls: 0, focus() { this.focusCalls++; } };
    return { content, modal, closeBtn, mmdModalContent: content, mermaidModal: modal, mmdModalClose: closeBtn };
  }
  function withModalGlobals(activeElement: any, fn: () => void) {
    const prevDoc = (globalThis as any).document;
    (globalThis as any).document = { activeElement };
    try { fn(); } finally { (globalThis as any).document = prevDoc; }
  }

  // kobo-426/513 — minimal fake SVG element with a real attribute API
  // (getAttribute/setAttribute/getAttributeNames/tagName) and
  // querySelectorAll('[id]' | '*'). onThreadClick now ALWAYS runs cloned svg
  // nodes through dedupeSvgIds, so every test that clicks a thumbnail needs
  // an svg stand-in with at least this much of a real API, not just a bare
  // {tag} stub. kobo-513: dedupeSvgIds now walks getAttributeNames() (any
  // attribute, not a fixed list) and checks tagName (to exclude real <a>
  // hyperlinks from id-reference rewriting) — both added here.
  function fakeSvgEl(attrs: Record<string, string> = {}, children: any[] = [], tagName = "g"): any {
    const el: any = {
      _attrs: { ...attrs },
      _children: children,
      tagName,
      getAttribute(name: string) { return name in this._attrs ? this._attrs[name] : null; },
      setAttribute(name: string, val: string) { this._attrs[name] = val; },
      getAttributeNames() { return Object.keys(this._attrs); },
      querySelectorAll(sel: string) {
        const out: any[] = [];
        const walk = (node: any) => {
          for (const c of node._children) {
            if (sel === "*" || (sel === "[id]" && "id" in c._attrs)) out.push(c);
            walk(c);
          }
        };
        walk(el);
        return out;
      },
      cloneNode(deep: boolean) {
        return fakeSvgEl({ ...el._attrs }, deep ? el._children.map((c: any) => c.cloneNode(true)) : [], tagName);
      },
    };
    return el;
  }

  test("kobo-422: openMermaidModal replaceChildren-s the given node into modal content (no innerHTML) and shows the modal", () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { openMermaidModal } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const fakeSvg = { tag: "svg" };
    withModalGlobals({ focus() {} }, () => openMermaidModal(fakeSvg));
    expect(content.children).toEqual([fakeSvg]);
    expect(modal.style.display).toBe("");
  });

  test("kobo-422: closeMermaidModal hides the modal and clears its content", () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    content.children = ["stale" as any];
    modal.style.display = "";
    const { openMermaidModal, closeMermaidModal } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    withModalGlobals({ focus() {} }, () => { openMermaidModal({ tag: "svg" }); closeMermaidModal(); });
    expect(modal.style.display).toBe("none");
    expect(content.children).toEqual([]);
  });

  test("kobo-422: onThreadClick opens the modal with a CLONE of the clicked diagram's svg, not the live thumbnail node", () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { onThreadClick } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const originalSvg = fakeSvgEl({ id: "mmd-1" });
    const thumb = { querySelector: (sel: string) => (sel === "svg" ? originalSvg : null) };
    const target = { closest: (sel: string) => (sel === ".mermaid-thumb" ? thumb : null) };
    withModalGlobals({ focus() {} }, () => onThreadClick({ target }));
    expect(content.children.length).toBe(1);
    expect(content.children[0]).not.toBe(originalSvg); // a CLONE — the live thumbnail node is never moved into the modal
    expect(content.children[0]._attrs.id).not.toBe("mmd-1"); // kobo-426: dedup gives the clone a fresh id
    expect(modal.style.display).toBe("");
  });

  test("kobo-422: onThreadClick is a no-op when the click lands outside any .mermaid-thumb", () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { onThreadClick } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const target = { closest: () => null };
    withModalGlobals({ focus() {} }, () => onThreadClick({ target }));
    expect(content.children).toEqual([]);
    expect(modal.style.display).toBe("none");
  });

  test("kobo-422: onThreadClick is a no-op when the thumb has no <svg> child yet (render still pending)", () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { onThreadClick } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const thumb = { querySelector: () => null };
    const target = { closest: (sel: string) => (sel === ".mermaid-thumb" ? thumb : null) }; // kobo-527: onThreadClick now checks .card-ref-chip first — a selector-blind stub would wrongly match that branch too
    withModalGlobals({ focus() {} }, () => onThreadClick({ target }));
    expect(content.children).toEqual([]);
  });

  // kobo-426: mermaid's rendered SVG carries its own id (the render id) plus
  // internal ids (markers/defs) referenced via url(#...) — cloning it
  // verbatim into the modal while the original stays in #thread put the SAME
  // id twice in the live document at once.
  test("kobo-426: onThreadClick's clone gets a fresh root id — the original thumbnail svg's id is untouched", () => {
    const { content, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { onThreadClick } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const originalSvg = fakeSvgEl({ id: "mmd-3" });
    const thumb = { querySelector: (sel: string) => (sel === "svg" ? originalSvg : null) };
    const target = { closest: (sel: string) => (sel === ".mermaid-thumb" ? thumb : null) };
    withModalGlobals({ focus() {} }, () => onThreadClick({ target }));
    const clone = content.children[0];
    expect(clone.getAttribute("id")).not.toBe(null);
    expect(clone.getAttribute("id")).not.toBe("mmd-3"); // fresh id, not a duplicate
    expect(originalSvg.getAttribute("id")).toBe("mmd-3"); // dedup mutates the CLONE only, never the live original
  });

  test("kobo-426: a marker-end url(#...) reference inside the clone is rewritten to the clone's OWN new marker id, not left pointing at the original", () => {
    const { content, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { onThreadClick } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    const marker = fakeSvgEl({ id: "mmd-3_arrow" });
    const path = fakeSvgEl({ "marker-end": "url(#mmd-3_arrow)" });
    const defs = fakeSvgEl({}, [marker]);
    const originalSvg = fakeSvgEl({ id: "mmd-3" }, [defs, path]);
    const thumb = { querySelector: (sel: string) => (sel === "svg" ? originalSvg : null) };
    const target = { closest: (sel: string) => (sel === ".mermaid-thumb" ? thumb : null) };
    withModalGlobals({ focus() {} }, () => onThreadClick({ target }));
    const clone = content.children[0];
    const [clonedDefs, clonedPath] = clone._children;
    const clonedMarker = clonedDefs._children[0];
    expect(clonedMarker.getAttribute("id")).not.toBe("mmd-3_arrow"); // marker got a fresh id too
    expect(clonedPath.getAttribute("marker-end")).toBe("url(#" + clonedMarker.getAttribute("id") + ")"); // reference follows the SAME new id
    expect(clonedPath.getAttribute("marker-end")).not.toBe("url(#mmd-3_arrow)"); // never left dangling on the old one
  });

  // kobo-513: the previous fixed attribute-name list (fill/stroke/marker-*/
  // clip-path/mask/href) missed filter, inline style, and xlink:href — and a
  // mutation test on kobo-426 proved even a name ALREADY on the list wasn't
  // actually watched (deleting 'href' left every test green). These tests
  // exercise dedupeSvgIds directly (extracted via loadMermaidModal) rather
  // than going through the whole onThreadClick/modal wiring each time.
  function dedupeElements() {
    const { mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    return { mmdModalContent, mermaidModal, mmdModalClose };
  }

  test("kobo-513: a filter=\"url(#id)\" reference is rewritten — not on the old fixed attribute list at all", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const target = fakeSvgEl({ id: "blur1" });
    const shape = fakeSvgEl({ filter: "url(#blur1)" });
    const svg = fakeSvgEl({ id: "root" }, [target, shape]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [clonedTarget, clonedShape] = clone._children;
    expect(clonedShape.getAttribute("filter")).toBe("url(#" + clonedTarget.getAttribute("id") + ")");
  });

  test("kobo-513: an inline style=\"fill:url(#id)\" reference is rewritten — value-pattern matching works inside a style STRING, not just a whole-value attribute", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const grad = fakeSvgEl({ id: "grad1" });
    const shape = fakeSvgEl({ style: "fill:url(#grad1); stroke:#000" });
    const svg = fakeSvgEl({ id: "root" }, [grad, shape]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [clonedGrad, clonedShape] = clone._children;
    expect(clonedShape.getAttribute("style")).toBe("fill:url(#" + clonedGrad.getAttribute("id") + "); stroke:#000");
  });

  test("kobo-513: xlink:href=\"#id\" is rewritten on a non-anchor element (e.g. <use>) — a SEPARATE set entry from href, its own guard", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const orig = fakeSvgEl({ id: "path1" });
    const use = fakeSvgEl({ "xlink:href": "#path1" }, [], "use");
    const svg = fakeSvgEl({ id: "root" }, [orig, use]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [clonedOrig, clonedUse] = clone._children;
    expect(clonedUse.getAttribute("xlink:href")).toBe("#" + clonedOrig.getAttribute("id"));
  });

  test("kobo-513: href=\"#id\" is rewritten on a non-anchor element (e.g. <use>) — a SEPARATE set entry from xlink:href, its own guard", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const orig = fakeSvgEl({ id: "path1" });
    const use = fakeSvgEl({ href: "#path1" }, [], "use");
    const svg = fakeSvgEl({ id: "root" }, [orig, use]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [clonedOrig, clonedUse] = clone._children;
    expect(clonedUse.getAttribute("href")).toBe("#" + clonedOrig.getAttribute("id"));
  });

  test("kobo-513: a brand-new attribute name never seen before, whose value is url(#id), is still handled — no code change needed for an unknown name", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const mask = fakeSvgEl({ id: "mask1" });
    const shape = fakeSvgEl({ "some-future-svg-attribute": "url(#mask1)" });
    const svg = fakeSvgEl({ id: "root" }, [mask, shape]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [clonedMask, clonedShape] = clone._children;
    expect(clonedShape.getAttribute("some-future-svg-attribute")).toBe("url(#" + clonedMask.getAttribute("id") + ")");
  });

  // 🔴 AC — the card's main risk: over-matching, not under-matching. A real
  // hyperlink (<a href="#section-2">, e.g. a table-of-contents jump link
  // somewhere in the document) uses the SAME bare "#id" syntax as an
  // internal SVG reference — it must NEVER be rewritten just because its
  // fragment happens to collide with an id this SVG also has.
  test("kobo-513: a real hyperlink (<a href=\"#...\">) is NEVER rewritten, even when its fragment collides with an id in this SVG", () => {
    const { dedupeSvgIds } = loadMermaidModal(dedupeElements());
    const section = fakeSvgEl({ id: "section-2" }); // an unrelated element that happens to share the fragment's name
    const link = fakeSvgEl({ href: "#section-2" }, [], "a"); // a REAL link, not an id reference
    const svg = fakeSvgEl({ id: "root" }, [section, link]);
    const clone = dedupeSvgIds(svg.cloneNode(true));
    const [, clonedLink] = clone._children;
    expect(clonedLink.getAttribute("href")).toBe("#section-2"); // untouched — real navigation, not an SVG id ref
  });

  // kobo-426 — closes the debt: #mermaidModal is aria-modal="true" (a promise
  // to keyboard/screen-reader users) but nothing moved focus in or back.
  test("kobo-426: openMermaidModal captures the previously-focused element and moves focus to the close button", () => {
    const { closeBtn, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { openMermaidModal } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    withModalGlobals({ focus() {} }, () => openMermaidModal({ tag: "svg" }));
    expect(closeBtn.focusCalls).toBe(1);
  });

  test("kobo-426: closeMermaidModal restores focus to whatever triggered the open (the clicked thumbnail), not just the close button", () => {
    const { mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const { openMermaidModal, closeMermaidModal } = loadMermaidModal({ mmdModalContent, mermaidModal, mmdModalClose });
    let thumbnailFocusCalls = 0;
    const thumbnail = { focus() { thumbnailFocusCalls++; } };
    withModalGlobals(thumbnail, () => { openMermaidModal({ tag: "svg" }); closeMermaidModal(); });
    expect(thumbnailFocusCalls).toBe(1);
  });

  // kobo-422 review (eq3 L1): the markup test above only proves the close
  // button / backdrop / dialog role EXIST — it never proved anything is
  // actually wired to them. loadMermaidModal (above) deliberately stops
  // BEFORE "// ── wire", so calling closeMermaidModal directly (as the two
  // tests above do) would stay green even if all 3 real addEventListener
  // registrations were deleted. This helper instead slices in the modal
  // functions PLUS the exact 4 "// ── wire" lines that bind them (#thread
  // click, #mmdModalClose click, #mermaidModal click, document keydown), then
  // the test below fires each stub element's OWN registered handler — never
  // calling closeMermaidModal by hand — so a removed wiring line fails here.
  function loadMermaidWiring(elements: Record<string, any>, doc: { addEventListener(ev: string, cb: (ev: any) => void): void }) {
    const fnStart = html.indexOf("function openMermaidModal");
    const fnEnd = html.indexOf("// ── wire", fnStart);
    const wireStart = html.indexOf("$('thread').addEventListener('click', onThreadClick)", fnEnd);
    const wireEnd = html.indexOf("$('back').addEventListener", wireStart);
    const src = html.slice(fnStart, fnEnd) + html.slice(wireStart, wireEnd);
    new Function("$", "document", src)((id: string) => elements[id], doc);
  }
  function fakeTarget(extra: Record<string, any> = {}) {
    const listeners: Record<string, ((ev: any) => void)[]> = {};
    return {
      ...extra,
      addEventListener(ev: string, cb: (ev: any) => void) { (listeners[ev] ||= []).push(cb); },
      fire(ev: string, arg: any = {}) { (listeners[ev] || []).forEach((cb) => cb(arg)); },
    };
  }

  test("kobo-422 L1: all 4 modal-close paths (close button, self click, backdrop click, Escape keydown) are wired to the REAL listener, not just present in markup", () => {
    const content = { children: [] as any[], replaceChildren(...nodes: any[]) { this.children = nodes; } };
    const mermaidModal = fakeTarget({ style: { display: "none" } });
    const mmdModalClose = fakeTarget();
    const doc = fakeTarget();
    loadMermaidWiring({ mmdModalContent: content, mermaidModal, mmdModalClose, thread: fakeTarget() }, doc);

    const reset = () => { mermaidModal.style.display = ""; content.children = ["x" as any]; };
    const assertClosed = () => {
      expect(mermaidModal.style.display).toBe("none");
      expect(content.children).toEqual([]);
    };

    reset();
    mmdModalClose.fire("click"); // path 1: the close button
    assertClosed();

    reset();
    mermaidModal.fire("click", { target: { id: "mermaidModal", classList: { contains: () => false } } }); // path 2: click on the modal itself (id match)
    assertClosed();

    // path 3: click on the backdrop — the real .mmd-modal-backdrop div has NO
    // id (it's position:absolute; inset:0 over the whole overlay), so a real
    // click here always has target.id === "" and only the classList branch
    // saves it. A prior version of this test only ever exercised the id
    // branch, so a deleted classList.contains(...) clause stayed green.
    reset();
    mermaidModal.fire("click", { target: { id: "", classList: { contains: (c: string) => c === "mmd-modal-backdrop" } } });
    assertClosed();

    reset();
    doc.fire("keydown", { key: "Escape" }); // path 4: Escape key
    assertClosed();
  });

  // kobo-438: closed/merged rooms hide by default (Tony reversed kobo-379's
  // "show it, just gray it out"); a toggle button is the only way back. Extract
  // the real client-side state + renderRoomList/statusClass/statusDot the same
  // way loadMermaidModal does above — a fake `document` backs `el()`/`$()` (both
  // called by the real source), and a fake `location` covers the module-scope
  // `new URLSearchParams(location.search)` read at load time (unused here —
  // setRooms/setShowClosed below override the initial state directly).
  function fakeRoomListEl() {
    return {
      className: "", textContent: "", tabIndex: 0,
      children: [] as any[],
      classList: { toggle(_cls: string, _on: boolean) {} },
      appendChild(child: any) { this.children.push(child); },
      addEventListener() {},
    };
  }
  // kobo-438 review (eq3 M6): the toggle stub also captures addEventListener,
  // and the extracted source is concatenated with the REAL "// ── wire" line
  // that binds it — so a test can fire toggle.fire('click') and prove the
  // actual wiring works, the same way kobo-422's L1 fires a stub instead of
  // calling closeMermaidModal directly (calling the handler by hand would
  // stay green even if the addEventListener call itself were deleted).
  function loadRoomList() {
    const box = { children: [] as any[], replaceChildren(...nodes: any[]) { this.children = nodes; }, appendChild(n: any) { this.children.push(n); } };
    const toggleListeners: Record<string, ((ev: any) => void)[]> = {};
    const toggle = {
      textContent: "", classList: { active: false, toggle(cls: string, on: boolean) { if (cls === "active") this.active = on; } },
      addEventListener(ev: string, cb: (ev: any) => void) { (toggleListeners[ev] ||= []).push(cb); },
      fire(ev: string, arg: any = {}) { (toggleListeners[ev] || []).forEach((cb) => cb(arg)); },
    };
    const doc = {
      getElementById: (id: string) => (id === "roomlist" ? box : id === "roomFilterToggle" ? toggle : fakeRoomListEl()),
      createElement: (tag: string) => ({ tag, className: "", textContent: "", children: [] as any[], appendChild(c: any) { this.children.push(c); }, addEventListener() {} }),
    };
    const fnStart = html.indexOf("const $ = (id) =>");
    const fnEnd = html.indexOf("function selectRoom");
    const wireStart = html.indexOf("$('roomFilterToggle').addEventListener('click'", fnEnd);
    const wireEnd = html.indexOf("$('send').addEventListener", wireStart);
    const src = html.slice(fnStart, fnEnd) + html.slice(wireStart, wireEnd);
    const api = new Function(
      "document", "location", "newTopic",
      `${src}
      return {
        renderRoomList, statusClass, statusDot,
        setRooms: (v) => { rooms = v; },
        setShowClosed: (v) => { showClosed = v; },
      };`,
    )(doc, { search: "" }, () => {});
    return { ...api, box, toggle };
  }
  const room = (id: string, status: string) => ({ id, topic: id, status });

  test("kobo-438: the room list shows ONLY open rooms by default (closed/merged hidden)", () => {
    const { renderRoomList, setRooms, box } = loadRoomList();
    setRooms([room("a", "open"), room("b", "closed"), room("c", "merged"), room("d", "open")]);
    renderRoomList();
    expect(box.children.length).toBe(2);
  });

  test("kobo-438: toggling reveals BOTH closed and merged rooms, and toggling back hides them again", () => {
    const { renderRoomList, setRooms, setShowClosed, box } = loadRoomList();
    setRooms([room("a", "open"), room("b", "closed"), room("c", "merged")]);
    renderRoomList();
    expect(box.children.length).toBe(1);
    setShowClosed(true);
    renderRoomList();
    expect(box.children.length).toBe(3);
    setShowClosed(false);
    renderRoomList();
    expect(box.children.length).toBe(1);
  });

  test("kobo-438: the toggle button's count is closed+merged together and EXACTLY matches how many rows toggling reveals — never just `closed`", () => {
    const { renderRoomList, setRooms, setShowClosed, box, toggle } = loadRoomList();
    setRooms([room("a", "open"), room("b", "closed"), room("c", "closed"), room("d", "merged")]);
    renderRoomList();
    expect(toggle.textContent).toContain("(3)"); // 2 closed + 1 merged, not just the 2 closed
    const hiddenCountShown = Number(toggle.textContent.match(/\((\d+)\)/)![1]);
    setShowClosed(true);
    renderRoomList();
    const revealedCount = box.children.length - 1; // minus the 1 open room
    expect(revealedCount).toBe(hiddenCountShown);
  });

  test("kobo-438: the toggle label names BOTH states it hides, never just \"closed\" (a merged-room hunter won't click a button that says only closed)", () => {
    const { renderRoomList, setRooms, toggle } = loadRoomList();
    setRooms([room("a", "open"), room("b", "merged")]);
    renderRoomList();
    expect(toggle.textContent).toContain("ปิด");
    expect(toggle.textContent).toContain("รวมแล้ว");
  });

  test("kobo-438: with zero closed/merged rooms, the toggle still states its count (0) — it never disappears or goes blank", () => {
    const { renderRoomList, setRooms, toggle } = loadRoomList();
    setRooms([room("a", "open")]);
    renderRoomList();
    expect(toggle.textContent.length).toBeGreaterThan(0);
    expect(toggle.textContent).toContain("(0)");
  });

  test("kobo-438: a room that gets closed re-renders out of the open list on the very next render — no manual refresh needed", () => {
    const { renderRoomList, setRooms, box } = loadRoomList();
    setRooms([room("a", "open"), room("b", "open")]);
    renderRoomList();
    expect(box.children.length).toBe(2);
    setRooms([room("a", "open"), room("b", "closed")]); // "b" just got closed
    renderRoomList();
    expect(box.children.length).toBe(1);
  });

  test("kobo-438: all rooms hidden by the filter (rooms exist, none open) shows a distinct message — never the \"no rooms yet, start one\" empty state", () => {
    const { renderRoomList, setRooms, box } = loadRoomList();
    setRooms([room("a", "closed")]);
    renderRoomList();
    expect(box.children.length).toBe(1);
    const emptyText = box.children[0].children.map((c: any) => c.textContent).join("");
    expect(emptyText).toContain("กดปุ่มด้านบน"); // the guiding message must actually be there, not just "not the other one"
    expect(emptyText).not.toContain("เปิดหัวข้อแรก"); // the truly-empty-company message
  });

  // kobo-438 review (eq3 M6): calling setShowClosed/renderRoomList directly (as
  // the tests above do) proves the FILTER logic but never proves the button is
  // actually wired to it — a deleted "// ── wire" addEventListener call would
  // leave every test above green. Firing the stub's own registered handler
  // (never touching setShowClosed) closes that gap.
  test("kobo-438 M6: clicking the toggle button (the REAL wire, never the setShowClosed helper) reveals then re-hides closed/merged rooms", () => {
    const { renderRoomList, setRooms, box, toggle } = loadRoomList();
    setRooms([room("a", "open"), room("b", "closed"), room("c", "merged")]);
    renderRoomList();
    expect(box.children.length).toBe(1); // default: open only
    toggle.fire("click");
    expect(box.children.length).toBe(3); // click revealed closed + merged
    toggle.fire("click");
    expect(box.children.length).toBe(1); // click again hides them
  });

  test("kobo-438: the toggle button sits directly between the topics header and the room list — never nested in a menu/dropdown a user has to open first", () => {
    const headIdx = html.indexOf('id="topicsHead"');
    const toggleIdx = html.indexOf('id="roomFilterToggle"');
    const listIdx = html.indexOf('id="roomlist"');
    expect(headIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeGreaterThan(headIdx);
    expect(listIdx).toBeGreaterThan(toggleIdx);
    expect(html).toContain("#roomFilterToggle { display:block"); // always rendered, never display:none by default
  });

  test("kobo-380: isSafeUrl allowlists http/https only", () => {
    const { isSafeUrl } = loadLinkify();
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("https://example.com/path?x=1")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
  });

  test("kobo-380: a <script>/javascript: payload renders INERT — only a real http(s) URL becomes a real <a>", () => {
    const stubDoc = {
      createTextNode: (text: string) => ({ kind: "text", text }),
      createElement: (tag: string) => ({ kind: "el", tag, textContent: "", href: "", target: "", rel: "" }),
    };
    const prevDoc = (globalThis as any).document;
    (globalThis as any).document = stubDoc;
    try {
      const { linkify } = loadLinkify();
      const container = { nodes: [] as any[], appendChild(n: any) { this.nodes.push(n); } };
      linkify(container, "see http://example.com/x and <script>alert(1)</script> also javascript:alert(2)");
      const anchors = container.nodes.filter((n) => n.kind === "el" && n.tag === "a");
      expect(anchors.length).toBe(1);
      expect(anchors[0].href).toBe("http://example.com/x");
      expect(anchors[0].textContent).toBe("http://example.com/x");
      const text = container.nodes.filter((n) => n.kind === "text").map((n) => n.text).join("");
      expect(text).toContain("<script>alert(1)</script>"); // literal text, never parsed as markup
      expect(text).toContain("javascript:alert(2)"); // rejected protocol → inert text, never an href
    } finally {
      if (prevDoc === undefined) delete (globalThis as any).document; else (globalThis as any).document = prevDoc;
    }
  });

  // kobo-527 — "kobo-N" card refs in message text → clickable chip that opens
  // the card in the shared #mermaidModal instance. kobo-513 lesson applied:
  // the main risk is OVER-matching (this room pastes card numbers in URLs and
  // code blocks constantly), so these tests target that risk directly with
  // the hardest cases, not just the happy path.
  function loadCardLinkify() {
    const start = html.indexOf("const CARD_REF_RE");
    const end = html.indexOf("function cardLinkifyDom", start);
    const src = html.slice(start, end);
    return new Function(`${src}; return { cardLinkify };`)();
  }
  function loadCardLinkifyDom() {
    const start = html.indexOf("const CARD_REF_RE");
    const end = html.indexOf("async function openCardModal", start);
    const src = html.slice(start, end);
    return new Function(`${src}; return { cardLinkify, cardLinkifyDom };`)();
  }
  function stubCardDoc() {
    return {
      createTextNode: (text: string) => ({ kind: "text", text }),
      createElement: (tag: string) => ({ kind: "el", tag, textContent: "", className: "", _attrs: {} as Record<string, string>, setAttribute(n: string, v: string) { this._attrs[n] = v; } }),
    };
  }
  function withCardGlobals(companyVal: string, fn: () => void) {
    const prevDoc = (globalThis as any).document;
    const prevCompany = (globalThis as any).company;
    (globalThis as any).document = stubCardDoc();
    (globalThis as any).company = companyVal;
    try { fn(); } finally {
      (globalThis as any).document = prevDoc;
      if (prevCompany === undefined) delete (globalThis as any).company; else (globalThis as any).company = prevCompany;
    }
  }

  test("kobo-527: a card ref matching the CURRENT company becomes a clickable chip (button, not <a> — no real navigation target)", () => {
    withCardGlobals("kobo", () => {
      const { cardLinkify } = loadCardLinkify();
      const container = { nodes: [] as any[], appendChild(n: any) { this.nodes.push(n); } };
      cardLinkify(container, "see kobo-9 for detail");
      const chips = container.nodes.filter((n) => n.kind === "el" && n.tag === "button");
      expect(chips.length).toBe(1);
      expect(chips[0].textContent).toBe("kobo-9");
      expect(chips[0].className).toContain("card-ref-chip");
      expect(chips[0]._attrs["data-card-id"]).toBe("kobo-9");
    });
  });

  test("kobo-527 Q3 (narrow to same company first): a DIFFERENT company's card id never becomes a chip", () => {
    withCardGlobals("kobo", () => {
      const { cardLinkify } = loadCardLinkify();
      const container = { nodes: [] as any[], appendChild(n: any) { this.nodes.push(n); } };
      cardLinkify(container, "see eq3-9 and mawjs-3, not our card");
      expect(container.nodes.filter((n) => n.kind === "el" && n.tag === "button").length).toBe(0);
      const text = container.nodes.filter((n) => n.kind === "text").map((n: any) => n.text).join("");
      expect(text).toContain("eq3-9");
      expect(text).toContain("mawjs-3");
    });
  });

  test("kobo-527: no company selected yet → never linkifies (defensive — nothing to scope the match to)", () => {
    withCardGlobals("", () => {
      const { cardLinkify } = loadCardLinkify();
      const container = { nodes: [] as any[], appendChild(n: any) { this.nodes.push(n); } };
      cardLinkify(container, "kobo-9");
      expect(container.nodes.filter((n) => n.kind === "el" && n.tag === "button").length).toBe(0);
    });
  });

  // kobo-513 pattern: over-match is the real risk, not under-match. A trailing
  // word char blocks the match entirely (no partial chip on "kobo-9x"), and a
  // token that merely LOOKS like <company>-N ("prekobo-9") is correctly
  // rejected by the company check even though the shape matched.
  test("kobo-527 (kobo-513 pattern, hardest case): word-boundary + company check both hold under adjacent text", () => {
    withCardGlobals("kobo", () => {
      const { cardLinkify } = loadCardLinkify();
      const container = { nodes: [] as any[], appendChild(n: any) { this.nodes.push(n); } };
      cardLinkify(container, "(kobo-9), kobo-9x, prekobo-9 done");
      const chips = container.nodes.filter((n) => n.kind === "el" && n.tag === "button");
      expect(chips.length).toBe(1); // only the clean "(kobo-9)" occurrence
      expect(chips[0].textContent).toBe("kobo-9");
      const text = container.nodes.filter((n) => n.kind === "text").map((n: any) => n.text).join("");
      expect(text).toContain("kobo-9x"); // trailing word-char blocks the match — never a partial chip
      expect(text).toContain("prekobo-9"); // shape matched, prefix didn't — stays plain text
    });
  });

  function fakeTreeWalker(nodes: any[]) {
    let i = 0;
    return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
  }
  function fakeTextNode(data: string, parentElement: any) {
    const node: any = { data, parentElement, replacedWith: null };
    node.replaceWith = (frag: any) => { node.replacedWith = frag; };
    return node;
  }
  function fakeParent(closestTags: Record<string, boolean>) {
    return { closest: (sel: string) => (closestTags[sel] ? { tag: sel } : null) };
  }

  // kobo-537 — linkifyDom (kobo-380) has the SAME shape of skip guard as
  // kobo-527's cardLinkifyDom, and room.ts has BOTH of them as
  // byte-identical lines (`if (p && (p.closest('a') || p.closest('code') ||
  // p.closest('pre'))) continue;`) at two different line numbers — one per
  // function. A text-based mutation/replace targeting "the guard line"
  // can't tell which one it hit; two separate mutation attempts on this
  // exact card already landed on the WRONG one by accident (one broke
  // linkifyDom while meaning to test cardLinkifyDom; the other's fix
  // pattern deleted the wrong occurrence entirely and reported a false
  // "0 fail", which would have wrongly closed cardLinkifyDom's real guard
  // as unwatched). This extraction is anchored on the UNIQUE function-name
  // boundaries (const URL_RE ... const CARD_REF_RE), never on the guard
  // text itself, specifically so it can only ever touch linkifyDom.
  function loadLinkifyDomIsolated() {
    const start = html.indexOf("const URL_RE =");
    const end = html.indexOf("const CARD_REF_RE", start);
    const src = html.slice(start, end);
    // kobo-537: confirm at load time — from the ACTUALLY SERVED string, not
    // by assumption — that this slice contains linkifyDom's guard exactly
    // once and contains NONE of cardLinkifyDom (name, guard, or otherwise).
    // If a future edit moves code across this boundary, this throws instead
    // of silently testing the wrong (or an empty) function.
    if ((src.match(/p\.closest\('a'\) \|\| p\.closest\('code'\) \|\| p\.closest\('pre'\)/g) || []).length !== 1) {
      throw new Error("kobo-537: expected exactly ONE code/pre/a guard line in the linkifyDom-only slice");
    }
    if (src.includes("cardLinkifyDom") || src.includes("CARD_REF_RE")) {
      throw new Error("kobo-537: linkifyDom extraction slice leaked cardLinkifyDom content — boundary drifted");
    }
    return new Function(`${src}; return { linkify, linkifyDom };`)();
  }

  // AC (two-way risk): removing the skip must go red (below), AND a URL in
  // ORDINARY message text must still become a real link — a guard that's
  // too broad (e.g. accidentally skipping plain text too) would pass the
  // regression test below while silently breaking every normal URL.
  test("kobo-537: linkifyDom still turns a bare URL in ordinary message text into a real <a> (not inside code/pre/a)", () => {
    const prevDoc = (globalThis as any).document;
    const prevNF = (globalThis as any).NodeFilter;
    (globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
    const plainNode = fakeTextNode("see http://example.com/x for detail", fakeParent({}));
    (globalThis as any).document = {
      createTreeWalker: () => fakeTreeWalker([plainNode]),
      createDocumentFragment: () => ({ kind: "frag", children: [] as any[], appendChild(c: any) { this.children.push(c); } }),
      createTextNode: (t: string) => ({ kind: "text", text: t }),
      createElement: (tag: string) => ({ kind: "el", tag, textContent: "", href: "", target: "", rel: "" }),
    };
    try {
      const { linkifyDom } = loadLinkifyDomIsolated();
      linkifyDom({});
      expect(plainNode.replacedWith).not.toBe(null);
      const anchors = plainNode.replacedWith.children.filter((c: any) => c.kind === "el" && c.tag === "a");
      expect(anchors.length).toBe(1);
      expect(anchors[0].href).toBe("http://example.com/x");
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).NodeFilter = prevNF;
    }
  });

  // kobo-513's actual review finding was exactly this shape: a mutation test
  // proved the string was there but nothing was WATCHING it stay correct —
  // for linkifyDom, NOTHING watched it at all until this card. This drives
  // real text nodes through the real TreeWalker-walk + skip logic (not just
  // a grep for the skip condition), so deleting the skip from linkifyDom
  // specifically (not its cardLinkifyDom lookalike) fails this test.
  // VERIFIED [mutation: deleted this exact line from linkifyDom only (by
  // position, not text — cardLinkifyDom's copy left untouched), confirmed
  // THIS test goes red and no other test does, restored, confirmed green].
  test("kobo-537 (kobo-513 pattern): linkifyDom skips text already inside <a>/<code>/<pre> — a URL pasted inside a code block must NOT become a link", () => {
    const prevDoc = (globalThis as any).document;
    const prevNF = (globalThis as any).NodeFilter;
    (globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
    const plainNode = fakeTextNode("see http://example.com/x for detail", fakeParent({}));
    const inLinkNode = fakeTextNode("http://example.com/y", fakeParent({ a: true }));
    const inCodeNode = fakeTextNode("http://example.com/z", fakeParent({ code: true })); // the exact risk this card exists for
    const inPreNode = fakeTextNode("http://example.com/w", fakeParent({ pre: true }));
    const nodes = [plainNode, inLinkNode, inCodeNode, inPreNode];
    (globalThis as any).document = {
      createTreeWalker: () => fakeTreeWalker(nodes),
      createDocumentFragment: () => ({ kind: "frag", children: [] as any[], appendChild(c: any) { this.children.push(c); } }),
      createTextNode: (t: string) => ({ kind: "text", text: t }),
      createElement: (tag: string) => ({ kind: "el", tag, textContent: "", href: "", target: "", rel: "" }),
    };
    try {
      const { linkifyDom } = loadLinkifyDomIsolated();
      linkifyDom({});
      expect(plainNode.replacedWith).not.toBe(null); // only the plain node was touched
      expect(inLinkNode.replacedWith).toBe(null);
      expect(inCodeNode.replacedWith).toBe(null); // AC: a code-block URL must stay inert text
      expect(inPreNode.replacedWith).toBe(null);
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).NodeFilter = prevNF;
    }
  });

  // kobo-513's actual review finding was exactly this shape: a mutation test
  // proved the string was there but nothing was WATCHING it stay correct.
  // This drives real text nodes through the real TreeWalker-walk + skip logic
  // (not just a grep for the skip condition), so deleting the skip, or
  // running cardLinkifyDom before linkifyDom, fails this test.
  test("kobo-527 (kobo-513 pattern): cardLinkifyDom skips text already inside <a>/<code>/<pre> — the exact over-match risk this room hits daily (card # pasted inside a URL or code block)", () => {
    const prevDoc = (globalThis as any).document;
    const prevNF = (globalThis as any).NodeFilter;
    const prevCompany = (globalThis as any).company;
    (globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
    (globalThis as any).company = "kobo";
    const plainNode = fakeTextNode("see kobo-9 for detail", fakeParent({}));
    const inLinkNode = fakeTextNode("kobo-9", fakeParent({ a: true })); // e.g. inside a URL that happens to contain the card id
    const inCodeNode = fakeTextNode("kobo-9", fakeParent({ code: true }));
    const inPreNode = fakeTextNode("kobo-9", fakeParent({ pre: true }));
    const nodes = [plainNode, inLinkNode, inCodeNode, inPreNode];
    (globalThis as any).document = {
      createTreeWalker: () => fakeTreeWalker(nodes),
      createDocumentFragment: () => ({ kind: "frag", children: [] as any[], appendChild(c: any) { this.children.push(c); } }),
      createTextNode: (t: string) => ({ kind: "text", text: t }),
      createElement: (tag: string) => ({ kind: "el", tag, textContent: "", className: "", _attrs: {} as Record<string, string>, setAttribute(n: string, v: string) { this._attrs[n] = v; } }),
    };
    try {
      const { cardLinkifyDom } = loadCardLinkifyDom();
      cardLinkifyDom({}); // the fake TreeWalker ignores the root arg
      expect(plainNode.replacedWith).not.toBe(null); // only the plain node was touched
      expect(inLinkNode.replacedWith).toBe(null);
      expect(inCodeNode.replacedWith).toBe(null);
      expect(inPreNode.replacedWith).toBe(null);
      const chipsInPlain = plainNode.replacedWith.children.filter((c: any) => c.kind === "el" && c.tag === "button");
      expect(chipsInPlain.length).toBe(1); // and the plain one actually got a real chip, not just "was touched"
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).NodeFilter = prevNF;
      if (prevCompany === undefined) delete (globalThis as any).company; else (globalThis as any).company = prevCompany;
    }
  });

  test("kobo-527: card-ref chips run AFTER url linkify in the message render path (so a card # already wrapped in <a> by URL linkify is never double-linked)", () => {
    const linkifyIdx = html.indexOf("linkifyDom(bodyEl)");
    const cardLinkifyIdx = html.indexOf("cardLinkifyDom(bodyEl)");
    expect(linkifyIdx).toBeGreaterThan(-1);
    expect(cardLinkifyIdx).toBeGreaterThan(linkifyIdx);
  });

  test("kobo-527: clicking a card-ref chip opens the card in the SAME shared modal (no second modal instance)", async () => {
    const { content, modal, mmdModalContent, mermaidModal, mmdModalClose } = modalElements();
    const prevDoc = (globalThis as any).document;
    const prevCompany = (globalThis as any).company;
    const prevEl = (globalThis as any).el;
    const prevGetJson = (globalThis as any).getJson;
    (globalThis as any).document = { activeElement: { focus() {} } };
    (globalThis as any).company = "kobo";
    (globalThis as any).el = (tag: string, cls?: string, txt?: string) => ({ tag, cls, textContent: txt, children: [] as any[], appendChild(c: any) { this.children.push(c); } });
    (globalThis as any).getJson = async () => ({ body: { ok: true, task: { id: "kobo-9", title: "fix thing", state: "in-progress", assignee: "stitch" } } });
    try {
      const start = html.indexOf("const CARD_REF_RE");
      const end = html.indexOf("// ── wire", start);
      const src = html.slice(start, end);
      const { onThreadClick } = new Function("$", `${src}; return { onThreadClick };`)((id: string) => ({ mmdModalContent, mermaidModal, mmdModalClose }[id]));
      const chip = { getAttribute: (n: string) => (n === "data-card-id" ? "kobo-9" : null) };
      const target = { closest: (sel: string) => (sel === ".card-ref-chip" ? chip : null) };
      await onThreadClick({ target });
      expect(content.children.length).toBe(1); // populated the SAME #mermaidModal content slot the diagram zoom uses
      expect(modal.style.display).toBe(""); // and it's actually shown
    } finally {
      (globalThis as any).document = prevDoc;
      if (prevCompany === undefined) delete (globalThis as any).company; else (globalThis as any).company = prevCompany;
      if (prevEl === undefined) delete (globalThis as any).el; else (globalThis as any).el = prevEl;
      if (prevGetJson === undefined) delete (globalThis as any).getJson; else (globalThis as any).getJson = prevGetJson;
    }
  });

  test("room data routes stay auth-protected (loopback bypasses, LAN must auth) — Rule 6", () => {
    expect(isProtected("/rooms", "GET")).toBe(true); // kobo-258: topic list is company-internal
    expect(isProtected("/room/thread", "GET")).toBe(true); // private conversation (kobo-241)
    expect(isProtected("/room/send", "POST")).toBe(true);
    expect(isProtected("/room/merge", "POST")).toBe(true);
    expect(isProtected("/room", "GET")).toBe(false); // the /room VIEW itself stays public read
  });

  test("kobo-397: paste + drag-drop upload wiring reuses the EXISTING /api/upload (no invented endpoint)", () => {
    expect(html).toContain("fetch('/api/upload'");
    expect(html).toContain("function uploadImage");
    expect(html).toContain("function onComposePaste");
    expect(html).toContain("function onComposeDrop");
    expect(html).toContain("addEventListener('paste', onComposePaste)");
    expect(html).toContain("addEventListener('drop', onComposeDrop)");
  });

  test("kobo-397: the inserted ref is the SAME maw://<node>/<file> format notes use (no invented scheme)", () => {
    expect(html).toContain("'maw://local/' + filename");
  });

  test("kobo-397: >10MB / bad-mime errors are surfaced as an ACTIONABLE message, not a dead end (lead heads-up)", () => {
    expect(html).toContain("try cropping or resizing the image first"); // 413 → a concrete way out
    expect(html).toContain("can't upload this file type"); // 415 → names what's wrong, server names what IS accepted
  });

  // kobo-415 AC8 — the card's OWN user story ("banner says decided at #12, reader
  // scrolls to #12, finds it") had nothing guarding it. Everything else on this card
  // (counter, fail-loud, batching) is machinery in service of this one clause.
  // Same extract-and-eval technique as loadMermaidRenderer/loadLinkify above, extended
  // to loadThread itself: a fake document/location/fetch on globalThis (restored in
  // finally, same pattern as the mermaid stubEnv tests), because this template has no
  // real DOM available in this test runner.
  function loadThreadEnv() {
    const start = html.indexOf("const $ = (id) => document.getElementById(id);");
    const end = html.indexOf("// ── compose / send", start);
    const src = html.slice(start, end);
    // updateRoomControls lives past the slice end (it's compose-area logic, not part of
    // the rendering/anchor path this test cares about) — a no-op stub satisfies the
    // reference without pulling in the compose section's own DOM dependencies.
    return new Function(`${src}\nfunction updateRoomControls(){}\nreturn { loadThread };`)();
  }
  function fakeRoomDoc() {
    const registry: Record<string, any> = {};
    function makeEl(tag: string) {
      const e: any = {
        tag, className: "", textContent: "", style: {}, disabled: false, value: "",
        scrollTop: 0, scrollHeight: 0, clientHeight: 0,
        _children: [] as any[], _scrolledIntoView: false,
        appendChild(c: any) { e._children.push(c); return c; },
        replaceChildren(...cs: any[]) { e._children = cs; },
        scrollIntoView() { e._scrolledIntoView = true; },
        querySelectorAll: () => nodeList([]), // no mermaid blocks in these fixtures
      };
      Object.defineProperty(e, "id", {
        get() { return e._id || ""; },
        set(v: string) { e._id = v; if (v) registry[v] = e; }, // registers so getElementById(hash) can find a just-rendered anchor
      });
      return e;
    }
    // Static template ids — these exist in the real served page's HTML shell, not created
    // dynamically, so they're pre-seeded. Anything ELSE must come from a real createElement
    // + .id assignment (via `registry`) or getElementById must return null/undefined, same
    // as a real DOM — otherwise a lookup for a NON-existent anchor silently auto-vivifies a
    // placeholder that "finds" and "scrolls" successfully, which is a test that cannot fail.
    const known: Record<string, any> = {};
    for (const staticId of ["thread", "banner", "hTopic", "hSub", "activity", "closeBtn", "text", "send"]) {
      known[staticId] = makeEl("div");
      known[staticId].id = staticId;
    }
    const doc = {
      createElement: makeEl,
      createDocumentFragment: () => makeEl("#fragment"),
      // linkifyDom walks real text nodes via TreeWalker — these fixtures never build real
      // text nodes (textContent is a plain string), so nextNode:null is a no-op walk. This
      // test isn't about linkify; it just needs loadThread to run to completion.
      createTreeWalker: () => ({ nextNode: () => null }),
      getElementById(id: string) {
        return registry[id] ?? known[id] ?? null;
      },
    };
    return doc;
  }
  function fakeFetchFor(room: any) {
    return async (url: string) => {
      if (url.includes("/api/room/thread")) return { status: 200, json: async () => ({ ok: true, room }) };
      if (url.includes("/api/room/activity")) return { status: 200, json: async () => ({ ok: true, participants: [] }) };
      return { status: 404, json: async () => ({}) };
    };
  }
  function withRoomGlobals(doc: any, search: string, hash: string, room: any, fn: () => Promise<void>) {
    const prevDoc = (globalThis as any).document, prevLoc = (globalThis as any).location, prevFetch = (globalThis as any).fetch, prevNF = (globalThis as any).NodeFilter;
    (globalThis as any).document = doc;
    (globalThis as any).location = { search, hash };
    (globalThis as any).fetch = fakeFetchFor(room);
    (globalThis as any).NodeFilter = { SHOW_TEXT: 4 };
    return fn().finally(() => {
      (globalThis as any).document = prevDoc; (globalThis as any).location = prevLoc; (globalThis as any).fetch = prevFetch; (globalThis as any).NodeFilter = prevNF;
    });
  }

  test("kobo-415 AC8: #N renders + msg-N anchor id lands on the RIGHT message (not array position)", async () => {
    const room = { id: "r1", topic: "r1", status: "open", participants: [], messages: [
      { id: "m1", from: "a", text: "first", ts: 1, seq: 7 },
      { id: "m2", from: "b", text: "second", ts: 2, seq: 12 },
    ] };
    const doc = fakeRoomDoc();
    await withRoomGlobals(doc, "?company=kobo&room=r1", "", room, async () => {
      const { loadThread } = loadThreadEnv();
      await loadThread();
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget loadActivity() call settle before cleanup restores document
      const thread = doc.getElementById("thread");
      expect(thread._children.map((b: any) => b.id)).toEqual(["msg-7", "msg-12"]); // the actual seq, not 0/1
      const seqTexts = thread._children.map((b: any) => b._children[0]._children[2].textContent); // bubble > head > 3rd span (seqno)
      expect(seqTexts).toEqual(["#7", "#12"]);
    });
  });

  test("kobo-415 AC8: a #msg-N hash scrolls to that anchor once the render lands (native jump can't — node didn't exist yet)", async () => {
    const room = { id: "r1", topic: "r1", status: "open", participants: [], messages: [
      { id: "m1", from: "a", text: "x", ts: 1, seq: 3 },
      { id: "m2", from: "b", text: "y", ts: 2, seq: 9 },
    ] };
    const doc = fakeRoomDoc();
    await withRoomGlobals(doc, "?company=kobo&room=r1", "#msg-9", room, async () => {
      const { loadThread } = loadThreadEnv();
      await loadThread();
      await new Promise((r) => setTimeout(r, 0));
      expect(doc.getElementById("msg-9")._scrolledIntoView).toBe(true);
      expect(doc.getElementById("msg-3")._scrolledIntoView).toBe(false); // only the targeted message, not every message
    });
  });

  test("kobo-415: an empty room renders its empty state without throwing (backfill/view both no-op on zero messages)", async () => {
    const room = { id: "r1", topic: "r1", status: "open", participants: [], messages: [] };
    const doc = fakeRoomDoc();
    await withRoomGlobals(doc, "?company=kobo&room=r1", "", room, async () => {
      const { loadThread } = loadThreadEnv();
      await expect(loadThread()).resolves.toBeUndefined(); // no throw
      await new Promise((r) => setTimeout(r, 0));
      expect(doc.getElementById("thread")._children.length).toBe(1); // the empty-state placeholder, nothing else
    });
  });

  // kobo-486 — loadThread rebuilt the whole thread DOM every 2.5s poll even
  // when nothing had changed (measured live: 9 rebuilds in ~15.5s on an idle
  // room, ForcedReflow/DOMSize hot path). The fix must call
  // thread.replaceChildren() at most once per genuine change — but per the
  // card's own AC ordering, "a new message must still show up" beats "avoid
  // an unnecessary rebuild": these two tests assert the capability in both
  // directions, not a timing number (kobo-476's own lesson: measure
  // behavior, not ms).
  test("kobo-486: an unchanged room (same message count + last seq) skips the rebuild on the next poll", async () => {
    const room = { id: "r1", topic: "r1", status: "open", participants: [], messages: [
      { id: "m1", from: "a", text: "first", ts: 1, seq: 7 },
    ] };
    const doc = fakeRoomDoc();
    await withRoomGlobals(doc, "?company=kobo&room=r1", "", room, async () => {
      const { loadThread } = loadThreadEnv();
      await loadThread();
      await new Promise((r) => setTimeout(r, 0));
      const thread = doc.getElementById("thread");
      let replaceCount = 0;
      const origReplaceChildren = thread.replaceChildren.bind(thread);
      thread.replaceChildren = (...cs: any[]) => { replaceCount++; origReplaceChildren(...cs); };

      await loadThread(); // same room object, nothing mutated — simulates the next 2.5s poll
      await new Promise((r) => setTimeout(r, 0));

      expect(replaceCount).toBe(0); // no-op poll must not touch the DOM at all
      expect(thread._children.map((b: any) => b.id)).toEqual(["msg-7"]); // and the existing render is untouched, not lost
    });
  });

  test("kobo-486: a new message still forces the rebuild on the very next poll (AC: never hide a real message)", async () => {
    const room: any = { id: "r1", topic: "r1", status: "open", participants: [], messages: [
      { id: "m1", from: "a", text: "first", ts: 1, seq: 7 },
    ] };
    const doc = fakeRoomDoc();
    await withRoomGlobals(doc, "?company=kobo&room=r1", "", room, async () => {
      const { loadThread } = loadThreadEnv();
      await loadThread();
      await new Promise((r) => setTimeout(r, 0));

      room.messages = [...room.messages, { id: "m2", from: "b", text: "second", ts: 2, seq: 8 }];
      await loadThread(); // next poll — a real new message arrived
      await new Promise((r) => setTimeout(r, 0));

      const thread = doc.getElementById("thread");
      expect(thread._children.map((b: any) => b.id)).toEqual(["msg-7", "msg-8"]); // the new message is on screen
    });
  });

  // kobo-506 — the client half of "a failed nudge must be visible to the caller": the
  // server route (route.ts) now returns notified:false + notifyError instead of
  // unconditional ok:true; this proves the compose box actually SHOWS that, not just
  // that the field exists somewhere. Same extract-and-eval technique as loadThreadEnv
  // above, extended to cover the compose/send section (autogrow + send), stopping
  // before the @-tag picker (kobo-397/kobo-390 sections aren't needed here).
  function loadSendEnv() {
    const start = html.indexOf("const $ = (id) => document.getElementById(id);");
    const end = html.indexOf("// kobo-397 — paste (Ctrl+V)", start);
    const src = html.slice(start, end);
    // `lead` is normally set by loadRooms() (a separate fetch this test doesn't need to
    // drive) — a tiny setter closes over the same `let lead` binding without pulling in
    // the whole company/room-list section.
    return new Function(`${src}\nfunction setLead(v){ lead = v; }\nreturn { send, setLead };`)();
  }

  function withSendGlobals(doc: any, sendResponse: any, fn: () => Promise<void>) {
    const prevDoc = (globalThis as any).document, prevLoc = (globalThis as any).location, prevFetch = (globalThis as any).fetch;
    const realSetTimeout = (globalThis as any).setTimeout;
    // send() fires `setTimeout(loadThread, 500)` fire-and-forget on success (pre-existing
    // behavior, not new to kobo-506) — left alone, that timer outlives this test's awaited
    // scope and fires 500ms later with globals already restored, hitting a REAL fetch with
    // a relative URL ("fetch() URL is invalid") in whatever test happens to be running by
    // then. Capture every timer scheduled during fn() and clear it before restoring, so
    // nothing from this test's send() call survives past this function's return.
    const timers: unknown[] = [];
    (globalThis as any).setTimeout = (cb: unknown, ms: unknown, ...rest: unknown[]) => {
      const id = realSetTimeout(cb, ms, ...rest);
      timers.push(id);
      return id;
    };
    (globalThis as any).document = doc;
    (globalThis as any).location = { search: "?company=kobo&room=r1", hash: "" };
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/api/room/send")) return { status: 200, json: async () => sendResponse };
      return { status: 404, json: async () => ({}) };
    };
    return fn().finally(() => {
      for (const id of timers) clearTimeout(id as number);
      (globalThis as any).setTimeout = realSetTimeout;
      (globalThis as any).document = prevDoc; (globalThis as any).location = prevLoc; (globalThis as any).fetch = prevFetch;
    });
  }

  test("kobo-506: notified:false shows a DISTINCT status naming the failure, not the normal 'waiting' message", async () => {
    const doc = fakeRoomDoc();
    const statusEl = doc.createElement("div"); statusEl.id = "status";
    await withSendGlobals(doc, { ok: true, room: "r1", to: "eq3", notified: false, notifyError: "nudge exited 1" }, async () => {
      const { send, setLead } = loadSendEnv();
      setLead("eq3");
      doc.getElementById("text").value = "urgent turn";
      await send();
      expect(statusEl.textContent).toContain("NOT notified");
      expect(statusEl.textContent).toContain("nudge exited 1"); // names the actual failure, not a generic message
      expect(statusEl.className).toContain("err"); // visually distinct too (setStatus's error styling)
      expect(doc.getElementById("text").value).toBe(""); // the turn WAS sent — composer still clears
    });
  });

  test("kobo-506: no notified field (happy path) → unchanged 'sent — waiting…' status, no regression", async () => {
    const doc = fakeRoomDoc();
    const statusEl = doc.createElement("div"); statusEl.id = "status";
    await withSendGlobals(doc, { ok: true, room: "r1", to: "eq3" }, async () => {
      const { send, setLead } = loadSendEnv();
      setLead("eq3");
      doc.getElementById("text").value = "fine turn";
      await send();
      expect(statusEl.textContent).toBe("sent to eq3 — waiting…");
      expect(statusEl.className).not.toContain("err");
    });
  });
});
