/**
 * Tests for src/commands/plugins/project/impl.ts — helpText, stub functions.
 * Pure string generators.
 */
import { describe, it, expect, spyOn } from "bun:test";
import { helpText, stubLearn, stubIncubate, stubFind, stubList } from "../../src/commands/plugins/project/impl";

describe("helpText", () => {
  it("contains usage line", () => {
    expect(helpText()).toContain("usage: maw project");
  });

  it("lists all subcommands", () => {
    const text = helpText();
    expect(text).toContain("learn");
    expect(text).toContain("incubate");
    expect(text).toContain("find");
    expect(text).toContain("list");
  });

  it("includes tracking URL", () => {
    expect(helpText()).toContain("github.com");
  });
});

describe("stub functions", () => {
  it("stubLearn returns message with URL", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const msg = await stubLearn("https://github.com/org/repo");
    expect(msg).toContain("learn");
    expect(msg).toContain("https://github.com/org/repo");
  });

  it("stubIncubate returns message with URL", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const msg = await stubIncubate("https://github.com/org/repo");
    expect(msg).toContain("incubate");
  });

  it("stubFind returns message with query", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const msg = await stubFind("auth middleware");
    expect(msg).toContain("find");
    expect(msg).toContain("auth middleware");
  });

  it("stubList returns message", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const msg = await stubList();
    expect(msg).toContain("list");
  });

  it("all stubs include tracking URL", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    for (const fn of [stubLearn, stubIncubate, stubFind]) {
      const msg = await (fn as any)("test");
      expect(msg).toContain("track:");
    }
  });
});
