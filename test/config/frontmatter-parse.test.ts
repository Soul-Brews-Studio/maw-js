/**
 * Tests for parseFrontmatter from src/commands/plugins/cross-team-queue/scan.ts.
 * Pure string parser — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../../src/commands/plugins/cross-team-queue/scan";

describe("parseFrontmatter", () => {
  it("parses simple key-value pairs", () => {
    const raw = `---
recipient: neo
team: alpha
subject: hello world
---
body here`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.recipient).toBe("neo");
    expect(data.team).toBe("alpha");
    expect(data.subject).toBe("hello world");
  });

  it("parses boolean values", () => {
    const raw = `---
urgent: true
archived: false
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.urgent).toBe(true);
    expect(data.archived).toBe(false);
  });

  it("parses numeric values", () => {
    const raw = `---
priority: 42
score: 3.14
negative: -7
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.priority).toBe(42);
    expect(data.score).toBe(3.14);
    expect(data.negative).toBe(-7);
  });

  it("parses array values", () => {
    const raw = `---
tags: [bug, urgent, frontend]
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.tags).toEqual(["bug", "urgent", "frontend"]);
  });

  it("parses empty array", () => {
    const raw = `---
tags: []
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.tags).toEqual([]);
  });

  it("strips quotes from array items", () => {
    const raw = `---
names: ["neo", 'pulse', plain]
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.names).toEqual(["neo", "pulse", "plain"]);
  });

  it("strips quotes from string values", () => {
    const raw = `---
name: "neo"
other: 'pulse'
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.name).toBe("neo");
    expect(data.other).toBe("pulse");
  });

  it("returns error for missing frontmatter", () => {
    const { error } = parseFrontmatter("no frontmatter here", "test.md");
    expect(error).not.toBeUndefined();
    expect(error!.reason).toBe("missing frontmatter");
    expect(error!.file).toBe("test.md");
  });

  it("returns error for unterminated frontmatter", () => {
    const raw = `---
key: value
no closing fence`;
    const { error } = parseFrontmatter(raw, "test.md");
    expect(error).not.toBeUndefined();
    expect(error!.reason).toBe("unterminated frontmatter");
  });

  it("returns error for malformed line (no colon)", () => {
    const raw = `---
this has no colon
---`;
    const { error } = parseFrontmatter(raw, "test.md");
    expect(error).not.toBeUndefined();
    expect(error!.reason).toBe("malformed frontmatter");
  });

  it("returns error for empty key", () => {
    const raw = `---
: value
---`;
    const { error } = parseFrontmatter(raw, "test.md");
    expect(error).not.toBeUndefined();
    expect(error!.reason).toBe("malformed frontmatter");
  });

  it("skips empty lines in frontmatter body", () => {
    const raw = `---
key1: value1

key2: value2
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.key1).toBe("value1");
    expect(data.key2).toBe("value2");
  });

  it("handles empty string", () => {
    const { error } = parseFrontmatter("", "test.md");
    expect(error).not.toBeUndefined();
    expect(error!.reason).toBe("missing frontmatter");
  });

  it("handles value with colon in it", () => {
    const raw = `---
url: http://example.com:3456
---`;
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.url).toBe("http://example.com:3456");
  });

  it("handles Windows line endings", () => {
    const raw = "---\r\nkey: value\r\n---\r\n";
    const { data, error } = parseFrontmatter(raw, "test.md");
    expect(error).toBeUndefined();
    expect(data.key).toBe("value");
  });
});
