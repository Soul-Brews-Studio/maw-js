import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { drainWakeInbox, mergeWakeInboxPrompt } from "../../src/commands/shared/wake-inbox-drain";

describe("wake inbox drain (#2390)", () => {
  test("reports unread ψ/inbox count without injecting bodies or marking read", () => {
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
      "please review #2013",
      "",
    ].join("\n"));
    writeFileSync(read, ["---", "from: old", "read: true", "---", "", "old"].join("\n"));

    const result = drainWakeInbox(repo);

    expect(result.count).toBe(1);
    expect(result.prompt).toBe("You have 1 unread messages in inbox. Run maw inbox --unread to review.\n");
    expect(result.prompt).not.toContain("please review #2013");
    expect(result.prompt).not.toContain("old");
    const updated = readFileSync(unread, "utf-8");
    expect(updated).toContain("read: false");
    expect(updated).not.toContain("readAt:");
  });


  test("marks unread messages read when the attach flow consumes wake inbox", () => {
    const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-mark-read-"));
    const inbox = join(repo, "ψ", "inbox");
    mkdirSync(inbox, { recursive: true });
    const unread = join(inbox, "001.md");
    const missingRead = join(inbox, "002.md");
    writeFileSync(unread, [
      "---",
      "from: alpha:sender",
      "timestamp: 2026-06-06T00:00:00.000Z",
      "read:false",
      "---",
      "",
      "please review #2588",
    ].join("\n"));
    writeFileSync(missingRead, ["---", "from: beta:sender", "---", "", "missing read flag"].join("\n"));

    const result = drainWakeInbox(repo, { markRead: true });

    expect(result.count).toBe(2);
    expect(readFileSync(unread, "utf-8")).toContain("read: true");
    expect(readFileSync(unread, "utf-8")).toContain("readAt:");
    expect(readFileSync(missingRead, "utf-8")).toContain("read: true");
    expect(readFileSync(missingRead, "utf-8")).toContain("readAt:");
  });

  test("merges drained inbox after an explicit wake prompt", () => {
    expect(mergeWakeInboxPrompt("continue task", "You have 1 unread messages in inbox. Run maw inbox --unread to review.\n"))
      .toBe("continue task\n\nYou have 1 unread messages in inbox. Run maw inbox --unread to review.\n");
  });

  test("terminates unread notice before a following launch command", () => {
    const notice = mergeWakeInboxPrompt(undefined, "You have 1 unread messages in inbox. Run maw inbox --unread to review.\n");

    expect(`${notice}DISCORD_STATE_DIR=/tmp claude --continue`)
      .toContain("review.\nDISCORD_STATE_DIR=/tmp");
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

test("counts all unread messages without body-size omissions", () => {
  const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-cap-"));
  const inbox = join(repo, "ψ", "inbox");
  mkdirSync(inbox, { recursive: true });
  const small = join(inbox, "001.md");
  const huge = join(inbox, "002.md");
  writeFileSync(small, ["---", "from: small", "read: false", "---", "", "small body"].join("\n"));
  writeFileSync(huge, ["---", "from: huge", "read: false", "---", "", "x".repeat(1_000)].join("\n"));

  const result = drainWakeInbox(repo, { byteBudget: 400 });

  expect(Buffer.byteLength(result.prompt, "utf-8")).toBeLessThanOrEqual(400);
  expect(result.count).toBe(2);
  expect(result.omittedCount).toBe(0);
  expect(result.prompt).toBe("You have 2 unread messages in inbox. Run maw inbox --unread to review.\n");
  expect(result.prompt).not.toContain("small body");
  expect(result.prompt).not.toContain("xxx");
  expect(readFileSync(small, "utf-8")).toContain("read: false");
  expect(readFileSync(huge, "utf-8")).toContain("read: false");
});

test("returns an empty prompt when the one-line unread notice exceeds the byte budget", () => {
  const repo = mkdtempSync(join(tmpdir(), "maw-wake-drain-tight-budget-"));
  const inbox = join(repo, "ψ", "inbox");
  mkdirSync(inbox, { recursive: true });
  const unread = join(inbox, "001.md");
  writeFileSync(unread, ["---", "from: huge", "read: false", "---", "", "x".repeat(1_000)].join("\n"));

  const result = drainWakeInbox(repo, { byteBudget: 10 });

  expect(result.count).toBe(1);
  expect(result.omittedCount).toBe(0);
  expect(result.prompt).toBe("");
  expect(readFileSync(unread, "utf-8")).toContain("read: false");
});
