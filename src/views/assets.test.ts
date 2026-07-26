import { describe, expect, test } from "bun:test";
import { assetsView } from "./assets";

// kobo-398 — a dedicated /assets/vendor/mermaid.js route, served directly from
// the pinned npm dep (Bun.file at request time, no build-copy step). Grep-
// confirmed no /assets/* route existed before this file.
describe("assetsView — same-origin static asset surface (kobo-398)", () => {
  test("GET /vendor/mermaid.js serves the pinned mermaid dist file, same-origin, non-empty", async () => {
    const res = await assetsView.request("/vendor/mermaid.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(10_000); // the real mermaid.min.js is multi-MB, not a stub
    expect(body).toContain("mermaid"); // sanity: really is the mermaid bundle
  });

  test("?v= cache-bust query is accepted (ignored server-side — the pinned file IS the version)", async () => {
    const res = await assetsView.request("/vendor/mermaid.js?v=11.16.0");
    expect(res.status).toBe(200);
  });
});
