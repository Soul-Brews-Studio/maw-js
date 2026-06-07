import { describe, expect, test } from "bun:test";
import { corsHeaders, handleCorsOptions } from "../../src/core/serve-cors";

describe("serve CORS middleware", () => {
  test("corsHeaders mirrors request origin and permits serve API headers", () => {
    expect(corsHeaders(new Request("http://local/api", { headers: { origin: "http://example.test" } }))).toEqual({
      "Access-Control-Allow-Origin": "http://example.test",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Federation-Token, X-From-Signature",
      "Access-Control-Allow-Private-Network": "true",
    });
  });

  test("corsHeaders falls back to wildcard origin when no Origin header is present", () => {
    expect(corsHeaders(new Request("http://local/"))["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("handleCorsOptions returns a 204 preflight response only for OPTIONS requests", () => {
    const preflight = handleCorsOptions(new Request("http://local/ws", {
      method: "OPTIONS",
      headers: { origin: "http://preflight.test" },
    }));

    expect(preflight).toBeInstanceOf(Response);
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("Access-Control-Allow-Origin")).toBe("http://preflight.test");
    expect(preflight?.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    expect(handleCorsOptions(new Request("http://local/ws"))).toBeUndefined();
  });
});
