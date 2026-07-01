/**
 * plugin-mcp-standalone.test.ts — boundary + behavior for the `mcp` vendor plugin.
 *
 * Boundary (#2113): the plugin must reach runtime deps ONLY through `maw-js/sdk`,
 * never `maw-js/core|config|lib|...` directly — so SDK-extraction drift is caught.
 *
 * Behavior: the security-critical `maw_inline_images` resolver (eq3-006) — pure
 * `inlineImages` exercised through injected deps (no real fetch / no mesh), plus
 * the node allowlist. Covers the acceptance cases: multi-ref → all base64,
 * one broken ref → fail-fast naming it, ref outside the allowlist → no fetch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inlineImages,
  parseMawRef,
  resolveConfiguredNodeBaseUrl,
  defaultInlineImagesDeps,
  DEFAULT_PER_IMAGE_MAX_BYTES,
  DEFAULT_TOTAL_MAX_BYTES,
  DEFAULT_MAX_IMAGES,
  type FetchedImage,
  type InlineImagesDeps,
} from "../../src/vendor/mpr-plugins/mcp/inline-images";

const root = join(import.meta.dir, "../..");
const MCP_DIR = "src/vendor/mpr-plugins/mcp";

// A tiny 1x1 PNG's worth of bytes — content is irrelevant, only the byte count
// and base64 round-trip matter here.
const bytesOf = (n: number) => new Uint8Array(n).fill(7);

/** Build deps where each node maps to a base URL and each URL serves fixed bytes. */
function depsFrom(
  files: Record<string, FetchedImage>,
  allow: Record<string, string>,
  overrides: Partial<InlineImagesDeps> = {},
): InlineImagesDeps {
  return {
    resolveNodeBaseUrl: (node) => allow[node] ?? null,
    fetchImage: async (url) => files[url] ?? { ok: false, status: 404 },
    ...overrides,
  };
}

