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

  test("kobo-396/397/398: only 2 KNOWN innerHTML sinks — escape-first renderNoteBody + mermaid's own trusted SVG", () => {
    expect(html).toContain("function mdToHtml"); // shared renderer (src/views/md.ts) injected verbatim
    expect(html).toContain("function escapeHtml");
    expect(html).toContain("function renderNoteBody"); // kobo-397: markdown + maw:// image-ref swap
    expect(html).toContain("bodyEl.innerHTML = renderNoteBody(m.text || '')"); // sink 1: escape-first
    expect(html).toContain("p.block.innerHTML = p.svg"); // sink 2: mermaid's OWN output (strict mode), not user text — one write site for both cache-hit and freshly-rendered
    const innerHtmlAssignments = (html.match(/\.innerHTML\s*=/g) || []).length;
    expect(innerHtmlAssignments).toBe(2); // no OTHER innerHTML= sink anywhere in the view
  });

  // kobo-398 review fix (B3): check 11 (strict must be hardcoded, no flag/env
  // can disable it in production) was previously enforced only by a human
  // grepping the PR — 0 hits for "securityLevel" existed in this test file. A
  // future edit that turned strict into an option/env would sail through green.
  // Exact-string match on the literal initialize() call closes that gap.
  test("kobo-398 check 11: securityLevel:'strict' + startOnLoad:false are hardcoded literals, no flag/env can disable them", () => {
    expect(html).toContain("window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false })");
  });

  // kobo-398 — extract the mermaid loader/renderer straight from the served client
  // script (same technique as loadLinkify above) and run it against stub
  // document/window objects so lazy-by-absence, load-once, and per-block
  // isolation are BEHAVIORALLY proven, not just grepped.
  function loadMermaidRenderer() {
    const start = html.indexOf("const MERMAID_ASSET_URL");
    const end = html.indexOf("async function loadThread", start);
    const src = html.slice(start, end);
    return new Function(`${src}; return { loadMermaid, renderMermaidBlocks };`)();
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
});
