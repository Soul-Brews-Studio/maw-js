/**
 * Tests for src/commands/plugins/inbox/impl.ts — writeInboxFile, loadInboxMessages (parameterized dir).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeInboxFile, loadInboxMessages } from "../../src/commands/plugins/inbox/impl";

describe("writeInboxFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a .md file", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Hello world");
    expect(filename).toMatch(/\.md$/);
  });

  it("file contains frontmatter", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Test message");
    const content = readFileSync(join(tmp, filename), "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("from: boom");
    expect(content).toContain("to: spark");
  });

  it("file contains body", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Hello there!");
    const content = readFileSync(join(tmp, filename), "utf-8");
    expect(content).toContain("Hello there!");
  });

  it("filename includes sender", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Test");
    expect(filename).toContain("boom");
  });

  it("filename includes slugified body", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "check the tests now");
    expect(filename).toContain("check");
  });

  it("creates inbox dir if missing", () => {
    const nested = join(tmp, "nested", "inbox");
    writeInboxFile(nested, "boom", "spark", "Hello");
    const files = readdirSync(nested);
    expect(files.length).toBe(1);
  });

  it("frontmatter has read: false", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Hi");
    const content = readFileSync(join(tmp, filename), "utf-8");
    expect(content).toContain("read: false");
  });

  it("frontmatter has ISO timestamp", () => {
    const filename = writeInboxFile(tmp, "boom", "spark", "Hi");
    const content = readFileSync(join(tmp, filename), "utf-8");
    expect(content).toMatch(/timestamp: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("loadInboxMessages", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-inbox-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array for non-existent dir", () => {
    expect(loadInboxMessages(join(tmp, "nope"))).toEqual([]);
  });

  it("returns empty array for empty dir", () => {
    expect(loadInboxMessages(tmp)).toEqual([]);
  });

  it("loads messages written by writeInboxFile", () => {
    writeInboxFile(tmp, "boom", "spark", "Test message");
    const msgs = loadInboxMessages(tmp);
    expect(msgs.length).toBe(1);
    expect(msgs[0].frontmatter.from).toBe("boom");
    expect(msgs[0].frontmatter.to).toBe("spark");
  });

  it("skips non-md files", () => {
    writeFileSync(join(tmp, "notes.txt"), "not a message");
    writeInboxFile(tmp, "boom", "spark", "Real message");
    const msgs = loadInboxMessages(tmp);
    expect(msgs.length).toBe(1);
  });

  it("parses body from message", () => {
    writeInboxFile(tmp, "boom", "spark", "Hello world body");
    const msgs = loadInboxMessages(tmp);
    expect(msgs[0].body).toContain("Hello world body");
  });

  it("sorts by timestamp descending (newest first)", () => {
    // Write two messages with slight delay in filename
    const md1 = "---\nfrom: a\nto: b\ntimestamp: 2026-01-01T00:00:00Z\nread: false\n---\nOlder";
    const md2 = "---\nfrom: c\nto: d\ntimestamp: 2026-01-02T00:00:00Z\nread: false\n---\nNewer";
    writeFileSync(join(tmp, "old.md"), md1);
    writeFileSync(join(tmp, "new.md"), md2);
    const msgs = loadInboxMessages(tmp);
    expect(msgs[0].frontmatter.from).toBe("c");
    expect(msgs[1].frontmatter.from).toBe("a");
  });

  it("has id without .md extension", () => {
    writeInboxFile(tmp, "boom", "spark", "Test");
    const msgs = loadInboxMessages(tmp);
    expect(msgs[0].id).not.toContain(".md");
  });

  it("has path pointing to actual file", () => {
    writeInboxFile(tmp, "boom", "spark", "Test");
    const msgs = loadInboxMessages(tmp);
    expect(msgs[0].path).toContain(tmp);
    expect(msgs[0].path).toMatch(/\.md$/);
  });

  it("handles malformed frontmatter gracefully", () => {
    writeFileSync(join(tmp, "bad.md"), "no frontmatter here\njust text");
    const msgs = loadInboxMessages(tmp);
    expect(msgs.length).toBe(1);
    expect(msgs[0].frontmatter.from).toBe("unknown");
  });
});
