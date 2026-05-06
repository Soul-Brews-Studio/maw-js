/**
 * #1149 — `maw hey --inbox` writes Claude Code-compatible TeammateMessage to
 * the file-based inbox at ~/.claude/teams/<team>/inboxes/<agent>.json.
 *
 * Claude Code's `useInboxPoller` (1Hz) reads this file and wraps unread messages
 * in `<teammate-message>` XML for the recipient's conversation.
 *
 * Reference: protocol verified against paoloanzn/free-code at
 *   src/utils/teammateMailbox.ts:115 (readUnreadMessages)
 *   src/hooks/useInboxPoller.ts:107 (INBOX_POLL_INTERVAL_MS = 1000)
 *
 * Note on hermetic isolation: `os.homedir()` reads from /etc/passwd on macOS,
 * NOT from $HOME env var, so we can't sandbox via process.env.HOME redirect.
 * We mock the `os` module instead.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "maw-hey-inbox-test-"));

mock.module("os", () => ({
  homedir: () => tmpHome,
  tmpdir: () => "/tmp",
}));

const { routeComm } = await import("../src/cli/route-comm");

describe("maw hey --inbox mode (#1149)", () => {
  afterEach(() => {
    // Clean inbox files between tests but keep tmpHome
    rmSync(join(tmpHome, ".claude/teams"), { recursive: true, force: true });
  });

  test("writes TeammateMessage to ~/.claude/teams/<team>/inboxes/<agent>.json", async () => {
    const handled = await routeComm("hey", [
      "hey",
      "scout",
      "hello from inbox mode",
      "--inbox",
      "--team",
      "my-team",
      "--from",
      "[m5:fortal]",
    ]);

    expect(handled).toBe(true);

    const inboxPath = join(tmpHome, ".claude/teams/my-team/inboxes/scout.json");
    expect(existsSync(inboxPath)).toBe(true);

    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: "[m5:fortal]",
      text: "hello from inbox mode",
      read: false,
    });
    expect(messages[0].timestamp).toBeDefined();
    expect(messages[0].summary).toBe("hello from inbox mode");
  });

  test("appends to existing inbox", async () => {
    await routeComm("hey", ["hey", "scout", "first", "--inbox", "--team", "my-team"]);
    await routeComm("hey", ["hey", "scout", "second", "--inbox", "--team", "my-team"]);

    const inboxPath = join(tmpHome, ".claude/teams/my-team/inboxes/scout.json");
    const messages = JSON.parse(readFileSync(inboxPath, "utf-8"));

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("first");
    expect(messages[1].text).toBe("second");
  });
});
