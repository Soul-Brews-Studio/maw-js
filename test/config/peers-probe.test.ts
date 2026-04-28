/**
 * Tests for src/commands/plugins/peers/probe.ts — pure functions:
 * classifyProbeError, isValidMawHandshake, pickHint, formatProbeError, PROBE_EXIT_CODES.
 */
import { describe, it, expect } from "bun:test";
import {
  classifyProbeError,
  isValidMawHandshake,
  pickHint,
  formatProbeError,
  PROBE_EXIT_CODES,
  PROBE_HINTS,
} from "../../src/commands/plugins/peers/probe";
import type { LastError } from "../../src/commands/plugins/peers/store";

describe("classifyProbeError", () => {
  it("classifies HTTP 404 as HTTP_4XX", () => {
    expect(classifyProbeError({ status: 404, ok: false })).toBe("HTTP_4XX");
  });

  it("classifies HTTP 500 as HTTP_5XX", () => {
    expect(classifyProbeError({ status: 500, ok: false })).toBe("HTTP_5XX");
  });

  it("classifies HTTP 401 as HTTP_4XX", () => {
    expect(classifyProbeError({ status: 401, ok: false })).toBe("HTTP_4XX");
  });

  it("classifies ENOTFOUND as DNS", () => {
    expect(classifyProbeError({ cause: { code: "ENOTFOUND" } })).toBe("DNS");
  });

  it("classifies EAI_AGAIN as DNS", () => {
    expect(classifyProbeError({ cause: { code: "EAI_AGAIN" } })).toBe("DNS");
  });

  it("classifies ENOTIMP as DNS", () => {
    expect(classifyProbeError({ cause: { code: "ENOTIMP" } })).toBe("DNS");
  });

  it("classifies ECONNREFUSED as REFUSED", () => {
    expect(classifyProbeError({ cause: { code: "ECONNREFUSED" } })).toBe("REFUSED");
  });

  it("classifies ConnectionRefused (Bun) as REFUSED", () => {
    expect(classifyProbeError({ cause: { code: "ConnectionRefused" } })).toBe("REFUSED");
  });

  it("classifies ETIMEDOUT as TIMEOUT", () => {
    expect(classifyProbeError({ cause: { code: "ETIMEDOUT" } })).toBe("TIMEOUT");
  });

  it("classifies AbortError as TIMEOUT", () => {
    expect(classifyProbeError({ name: "AbortError" })).toBe("TIMEOUT");
  });

  it("classifies TimeoutError as TIMEOUT", () => {
    expect(classifyProbeError({ name: "TimeoutError" })).toBe("TIMEOUT");
  });

  it("classifies CERT_ prefix as TLS", () => {
    expect(classifyProbeError({ cause: { code: "CERT_HAS_EXPIRED" } })).toBe("TLS");
  });

  it("classifies SELF_SIGNED prefix as TLS", () => {
    expect(classifyProbeError({ cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })).toBe("TLS");
  });

  it("returns UNKNOWN for null", () => {
    expect(classifyProbeError(null)).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for unrecognized error", () => {
    expect(classifyProbeError({ cause: { code: "SOMETHING_ELSE" } })).toBe("UNKNOWN");
  });

  it("uses err.code when cause.code is missing", () => {
    expect(classifyProbeError({ code: "ECONNREFUSED" })).toBe("REFUSED");
  });
});

describe("isValidMawHandshake", () => {
  it("accepts true", () => {
    expect(isValidMawHandshake(true)).toBe(true);
  });

  it("accepts object with schema string", () => {
    expect(isValidMawHandshake({ schema: "1" })).toBe(true);
  });

  it("rejects false", () => {
    expect(isValidMawHandshake(false)).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidMawHandshake(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidMawHandshake(undefined)).toBe(false);
  });

  it("rejects string", () => {
    expect(isValidMawHandshake("yes")).toBe(false);
  });

  it("rejects number", () => {
    expect(isValidMawHandshake(1)).toBe(false);
  });

  it("rejects empty object (no schema)", () => {
    expect(isValidMawHandshake({})).toBe(false);
  });

  it("rejects object with non-string schema", () => {
    expect(isValidMawHandshake({ schema: 1 })).toBe(false);
  });

  it("rejects object with empty schema", () => {
    expect(isValidMawHandshake({ schema: "" })).toBe(false);
  });
});

describe("pickHint", () => {
  it("returns DNS hint for DNS code", () => {
    const err: LastError = { code: "DNS", message: "test", at: "" };
    expect(pickHint(err)).toContain("DNS");
  });

  it("returns avahi hint for ENOTIMP DNS error", () => {
    const err: LastError = { code: "DNS", message: "ENOTIMP: name not found", at: "" };
    expect(pickHint(err)).toContain("avahi");
  });

  it("returns standard hint for each code", () => {
    for (const code of Object.keys(PROBE_HINTS)) {
      const err: LastError = { code: code as any, message: "test", at: "" };
      expect(pickHint(err).length).toBeGreaterThan(0);
    }
  });
});

describe("formatProbeError", () => {
  it("includes error code", () => {
    const err: LastError = { code: "REFUSED", message: "connection refused", at: "" };
    const result = formatProbeError(err, "http://localhost:3000", "dev");
    expect(result).toContain("REFUSED");
  });

  it("includes error message", () => {
    const err: LastError = { code: "DNS", message: "host not found", at: "" };
    const result = formatProbeError(err, "http://example.com", "prod");
    expect(result).toContain("host not found");
  });

  it("includes alias in retry command", () => {
    const err: LastError = { code: "TIMEOUT", message: "timed out", at: "" };
    const result = formatProbeError(err, "http://example.com", "staging");
    expect(result).toContain("staging");
  });

  it("extracts host from URL", () => {
    const err: LastError = { code: "REFUSED", message: "test", at: "" };
    const result = formatProbeError(err, "http://localhost:3000", "dev");
    expect(result).toContain("localhost:3000");
  });

  it("handles invalid URL gracefully", () => {
    const err: LastError = { code: "UNKNOWN", message: "test", at: "" };
    const result = formatProbeError(err, "not-a-url", "bad");
    expect(result).toContain("not-a-url");
  });
});

describe("PROBE_EXIT_CODES", () => {
  it("DNS exit code is 3", () => {
    expect(PROBE_EXIT_CODES.DNS).toBe(3);
  });

  it("REFUSED exit code is 4", () => {
    expect(PROBE_EXIT_CODES.REFUSED).toBe(4);
  });

  it("TIMEOUT exit code is 5", () => {
    expect(PROBE_EXIT_CODES.TIMEOUT).toBe(5);
  });

  it("HTTP_4XX and HTTP_5XX exit code is 6", () => {
    expect(PROBE_EXIT_CODES.HTTP_4XX).toBe(6);
    expect(PROBE_EXIT_CODES.HTTP_5XX).toBe(6);
  });

  it("TLS/BAD_BODY/UNKNOWN exit code is 2", () => {
    expect(PROBE_EXIT_CODES.TLS).toBe(2);
    expect(PROBE_EXIT_CODES.BAD_BODY).toBe(2);
    expect(PROBE_EXIT_CODES.UNKNOWN).toBe(2);
  });
});
