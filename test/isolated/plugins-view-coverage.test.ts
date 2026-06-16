/** Compatibility coverage: plugin debug HTML now lives in serve-debug plugin (#2436). */
import { describe, expect, test } from "bun:test";
import { renderPluginsPage } from "../../src/vendor/mpr-plugins/serve-debug/index";

describe("plugins debug view extraction", () => {
  test("renders the plugin stats page from the serve-debug plugin", () => {
    const html = renderPluginsPage({
      startedAt: new Date(Date.now() - 7_000).toISOString(),
      plugins: [{ name: "demo", type: "ts", events: 2, errors: 1, lastEvent: "Wake", loadedAt: new Date().toISOString() }],
      totalEvents: 2,
      totalErrors: 1,
      gated: 0,
      filters: { "*": 1 },
    });
    expect(html).toContain("Plugin System v2");
    expect(html).toContain("demo");
    expect(html).toContain("Filters (Phase 1)");
  });
});
