import { describe, expect, test } from "bun:test";
import { addCorsHeaders, corsHeaders, handleCorsOptions } from "../../src/core/serve-cors";

const CONTROL_HEADERS = [
  "x-maw-control-signature",
  "x-maw-control-token",
  "x-maw-share-write-token",
];

describe("serve CORS middleware", () => {
  test("corsHeaders mirrors request origin and permits serve API/control headers", () => {
    const headers = corsHeaders(new Request("http://local/api", { headers: { origin: "http://example.test" } }));

    expect(headers).toEqual({
      "Access-Control-Allow-Origin": "http://example.test",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Federation-Token, X-From-Signature, x-maw-control-signature, x-maw-control-token, x-maw-share-write-token",
      "Access-Control-Allow-Private-Network": "true",
    });
    for (const header of CONTROL_HEADERS) {
      expect(headers["Access-Control-Allow-Headers"].toLowerCase()).toContain(header);
    }
  });

  test("corsHeaders falls back to wildcard origin when no Origin header is present", () => {
    expect(corsHeaders(new Request("http://local/"))["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("handleCorsOptions returns a 204 preflight response only for OPTIONS requests", () => {
    const preflight = handleCorsOptions(new Request("http://local/api/control/%251/send", {
      method: "OPTIONS",
      headers: {
        origin: "http://preflight.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-maw-control-token,x-maw-control-signature,x-maw-share-write-token",
      },
    }));

    expect(preflight).toBeInstanceOf(Response);
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("Access-Control-Allow-Origin")).toBe("http://preflight.test");
    expect(preflight?.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    const allowed = preflight?.headers.get("Access-Control-Allow-Headers")?.toLowerCase() ?? "";
    for (const header of CONTROL_HEADERS) expect(allowed).toContain(header);
    expect(handleCorsOptions(new Request("http://local/ws"))).toBeUndefined();
  });

  test("plugin control responses can be cloned with CORS headers", async () => {
    const request = new Request("http://local/api/control/%251/send", {
      method: "POST",
      headers: { origin: "http://viewer.test" },
    });
    const response = addCorsHeaders(request, new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "content-type": "application/json", "x-plugin-route": "serve-control" },
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://viewer.test");
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("x-maw-control-token");
    expect(response.headers.get("x-plugin-route")).toBe("serve-control");
    expect(await response.json()).toEqual({ ok: true });
  });
});
