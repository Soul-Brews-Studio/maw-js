import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
let avengersUrl: string | null = "http://avengers.local:8090";
const fetchCalls: Array<{ url: string; options: unknown }> = [];
let fetchRoutes: Record<string, unknown> = {};
let fetchError: Error | null = null;

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ avengers: avengersUrl }),
}));

(globalThis as any).fetch = async (url: string, options: unknown) => {
  fetchCalls.push({ url, options });
  if (fetchError) throw fetchError;
  return {
    json: async () => fetchRoutes[url] ?? {},
  };
};

const { default: avengersHandler } = await import("../../src/vendor/mpr-plugins/avengers/index.ts?plugin-avengers-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  avengersUrl = "http://avengers.local:8090";
  fetchCalls.length = 0;
  fetchError = null;
  fetchRoutes = {
    "http://avengers.local:8090/all": [
      { name: "tony", remaining: 80, limit: 100 },
      { email: "nat@example.com", requests_remaining: 10, requests_limit: 100 },
    ],
    "http://avengers.local:8090/best": { name: "tony", remaining: 80 },
    "http://avengers.local:8090/traffic-stats": { total: 123 },
  };
});

describe("avengers plugin standalone boundary (#2253)", () => {
  test("has no direct core or shared command imports", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/avengers/index.ts",
      "src/vendor/mpr-plugins/avengers/impl.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
  });

  test("prints help without loading config or fetching", async () => {
    const writes: string[] = [];

    const result = await avengersHandler({
      source: "cli",
      args: ["--help"],
      writer: (...parts: unknown[]) => writes.push(parts.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true });
    expect(writes.join("\n")).toContain("usage: maw avengers");
    expect(fetchCalls).toEqual([]);
  });

  test("status renders all accounts from configured Avengers URL", async () => {
    const result = await avengersHandler({ source: "cli", args: ["status"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual(["http://avengers.local:8090/all"]);
    const output = stripAnsi(result.output);
    expect(output).toContain("Avengers Status");
    expect(output).toContain("tony");
    expect(output).toContain("80/100 (80%)");
    expect(output).toContain("nat@example.com");
    expect(output).toContain("10/100 (10%)");
  });

  test("best and traffic subcommands fetch their dedicated endpoints", async () => {
    const best = await avengersHandler({ source: "cli", args: ["best"] } as any);
    expect(best.ok).toBe(true);
    expect(stripAnsi(best.output)).toContain("Best Account");
    expect(stripAnsi(best.output)).toContain('"remaining": 80');

    const traffic = await avengersHandler({ source: "cli", args: ["traffic"] } as any);
    expect(traffic.ok).toBe(true);
    expect(stripAnsi(traffic.output)).toContain("Traffic Stats");
    expect(stripAnsi(traffic.output)).toContain('"total": 123');

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "http://avengers.local:8090/best",
      "http://avengers.local:8090/traffic-stats",
    ]);
  });

  test("health reports online and offline states", async () => {
    const online = await avengersHandler({ source: "cli", args: ["health"] } as any);
    expect(online.ok).toBe(true);
    expect(stripAnsi(online.output)).toContain("Avengers online");
    expect(stripAnsi(online.output)).toContain("2 accounts");

    fetchError = new Error("network down");
    const offline = await avengersHandler({ source: "cli", args: ["health"] } as any);
    expect(offline.ok).toBe(true);
    expect(stripAnsi(offline.output)).toContain("Avengers offline");
  });

  test("returns configuration and fetch failures as captured output", async () => {
    avengersUrl = null;
    const missing = await avengersHandler({ source: "cli", args: ["status"] } as any);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("Avengers not configured");

    avengersUrl = "http://avengers.local:8090";
    fetchError = new Error("refused");
    const failed = await avengersHandler({ source: "cli", args: ["status"] } as any);
    expect(failed.ok).toBe(true);
    expect(stripAnsi(failed.output)).toContain("avengers unreachable at http://avengers.local:8090: refused");
  });
});
