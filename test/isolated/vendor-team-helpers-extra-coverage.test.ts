import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers.ts?vendor-team-helpers-extra-coverage");

let tmp = "";
let originalCwd = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-vendor-team-helpers-"));
  originalCwd = process.cwd();
  helpers._setDirs(join(tmp, "teams"), join(tmp, "tasks"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function writeTeam(name: string, configText: string) {
  const dir = join(tmp, "teams", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), configText);
}

describe("vendor team helper low-hotspot coverage", () => {
  test("loadTeam and claimOrphanedTeamLead cover absent, malformed, no-op, and claimed branches", () => {
    expect(helpers.claimOrphanedTeamLead("absent", "new-session")).toEqual({ found: false, claimed: false, teammates: [] });

    writeTeam("bad", "{ not json");
    expect(helpers.loadTeam("bad")).toBeNull();
    expect(helpers.claimOrphanedTeamLead("bad", "new-session")).toEqual({ found: false, claimed: false, teammates: [] });

    writeTeam("fresh", JSON.stringify({ name: "fresh", members: [{ name: "lead", role: "lead" }, { name: "helper" }] }));
    expect(helpers.claimOrphanedTeamLead("fresh", "new-session")).toEqual({
      found: true,
      claimed: false,
      oldLeadSessionId: undefined,
      newLeadSessionId: "new-session",
      teammates: ["helper"],
    });

    writeTeam("same", JSON.stringify({ name: "same", leadSessionId: "same-session", members: [{ name: "worker", agentType: "executor" }] }));
    expect(helpers.claimOrphanedTeamLead("same", "same-session")).toMatchObject({ found: true, claimed: false, oldLeadSessionId: "same-session" });

    writeTeam("orphan", JSON.stringify({ name: "orphan", leadSessionId: "old-session", members: [{ name: "team-lead", agentType: "team-lead" }, { name: "worker" }] }));
    const claimed = helpers.claimOrphanedTeamLead("orphan", "new-session");
    expect(claimed).toMatchObject({ found: true, claimed: true, oldLeadSessionId: "old-session", newLeadSessionId: "new-session", teammates: ["worker"] });
    expect(JSON.parse(readFileSync(join(tmp, "teams", "orphan", "config.json"), "utf-8")).leadSessionId).toBe("new-session");
  });

  test("resolvePsi walks to an oracle root or falls back to cwd/ψ", () => {
    const root = join(tmp, "repo");
    const nested = join(root, "a", "b");
    mkdirSync(join(root, "ψ"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "oracle root\n");
    mkdirSync(nested, { recursive: true });

    process.chdir(nested);
    expect(helpers.resolvePsi()).toBe(realpathSync(join(root, "ψ")));

    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    process.chdir(plain);
    expect(helpers.resolvePsi()).toBe(join(process.cwd(), "ψ"));
  });



  test("session identity helpers and cleanupTeamDir cover env precedence and directory cleanup", () => {
    expect(helpers.currentLeadSessionId({ CLAUDE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" } as any)).toBe("claude");
    expect(helpers.currentLeadSessionId({ CODEX_THREAD_ID: "codex" } as any)).toBe("codex");
    expect(helpers.currentLeadSessionId({ OMX_SESSION_ID: "omx" } as any)).toBe("omx");
    expect(helpers.currentLeadSessionId({ ATUIN_SESSION: "atuin" } as any)).toBe("atuin");
    expect(helpers.currentLeadSessionId({} as any)).toBeUndefined();

    expect(helpers.isTeamLeadOrphaned({ name: "alpha", leadSessionId: "old", members: [] }, "new")).toBe(true);
    expect(helpers.isTeamLeadOrphaned({ name: "alpha", leadSessionId: "old", members: [] }, "old")).toBe(false);

    mkdirSync(join(tmp, "teams", "alpha"), { recursive: true });
    mkdirSync(join(tmp, "tasks", "alpha"), { recursive: true });
    helpers.cleanupTeamDir("alpha");
    expect(existsSync(join(tmp, "teams", "alpha"))).toBe(false);
    expect(existsSync(join(tmp, "tasks", "alpha"))).toBe(false);
  });

  test("writeShutdownRequest and writeMessage append after malformed inbox files", () => {
    const inboxDir = join(tmp, "teams", "alpha", "inboxes");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "worker.json"), "not json");

    helpers.writeShutdownRequest("alpha", "worker", "done for today");
    let messages = JSON.parse(readFileSync(join(inboxDir, "worker.json"), "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].summary).toBe("Shutdown request: done for today");
    expect(JSON.parse(messages[0].text)).toMatchObject({ type: "shutdown_request", reason: "done for today" });

    writeFileSync(join(inboxDir, "worker.json"), "not json again");
    helpers.writeMessage("alpha", "worker", "lead", "x".repeat(100));
    messages = JSON.parse(readFileSync(join(inboxDir, "worker.json"), "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("lead");
    expect(messages[0].summary).toBe("x".repeat(80));
    expect(JSON.parse(messages[0].text)).toEqual({ type: "message", content: "x".repeat(100) });

    helpers.writeMessage("alpha", "new-worker", "lead", "hello");
    expect(existsSync(join(inboxDir, "new-worker.json"))).toBe(true);
  });
});
