/** Targeted isolated coverage for src/views/plugins.tsx. */
import { afterEach, describe, expect, test } from "bun:test";
import type { PluginSystem } from "../../src/plugins";
import { pluginsView } from "../../src/views/plugins";

const NOW = new Date("2026-05-18T12:00:00.000Z").getTime();
const originalDateNow = Date.now;

type PluginStats = ReturnType<PluginSystem["stats"]>;

function fakePluginSystem(stats: PluginStats): PluginSystem {
  return { stats: () => stats } as unknown as PluginSystem;
}

function baseStats(overrides: Partial<PluginStats> = {}): PluginStats {
  return {
    startedAt: new Date(NOW - 42_000).toISOString(),
    plugins: [],
    totalEvents: 0,
    totalErrors: 0,
    gated: 0,
    reloads: 0,
    lastReloadAt: undefined,
    gates: {},
    filters: {},
    handlers: {},
    lates: {},
    ...overrides,
  };
}

async function render(stats: PluginStats): Promise<string> {
  Date.now = () => NOW;
  const response = await pluginsView(fakePluginSystem(stats)).request("/");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

afterEach(() => {
  Date.now = originalDateNow;
});

describe("pluginsView isolated coverage", () => {
  test("renders stats, plugin rows, phase hook sections, and ok/error classes", async () => {
    const html = await render(baseStats({
      totalEvents: 12,
      totalErrors: 1,
      gated: 2,
      plugins: [
        {
          name: "gatekeeper",
          type: "ts",
          source: "core",
          events: 7,
          errors: 0,
          lastEvent: "feed:accept",
          loadedAt: new Date("2026-05-18T11:50:00.000Z").toISOString(),
        },
        {
          name: "wasi-runner",
          type: "wasm-wasi",
          source: "user",
          events: 5,
          errors: 3,
          lastEvent: undefined,
          loadedAt: new Date("2026-05-18T11:55:00.000Z").toISOString(),
        },
      ],
      gates: { "feed:*": 2 },
      filters: { "feed:accept": 1 },
      handlers: { "feed:accept": 3 },
      lates: { "*": 4 },
    }));

    expect(html).toContain("Plugin System v2");
    expect(html).toContain("<div class=\"n\">2</div><div class=\"l\">Plugins</div>");
    expect(html).toContain("<div class=\"n pulse\">12</div><div class=\"l\">Events</div>");
    expect(html).toContain("<div class=\"n err\">1</div><div class=\"l\">Errors</div>");
    expect(html).toContain("<div class=\"n err\">2</div><div class=\"l\">Gated</div>");
    expect(html).toContain("<div class=\"n\">42s</div><div class=\"l\">Uptime</div>");

    expect(html).toContain("<strong>gatekeeper</strong>");
    expect(html).toContain("<span class=\"tag ts\">ts</span>");
    expect(html).toContain("<td class=\"ok\">0</td>");
    expect(html).toContain("feed:accept");
    expect(html).toContain("<strong>wasi-runner</strong>");
    expect(html).toContain("<span class=\"tag wasm-wasi\">wasm-wasi</span>");
    expect(html).toContain("<td class=\"err\">3</td>");
    expect(html).toContain("<td>—</td>");

    expect(html).toContain("Gates (Phase 0)");
    expect(html).toContain("Filters (Phase 1)");
    expect(html).toContain("Handlers (Phase 2)");
    expect(html).toContain("Lates (Phase 3)");
    expect(html).toContain("feed:*");
    expect(html).toContain("<span class=\"count\">×2</span>");
    expect(html).toContain("<span class=\"count\">×1</span>");
    expect(html).toContain("<span class=\"count\">×3</span>");
    expect(html).toContain("<span class=\"count\">×4</span>");
    expect(html).toContain(".err{color:#f15bb5}.ok{color:#00f5d4}");
  });

  test("renders ok stat classes and omits empty hook phase sections", async () => {
    const html = await render(baseStats({
      startedAt: new Date(NOW - 60_000).toISOString(),
      totalErrors: 0,
      gated: 0,
    }));

    expect(html).toContain("<div class=\"n ok\">0</div><div class=\"l\">Errors</div>");
    expect(html).toContain("<div class=\"n ok\">0</div><div class=\"l\">Gated</div>");
    expect(html).toContain("<div class=\"n\">60s</div><div class=\"l\">Uptime</div>");
    expect(html).not.toContain("Gates (Phase 0)");
    expect(html).not.toContain("Filters (Phase 1)");
    expect(html).not.toContain("Handlers (Phase 2)");
    expect(html).not.toContain("Lates (Phase 3)");
  });

  test("formats minute and hour uptime branches", async () => {
    const minuteHtml = await render(baseStats({
      startedAt: new Date(NOW - 125_000).toISOString(),
    }));
    expect(minuteHtml).toContain("<div class=\"n\">2m 5s</div><div class=\"l\">Uptime</div>");

    const hourHtml = await render(baseStats({
      startedAt: new Date(NOW - ((2 * 3600 + 5 * 60 + 9) * 1000)).toISOString(),
    }));
    expect(hourHtml).toContain("<div class=\"n\">2h 5m</div><div class=\"l\">Uptime</div>");
  });
});
