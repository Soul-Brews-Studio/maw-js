/**
 * Tests for inferCapabilitiesRegex from src/commands/plugins/plugin/build-impl.ts — pure regex function.
 */
import { describe, it, expect } from "bun:test";
import { inferCapabilitiesRegex } from "../../src/commands/plugins/plugin/build-impl";

describe("inferCapabilitiesRegex", () => {
  it("detects maw.identity SDK call", () => {
    const caps = inferCapabilitiesRegex("maw.identity()");
    expect(caps).toContain("sdk:identity");
  });

  it("detects maw.fetch SDK call", () => {
    const caps = inferCapabilitiesRegex("const res = maw.fetch(url)");
    expect(caps).toContain("sdk:fetch");
  });

  it("detects multiple SDK methods", () => {
    const caps = inferCapabilitiesRegex("maw.wake('foo'); maw.send('bar', msg);");
    expect(caps).toContain("sdk:wake");
    expect(caps).toContain("sdk:send");
  });

  it("detects node:fs import", () => {
    const caps = inferCapabilitiesRegex("import { readFile } from 'node:fs'");
    expect(caps).toContain("fs:read");
  });

  it("detects node:fs/promises import", () => {
    const caps = inferCapabilitiesRegex("import { writeFile } from 'node:fs/promises'");
    expect(caps).toContain("fs:read");
  });

  it("detects node:child_process import", () => {
    const caps = inferCapabilitiesRegex("import { exec } from 'node:child_process'");
    expect(caps).toContain("proc:spawn");
  });

  it("detects bun:ffi import", () => {
    const caps = inferCapabilitiesRegex("import { dlopen } from 'bun:ffi'");
    expect(caps).toContain("ffi:any");
  });

  it("detects global fetch()", () => {
    const caps = inferCapabilitiesRegex("const data = fetch('https://api.com')");
    expect(caps).toContain("net:fetch");
  });

  it("does not detect fetch as property (maw.fetch)", () => {
    const caps = inferCapabilitiesRegex("maw.fetch(url)");
    // Should have sdk:fetch but NOT net:fetch (because maw.fetch has a dot before)
    expect(caps).toContain("sdk:fetch");
    expect(caps).not.toContain("net:fetch");
  });

  it("returns empty for no capabilities", () => {
    const caps = inferCapabilitiesRegex("const x = 1 + 2;");
    expect(caps).toEqual([]);
  });

  it("returns sorted results", () => {
    const caps = inferCapabilitiesRegex("maw.wake(); maw.fetch(); fetch('url')");
    expect(caps).toEqual([...caps].sort());
  });

  it("deduplicates capabilities", () => {
    const caps = inferCapabilitiesRegex("maw.wake(); maw.wake()");
    const wakeCount = caps.filter(c => c === "sdk:wake").length;
    expect(wakeCount).toBe(1);
  });
});
