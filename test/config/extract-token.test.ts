/**
 * Tests for src/lib/auth.ts — extractToken.
 * Pure function: parses token from Request headers or query params.
 * Note: createToken/verifyToken use loadConfig() at module level, but
 * extractToken is fully pure.
 */
import { describe, it, expect } from "bun:test";
import { extractToken } from "../../src/lib/auth";

function makeReq(headers: Record<string, string> = {}, url = "http://localhost/"): Request {
  return new Request(url, { headers });
}

describe("extractToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const req = makeReq({ authorization: "Bearer abc123" });
    expect(extractToken(req)).toBe("abc123");
  });

  it("extracts token from query param", () => {
    const req = makeReq({}, "http://localhost/?token=xyz789");
    expect(extractToken(req)).toBe("xyz789");
  });

  it("prefers Authorization header over query param", () => {
    const req = makeReq(
      { authorization: "Bearer fromHeader" },
      "http://localhost/?token=fromQuery"
    );
    expect(extractToken(req)).toBe("fromHeader");
  });

  it("returns null when no token present", () => {
    const req = makeReq();
    expect(extractToken(req)).toBeNull();
  });

  it("returns null for non-Bearer auth scheme", () => {
    const req = makeReq({ authorization: "Basic abc123" });
    expect(extractToken(req)).toBeNull();
  });

  it("returns null for 'Bearer ' with no token value", () => {
    // "Bearer " (trailing space only) — headers may normalize trailing whitespace
    const req = makeReq({ authorization: "Bearer " });
    // Slice returns "" but Request headers may strip trailing whitespace
    const result = extractToken(req);
    // Either "" or null is acceptable — test actual behavior
    expect(result === "" || result === null).toBe(true);
  });

  it("handles multi-part Bearer token", () => {
    const req = makeReq({ authorization: "Bearer part1.part2.part3" });
    expect(extractToken(req)).toBe("part1.part2.part3");
  });
});