describe("mcp plugin standalone boundary (#2113)", () => {
  test("plugin sources import runtime deps only through maw-js/sdk", () => {
    for (const rel of ["index.ts", "plugin.ts", "server.ts", "tools.ts", "inline-images.ts"]) {
      const source = readFileSync(join(root, MCP_DIR, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    }
    // inline-images reaches config via the SDK boundary, not a deep import.
    expect(readFileSync(join(root, MCP_DIR, "inline-images.ts"), "utf8")).toContain('from "maw-js/sdk"');
  });

  // kobo-21/24: the maw_task tool wraps the CLI task board (spawns
  // `maw company task <verb>` via runMaw, like the other verb tools) — it must
  // NOT reach into core task logic directly. Pin the registration + that taskArgs
  // maps every verb + targets the canonical company surface.
  test("server registers maw_task and delegates through taskArgs → maw company task", () => {
    const server = readFileSync(join(root, MCP_DIR, "server.ts"), "utf8");
    expect(server).toContain('"maw_task"');
    expect(server).toContain("taskArgs");
    const tools = readFileSync(join(root, MCP_DIR, "tools.ts"), "utf8");
    expect(tools).toContain("export function taskArgs");
    for (const verb of ['"add"', '"ls"', '"start"', '"claim"', '"review"', '"pr"', '"done"', '"block"', '"unblock"', '"archive"']) {
      expect(tools).toContain(verb);
    }
    // cli-reorg kobo-24: targets the canonical `maw company task`, NOT the
    // `maw task` deprecation shim (so no "moved" notice leaks into MCP output).
    expect(tools).toContain('["company", "task"');
    expect(tools).not.toMatch(/\[\s*"task"\s*,/);
  });
});

describe("parseMawRef", () => {
  test("parses node / filename / ext", () => {
    expect(parseMawRef("maw://m5/abc-123.png")).toEqual({ node: "m5", filename: "abc-123.png", ext: "png" });
    expect(parseMawRef("maw://monkut/IMG.JPEG")).toEqual({ node: "monkut", filename: "IMG.JPEG", ext: "jpeg" });
  });
  test("rejects path traversal / nested slashes / non-maw", () => {
    expect(parseMawRef("maw://m5/../secret.png")).toBeNull(); // extra slash → no match
    expect(parseMawRef("maw://m5/sub/dir.png")).toBeNull();
    expect(parseMawRef("https://m5/a.png")).toBeNull();
    expect(parseMawRef("maw://m5/noext")).toBeNull();
  });
});

describe("resolveConfiguredNodeBaseUrl — the SSRF allowlist", () => {
  const config: any = {
    node: "m5",
    port: 3456,
    namedPeers: [{ name: "monkut", url: "http://10.66.66.25:3499", node: "monkut" }],
    peers: ["http://legacy-host:3456"],
  };
  test("self node → localhost", () => {
    expect(resolveConfiguredNodeBaseUrl("m5", config)).toBe("http://127.0.0.1:3456");
    expect(resolveConfiguredNodeBaseUrl("local", config)).toBe("http://127.0.0.1:3456");
  });
  test("named peer → its url", () => {
    expect(resolveConfiguredNodeBaseUrl("monkut", config)).toBe("http://10.66.66.25:3499");
  });
  test("legacy peers[] substring match", () => {
    expect(resolveConfiguredNodeBaseUrl("legacy-host", config)).toBe("http://legacy-host:3456");
  });
  test("unknown node → null (rejected, never fetched)", () => {
    expect(resolveConfiguredNodeBaseUrl("evil.example.com", config)).toBeNull();
    expect(resolveConfiguredNodeBaseUrl("attacker", config)).toBeNull();
  });
});

describe("inlineImages — acceptance", () => {
  test("1) markdown with several maw:// refs → all become base64, none left", async () => {
    const allow = { m5: "http://127.0.0.1:3456", monkut: "http://10.66.66.25:3499" };
    const files = {
      "http://127.0.0.1:3456/api/files/a.png": { ok: true, status: 200, bytes: bytesOf(8) },
      "http://10.66.66.25:3499/api/files/b.webp": { ok: true, status: 200, bytes: bytesOf(12) },
    };
    const md = "intro ![one](maw://m5/a.png) mid ![two](maw://monkut/b.webp) end";
    const out = await inlineImages(md, depsFrom(files, allow));
    expect(out).not.toContain("maw://");
    expect(out).toContain(`data:image/png;base64,${Buffer.from(bytesOf(8)).toString("base64")}`);
    expect(out).toContain(`data:image/webp;base64,${Buffer.from(bytesOf(12)).toString("base64")}`);
  });

  test("a repeated ref is fetched once and replaced everywhere", async () => {
    let fetches = 0;
    const deps = depsFrom({}, { m5: "http://127.0.0.1:3456" }, {
      fetchImage: async () => { fetches++; return { ok: true, status: 200, bytes: bytesOf(4) }; },
    });
    const md = "![x](maw://m5/a.png) and again maw://m5/a.png";
    const out = await inlineImages(md, deps);
    expect(fetches).toBe(1);
    expect(out).not.toContain("maw://");
  });

  test("2) one broken ref (404) → fail-fast, error names the ref, nothing returned", async () => {
    const allow = { m5: "http://127.0.0.1:3456" };
    const files = { "http://127.0.0.1:3456/api/files/ok.png": { ok: true, status: 200, bytes: bytesOf(4) } };
    const md = "![ok](maw://m5/ok.png) ![bad](maw://m5/missing.png)";
    await expect(inlineImages(md, depsFrom(files, allow))).rejects.toThrow(/maw:\/\/m5\/missing\.png.*HTTP 404/);
  });

  test("3) ref to a node outside the allowlist → throws, fetch never attempted (SSRF guard)", async () => {
    let fetched = false;
    const deps = depsFrom({}, { m5: "http://127.0.0.1:3456" }, {
      fetchImage: async (url) => { fetched = true; return { ok: true, status: 200, bytes: bytesOf(4) }; },
    });
    await expect(inlineImages("![e](maw://evil/x.png)", deps)).rejects.toThrow(/node 'evil' not in allowlist/);
    expect(fetched).toBe(false);
  });

  test("unsupported image type → fail-fast naming the ref", async () => {
    const deps = depsFrom({}, { m5: "http://127.0.0.1:3456" });
    await expect(inlineImages("![s](maw://m5/x.svg)", deps)).rejects.toThrow(/unsupported image type '\.svg'/);
  });

  test("per-image cap exceeded → fail-fast", async () => {
    const allow = { m5: "http://127.0.0.1:3456" };
    const files = { "http://127.0.0.1:3456/api/files/big.png": { ok: true, status: 200, bytes: bytesOf(11) } };
    const deps = depsFrom(files, allow, { maxPerImageBytes: 10 });
    await expect(inlineImages("![b](maw://m5/big.png)", deps)).rejects.toThrow(/too large/);
  });

  test("total cap exceeded across refs → fail-fast", async () => {
    const allow = { m5: "http://127.0.0.1:3456" };
    const files = {
      "http://127.0.0.1:3456/api/files/a.png": { ok: true, status: 200, bytes: bytesOf(6) },
      "http://127.0.0.1:3456/api/files/b.png": { ok: true, status: 200, bytes: bytesOf(6) },
    };
    const deps = depsFrom(files, allow, { maxPerImageBytes: 10, maxTotalBytes: 10 });
    await expect(inlineImages("![a](maw://m5/a.png) ![b](maw://m5/b.png)", deps)).rejects.toThrow(/total image bytes exceeded/);
  });

  test("per-image cap can be set lower than total to isolate the per-image rule", async () => {
    const allow = { m5: "http://127.0.0.1:3456" };
    const files = { "http://127.0.0.1:3456/api/files/a.png": { ok: true, status: 200, bytes: bytesOf(20) } };
    const deps = depsFrom(files, allow, { maxPerImageBytes: 5, maxTotalBytes: 1000 });
    await expect(inlineImages("![a](maw://m5/a.png)", deps)).rejects.toThrow(/too large/);
  });

  test("too many images → fail-fast before any fetch", async () => {
    let fetched = 0;
    const deps = depsFrom({}, { m5: "http://127.0.0.1:3456" }, {
      maxImages: 2,
      fetchImage: async () => { fetched++; return { ok: true, status: 200, bytes: bytesOf(1) }; },
    });
    const md = "maw://m5/a.png maw://m5/b.png maw://m5/c.png";
    await expect(inlineImages(md, deps)).rejects.toThrow(/too many images \(3 distinct refs > cap 2\)/);
    expect(fetched).toBe(0);
  });

  test("markdown with no maw:// is returned unchanged, no fetch", async () => {
    let fetched = false;
    const deps = depsFrom({}, {}, { fetchImage: async () => { fetched = true; return { ok: false, status: 0 }; } });
    const md = "plain ![http](https://example.com/a.png) text";
    expect(await inlineImages(md, deps)).toBe(md);
    expect(fetched).toBe(false);
  });

  test("caps default to the te-kb-aligned values", () => {
    expect(DEFAULT_PER_IMAGE_MAX_BYTES).toBe(5_242_880);
    expect(DEFAULT_TOTAL_MAX_BYTES).toBe(26_214_400);
    expect(DEFAULT_MAX_IMAGES).toBe(20);
  });
});

describe("defaultInlineImagesDeps", () => {
  test("wires the config-driven allowlist (no network in this assertion)", () => {
    const deps = defaultInlineImagesDeps({ node: "m5", port: 3456, namedPeers: [], peers: [] } as any);
    expect(deps.resolveNodeBaseUrl("m5")).toBe("http://127.0.0.1:3456");
    expect(deps.resolveNodeBaseUrl("nope")).toBeNull();
    expect(typeof deps.fetchImage).toBe("function");
  });
});
