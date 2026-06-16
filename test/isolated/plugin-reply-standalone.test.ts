import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/reply");

const originalFetch = globalThis.fetch;
const originalMawPort = process.env.MAW_PORT;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchImpl: typeof fetch;

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

function loadReplyPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadReplyPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

beforeEach(() => {
  process.env.MAW_PORT = "3456";
  fetchCalls = [];
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return Response.json({ ok: true });
  }) as typeof fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => fetchImpl(...args)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMawPort === undefined) delete process.env.MAW_PORT;
  else process.env.MAW_PORT = originalMawPort;
});

describe("reply plugin standalone boundary (#2284)", () => {
  test("plugin sources stay off direct core/shared/lib/config/sdk imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/"))).toEqual([]);
    expect(imports).toEqual(["maw-js/plugin/types", "./impl", "maw-js/sdk"]);
  });

  test("plugin loads from manifest and reports CLI metadata", async () => {
    const plugin = loadReplyPlugin();
    expect(plugin.manifest.name).toBe("reply");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("reply v1.0.0");
    expect(result.output).toContain("maw reply <correlationId>");
    expect(fetchCalls).toEqual([]);
  });

  test("posts joined CLI reply text to the request endpoint", async () => {
    const { result, output } = await invokeCli(["corr-1", "hello", "world"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("replied");
    expect(output).toContain("corr-1");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://localhost:3456/api/reply/corr-1");
    expect(fetchCalls[0]!.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(fetchCalls[0]!.init!.body))).toEqual({ reply: "hello world" });
  });

  test("list mode queries pending delivered requests and renders rows", async () => {
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json({ total: 1, requests: [{ correlationId: "c2", from: "neo", message: "approve?" }] });
    }) as typeof fetch;

    const { result, output } = await invokeCli(["--list", "mawjs"]);

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]!.url).toBe("http://localhost:3456/api/requests?oracle=mawjs&status=delivered");
    expect(output).toContain("c2");
    expect(output).toContain("neo");
    expect(output).toContain("1 pending request(s)");
  });

  test("list mode handles no pending requests", async () => {
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json({ total: 0, requests: [] });
    }) as typeof fetch;

    const { result, output } = await invokeCli(["-l"]);

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]!.url).toBe("http://localhost:3456/api/requests?status=delivered");
    expect(output).toContain("no pending requests");
  });

  test("server-side reply errors are logged but do not throw", async () => {
    for (const [body, expected] of [
      [{ error: "request not found" }, "request 'missing' not found"],
      [{ error: "already replied" }, "already replied"],
      [{ error: "bad gateway" }, "bad gateway"],
    ] as const) {
      fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return Response.json(body, { status: 409 });
      }) as typeof fetch;

      const { result, output } = await invokeCli(["missing", "ok"]);
      expect(result.ok).toBe(true);
      expect(output).toContain(expected);
    }
  });

  test("usage errors and fetch failures return plugin failures", async () => {
    const missing = await invokeCli(["corr-only"]);
    expect(missing.result.ok).toBe(false);
    expect(missing.result.error).toContain("usage: maw reply");

    fetchImpl = (async () => { throw new Error("server down"); }) as typeof fetch;
    const failed = await invokeCli(["corr", "hello"]);
    expect(failed.result.ok).toBe(false);
    expect(failed.result.error).toContain("server down");
  });
});
