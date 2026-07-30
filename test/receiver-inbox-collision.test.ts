import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistReceiverInbox } from "../src/commands/shared/receiver-inbox";

describe("receiver inbox filename collisions (#1967)", () => {
  test("keeps same-minute messages with matching first six words", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-receiver-inbox-collision-"));
    const repo = join(root, "digger-oracle");
    mkdirSync(repo, { recursive: true });
    const deps = {
      resolveTargetCwd: () => repo,
      loadManifest: () => [],
      getGhqRoot: () => root,
      ghqFind: async () => null,
      now: () => new Date("2026-05-17T08:00:42.000Z"),
    };

    const first = await persistReceiverInbox({
      query: "digger",
      target: "54-digger:digger-oracle.0",
      from: "m5:sender",
      message: "one two three four five six alpha",
    }, deps);
    const second = await persistReceiverInbox({
      query: "digger",
      target: "54-digger:digger-oracle.0",
      from: "m5:sender",
      message: "one two three four five six beta",
    }, deps);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected both writes to succeed");
    expect(first.filename).toBe("2026-05-17_08-00_m5-sender_one-two-three-four-five-six.md");
    expect(second.filename).toBe("2026-05-17_08-00_m5-sender_one-two-three-four-five-six-2.md");
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);

    const files = readdirSync(first.inboxDir).sort();
    expect(files).toEqual([first.filename, second.filename].sort());
    expect(readFileSync(first.path, "utf-8")).toContain("alpha");
    expect(readFileSync(second.path, "utf-8")).toContain("beta");
  });
});
