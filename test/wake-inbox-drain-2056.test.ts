import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { drainWakeInbox, mergeWakeInboxPrompt } from "../src/commands/shared/wake-inbox-drain";

describe("wake inbox drain (#2056)", () => {
  test("drains unread ψ/inbox markdown into a priming prompt and marks read", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-"));
    const inbox = join(repo, "ψ", "inbox");
    mkdirSync(inbox, { recursive: true });
    const unread = join(inbox, "001.md");
    const read = join(inbox, "002.md");
    writeFileSync(unread, [
      "---",
      "from: alpha:sender",
      "to: renamed",
      "timestamp: 2026-06-06T00:00:00.000Z",
      "read: false",
      "---",
      "",
      "please review #2056",
      "",
    ].join("\n"));
    writeFileSync(read, ["---", "from: old", "read: true", "---", "", "old"].join("\n"));

    const result = drainWakeInbox(repo);

    expect(result.count).toBe(1);
    expect(result.prompt).toContain("Unread ψ/inbox messages");
    expect(result.prompt).toContain("please review #2056");
    expect(result.prompt).not.toContain("old");
    const updated = readFileSync(unread, "utf-8");
    expect(updated).toContain("read: true");
    expect(updated).toContain("readAt:");
  });

  test("merges drained inbox after an explicit wake prompt", () => {
    expect(mergeWakeInboxPrompt("continue task", "## Unread ψ/inbox messages\nhello"))
      .toBe("continue task\n\n## Unread ψ/inbox messages\nhello");
  });

  test("skips draining inbox for non-Claude engines", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-non-claude-"));
    const inbox = join(repo, "ψ", "inbox");
    mkdirSync(inbox, { recursive: true });
    const unread = join(inbox, "001.md");
    writeFileSync(unread, [
      "---",
      "from: alpha:sender",
      "timestamp: 2026-06-06T00:00:00.000Z",
      "read: false",
      "---",
      "",
      "please review #2090",
      "",
    ].join("\n"));

    const result = drainWakeInbox(repo, { engine: "omx" });
    const updated = readFileSync(unread, "utf-8");

    expect(result.count).toBe(0);
    expect(result.prompt).toBe("");
    expect(result.messages).toEqual([]);
    expect(updated).toContain("read: false");
    expect(updated).toContain("please review #2090");
  });
});

test("caps wake inbox prompt bytes and leaves omitted messages unread", () => {
  const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-cap-"));
  const inbox = join(repo, "ψ", "inbox");
  mkdirSync(inbox, { recursive: true });
  const small = join(inbox, "001.md");
  const huge = join(inbox, "002.md");
  writeFileSync(small, ["---", "from: small", "read: false", "---", "", "small body"].join("\n"));
  writeFileSync(huge, ["---", "from: huge", "read: false", "---", "", "x".repeat(1_000)].join("\n"));

  const result = drainWakeInbox(repo, { byteBudget: 400 });

  expect(Buffer.byteLength(result.prompt, "utf-8")).toBeLessThanOrEqual(400);
  expect(result.count).toBe(1);
  expect(result.omittedCount).toBe(1);
  expect(result.prompt).toContain("small body");
  expect(readFileSync(small, "utf-8")).toContain("read: true");
  expect(readFileSync(huge, "utf-8")).toContain("read: false");
});
