/**
 * sanitize-log — neutralize attacker-influenced fields before they reach
 * console.log / console.error. Closes the four js/log-injection alerts in
 * src/transports/hub-connection.ts (#474).
 *
 * Tests live in plain test/ (not test/isolated/) — the function is pure
 * (string in, string out, no side effects), so no mock.module is needed.
 */
import { describe, test, expect } from "bun:test";
import { sanitizeLogField } from "../src/core/util/sanitize-log";

describe("sanitizeLogField — passthrough cases", () => {
  test("plain ASCII string passes unchanged", () => {
    expect(sanitizeLogField("workspace-123")).toBe("workspace-123");
  });

  test("unicode text passes unchanged", () => {
    expect(sanitizeLogField("สวัสดีครับพี่นัท")).toBe("สวัสดีครับพี่นัท");
  });

  test("tab character is preserved (operationally useful in logs)", () => {
    expect(sanitizeLogField("col-a\tcol-b")).toBe("col-a\tcol-b");
  });

  test("space and printable punctuation are preserved", () => {
    expect(sanitizeLogField("name (id=42, host=mba)")).toBe("name (id=42, host=mba)");
  });
});

describe("sanitizeLogField — log-forgery vectors (CRLF + newlines)", () => {
  test("LF replaced with visible escape so attacker cannot start a new fake log line", () => {
    const attack = "victim\n[hub] FAKE: take over this line";
    const safe = sanitizeLogField(attack);
    expect(safe).not.toContain("\n");
    expect(safe).toContain("\\x0a");
  });

  test("CR replaced (carriage-return overwrites previous line in many terminals)", () => {
    expect(sanitizeLogField("real\rFAKE")).toBe("real\\x0dFAKE");
  });

  test("CRLF combo handled — both bytes neutralized", () => {
    const safe = sanitizeLogField("a\r\nb");
    expect(safe).toContain("\\x0d");
    expect(safe).toContain("\\x0a");
    expect(safe).not.toContain("\r");
    expect(safe).not.toContain("\n");
  });
});

describe("sanitizeLogField — ANSI escape sequences", () => {
  test("ANSI CSI color sequence is stripped entirely", () => {
    // \x1b[31m red, \x1b[0m reset
    const colored = "\x1b[31mFAKE ERROR\x1b[0m";
    expect(sanitizeLogField(colored)).toBe("FAKE ERROR");
  });

  test("ANSI cursor manipulation (e.g. clear screen) is stripped", () => {
    expect(sanitizeLogField("before\x1b[2Jafter")).toBe("beforeafter");
  });

  test("ANSI OSC sequence (window title hijack) is stripped", () => {
    // \x1b]0;TITLE\x07 — sets terminal title
    const osc = "x\x1b]0;HIJACKED\x07y";
    expect(sanitizeLogField(osc)).toBe("xy");
  });

  test("bare ESC (non-CSI) is replaced as a control char", () => {
    expect(sanitizeLogField("a\x1bb")).toBe("a\\x1bb");
  });
});

describe("sanitizeLogField — control characters", () => {
  test("NUL byte (0x00) replaced — could otherwise terminate C-string-aware viewers", () => {
    expect(sanitizeLogField("a\x00b")).toBe("a\\x00b");
  });

  test("BEL (0x07) replaced — would otherwise audibly beep", () => {
    expect(sanitizeLogField("alert\x07")).toBe("alert\\x07");
  });

  test("BS (0x08) replaced — would otherwise erase preceding visible character", () => {
    expect(sanitizeLogField("vi\x08\x08X")).toBe("vi\\x08\\x08X");
  });

  test("DEL (0x7f) replaced", () => {
    expect(sanitizeLogField("a\x7fb")).toBe("a\\x7fb");
  });
});

describe("sanitizeLogField — truncation", () => {
  test("default cap (200) truncates with marker showing dropped count", () => {
    const long = "x".repeat(250);
    const safe = sanitizeLogField(long);
    expect(safe).toMatch(/^x{200}…\[\+50\]$/);
  });

  test("custom maxLen respected", () => {
    expect(sanitizeLogField("abcdefghij", 5)).toBe("abcde…[+5]");
  });

  test("maxLen=0 disables truncation", () => {
    const long = "x".repeat(500);
    expect(sanitizeLogField(long, 0)).toBe(long);
  });

  test("string at exactly maxLen is not truncated", () => {
    expect(sanitizeLogField("abc", 3)).toBe("abc");
  });
});

describe("sanitizeLogField — non-string inputs", () => {
  test("undefined → literal 'undefined' string (visible, not silently dropped)", () => {
    expect(sanitizeLogField(undefined)).toBe("undefined");
  });

  test("null → literal 'null' string", () => {
    expect(sanitizeLogField(null)).toBe("null");
  });

  test("number coerced to string", () => {
    expect(sanitizeLogField(42)).toBe("42");
  });

  test("object coerced via String() (typically '[object Object]')", () => {
    expect(sanitizeLogField({ workspaceId: "x" })).toBe("[object Object]");
  });

  test("object with throwing toString does not throw — falls back to placeholder", () => {
    const evil = { toString() { throw new Error("nope"); } };
    expect(sanitizeLogField(evil)).toBe("[unstringifiable]");
  });
});

describe("sanitizeLogField — combined attack vectors (the realistic case)", () => {
  test("CRLF + ANSI + control chars in one payload — all neutralized", () => {
    // The kind of payload an attacker would craft for msg.workspaceId
    const payload = "real-ws\x1b[31m\n[hub] AUTH OK fake-ws\x1b[0m\x07";
    const safe = sanitizeLogField(payload);
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\x1b");
    expect(safe).not.toContain("\x07");
    expect(safe).toContain("\\x0a"); // newline visibly marked
    expect(safe).toContain("\\x07"); // BEL visibly marked
    // The literal "[hub] AUTH OK fake-ws" text remains visible — safe to
    // display, just unable to forge a separate log line.
    expect(safe).toContain("[hub] AUTH OK fake-ws");
  });
});
