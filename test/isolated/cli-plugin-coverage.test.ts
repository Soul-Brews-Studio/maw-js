import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ClaudeSession } from "../../src/core/fleet/claude-sessions";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";
import {
  buildClaudeCliCommand,
  extractOracleContextHeader,
  resolveCliInvocation,
  shellQuote,
} from "../../src/commands/plugins/cli/impl";
import { createCliHandler } from "../../src/commands/plugins/cli/index";

function tmpOracleRoot(name: string, claudeMd: string): string {
  const root = mkdtempSync(join(tmpdir(), `maw-cli-${name}-`));
  writeFileSync(join(root, "CLAUDE.md"), claudeMd, "utf-8");
  return root;
}

function entry(overrides: Partial<OracleManifestEntry>): OracleManifestEntry {
  return {
    name: "mawjs",
    sources: ["fleet"],
    isLive: false,
    ...overrides,
  };
}

function claudeSession(overrides: Partial<ClaudeSession>): ClaudeSession {
  return {
    sessionId: "sid-old",
    projectPath: "/tmp/old",
    repo: null,
    worktree: null,
    pid: null,
    ppid: null,
    parentChain: [],
    tmuxTarget: null,
    triggeredFrom: "unknown",
    status: "idle",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    lastUserMessage: null,
    lastAssistantMessage: null,
    messageCount: 1,
    sizeBytes: 1,
    ...overrides,
  };
}

describe("maw cli helper", () => {
  test("shell-quotes pasteable command arguments", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(buildClaudeCliCommand({ sessionId: "abc", context: "you are maw's" }))
      .toBe("claude --resume 'abc' --append-system-prompt 'you are maw'\\''s'");
  });

  test("extracts a compact CLAUDE.md oracle header", () => {
    const context = extractOracleContextHeader(`# mawjs-oracle\n\n## Identity\n- Name: mawjs\n\n## Long\nmore`, "mawjs");
    expect(context).toContain("# mawjs-oracle");
    expect(context).toContain("## Identity");
  });

  test("prints a Claude invocation from a manifest session id and CLAUDE.md", async () => {
    const root = tmpOracleRoot("manifest", "# mawjs-oracle\n\n## Identity\n- Name: mawjs\n");
    const invocation = await resolveCliInvocation("mawjs-oracle", {
      loadManifest: () => [entry({ name: "mawjs", localPath: root, sessionId: "sid-manifest" })],
      loadConfig: () => ({}),
      listClaudeSessions: async () => [],
      ghqFindSync: () => null,
    });

    expect(invocation.oracle).toBe("mawjs");
    expect(invocation.sessionId).toBe("sid-manifest");
    expect(invocation.source).toBe("manifest");
    expect(invocation.claudePath).toBe(join(root, "CLAUDE.md"));
    expect(invocation.command).toContain("claude --resume 'sid-manifest'");
    expect(invocation.command).toContain("--append-system-prompt '# mawjs-oracle");
  });

  test("uses config sessions for session:window targets", async () => {
    const root = tmpOracleRoot("session-window", "# mawjs\n");
    const invocation = await resolveCliInvocation("77-mawjs:mawjs-features", {
      loadManifest: () => [entry({ name: "mawjs", session: "77-mawjs", window: "mawjs-oracle", localPath: root })],
      loadConfig: () => ({ sessions: { mawjs: "sid-config" } }),
      listClaudeSessions: async () => [],
      ghqFindSync: () => null,
    });

    expect(invocation.oracle).toBe("mawjs");
    expect(invocation.sessionId).toBe("sid-config");
    expect(invocation.source).toBe("config");
  });

  test("falls back to the newest Claude project session for the oracle repo", async () => {
    const root = tmpOracleRoot("project", "# volt-oracle\n");
    const invocation = await resolveCliInvocation("volt", {
      loadManifest: () => [entry({ name: "volt", localPath: root, repo: "Soul-Brews-Studio/volt-oracle" })],
      loadConfig: () => ({}),
      listClaudeSessions: async () => [
        claudeSession({ sessionId: "sid-old", projectPath: root, lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        claudeSession({ sessionId: "sid-new", projectPath: root.replace(/maw-cli-project-/, "maw/cli/project/") + "/subdir", lastActivityAt: "2026-05-22T00:00:00.000Z" }),
      ],
      ghqFindSync: () => null,
    });

    expect(invocation.sessionId).toBe("sid-new");
    expect(invocation.source).toBe("claude-sessions");
  });


  test("does not treat node prefixes as local oracle candidates", async () => {
    const root = tmpOracleRoot("node-scope", "# alpha-oracle\n");
    await expect(resolveCliInvocation("alpha:volt-oracle", {
      loadManifest: () => [entry({ name: "alpha", localPath: root, sessionId: "sid-alpha" })],
      loadConfig: () => ({}),
      listClaudeSessions: async () => [],
      ghqFindSync: () => null,
    })).rejects.toThrow("no Claude session id found for alpha:volt-oracle");
  });

  test("returns an actionable error when no session id can be found", async () => {
    await expect(resolveCliInvocation("ghost", {
      loadManifest: () => [],
      loadConfig: () => ({}),
      listClaudeSessions: async () => [],
      ghqFindSync: () => null,
    })).rejects.toThrow("add it to maw config sessions/sessionIds");
  });

  test("handler captures JSON output", async () => {
    const handler = createCliHandler({
      cmdCli: async () => {
        console.log(JSON.stringify({ command: "claude --resume 'sid'" }));
        return {
          target: "mawjs",
          oracle: "mawjs",
          sessionId: "sid",
          context: "ctx",
          command: "claude --resume 'sid'",
          source: "manifest",
        };
      },
    });

    const result = await handler({ source: "cli", args: ["mawjs", "--json"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("claude --resume");
  });
});
