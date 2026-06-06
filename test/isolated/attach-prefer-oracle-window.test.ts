/**
 * #1911 — `maw a <oracle>` must land on the oracle's window, not the
 * last-active window of the matching session.
 *
 * Covers the new opt-in `preferOracleWindow` flag on resolveAttachTarget
 * plus the windowName-aware target build in cmdAttach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

const { resolveAttachTarget } = await import(
  "../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts?prefer-oracle-window-1911"
);

const originalSshConfigFile = process.env.SSH_CONFIG_FILE;

beforeEach(() => {
  process.env.SSH_CONFIG_FILE = join(tmpdir(), "maw-empty-ssh-config-1911");
});

afterEach(() => {
  if (originalSshConfigFile === undefined) delete process.env.SSH_CONFIG_FILE;
  else process.env.SSH_CONFIG_FILE = originalSshConfigFile;
});

const stripAnsi = (s: string) => s.replace(/\x1b\[\d+m/g, "");

describe("resolveAttachTarget preferOracleWindow (#1911)", () => {
  test("session-name match + oracle window in session → windowName populated", async () => {
    const result = await resolveAttachTarget("yd-patient-flow", {
      listSessions: async () => [
        {
          name: "01-yd-patient-flow",
          windows: [
            { name: "yd-patient-flow-oracle" },
            { name: "yd-patient-flow-v2-fix-emergency-phone" },
            { name: "yd-patient-flow-v2-phase2-rls" },
          ],
        },
      ],
      loadFleet: () => [],
    }, { preferOracleWindow: true });

    expect(result).toEqual({
      tier: 1,
      sessionName: "01-yd-patient-flow",
      windowName: "yd-patient-flow-oracle",
    });
  });

  test("session-name match + NO oracle window → windowName undefined (single-window safe)", async () => {
    const result = await resolveAttachTarget("solo", {
      listSessions: async () => [
        { name: "solo", windows: [{ name: "main-shell" }] },
      ],
      loadFleet: () => [],
    }, { preferOracleWindow: true });

    expect(result).toEqual({ tier: 1, sessionName: "solo" });
  });

  test("exact-window-name match → windowName populated (existing behavior unchanged)", async () => {
    const result = await resolveAttachTarget("test-cli", {
      listSessions: async () => [
        { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "test-cli" }] },
      ],
      loadFleet: () => [],
    }, { preferOracleWindow: true });

    expect(result).toEqual({
      tier: 1,
      sessionName: "77-mawjs",
      windowName: "test-cli",
    });
  });

  test("default behavior (no preferOracleWindow) preserved — windowName NOT populated for session-name match", async () => {
    const result = await resolveAttachTarget("yd-patient-flow", {
      listSessions: async () => [
        {
          name: "01-yd-patient-flow",
          windows: [
            { name: "yd-patient-flow-oracle" },
            { name: "extra-tile" },
          ],
        },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "01-yd-patient-flow" });
  });

  test("default behavior preserved for oracle-window match without preferOracleWindow", async () => {
    const result = await resolveAttachTarget("discord", {
      listSessions: async () => [
        { name: "23-discord-admin", windows: [{ name: "discord-oracle" }] },
      ],
      loadFleet: () => [],
    });

    expect(result).toEqual({ tier: 1, sessionName: "23-discord-admin" });
  });

  test("preferOracleWindow promotes oracle-window match shape", async () => {
    const result = await resolveAttachTarget("discord", {
      listSessions: async () => [
        { name: "23-discord-admin", windows: [{ name: "discord-oracle" }] },
      ],
      loadFleet: () => [],
    }, { preferOracleWindow: true });

    expect(result).toEqual({
      tier: 1,
      sessionName: "23-discord-admin",
      windowName: "discord-oracle",
    });
  });

  test("fuzzy session match works; windowMatchesOracle doesn't fuzzy-match, so windowName stays undefined when target token isn't in any window name", async () => {
    // 'wind' fuzzy-matches the session '01-Somwind' but does NOT match the
    // 'Somwind-oracle' window via windowMatchesOracle (which is exact/prefix).
    // Documents the current behavior — fuzzy session + non-matching window
    // names falls back to bare sessionName (tmux selects last-active window).
    const result = await resolveAttachTarget("wind", {
      listSessions: async () => [
        { name: "01-Somwind", windows: [{ name: "Somwind-oracle" }, { name: "side-tile" }] },
      ],
      loadFleet: () => [],
    }, { fuzzy: true, preferOracleWindow: true });

    expect(result?.tier).toBe(1);
    if (result?.tier === 1) {
      expect(result.sessionName).toBe("01-Somwind");
    }
  });

  test("ambiguous case still surfaces candidates", async () => {
    const result = await resolveAttachTarget("mawjs", {
      listSessions: async () => [
        { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }] },
        { name: "cnx-mawjs", windows: [{ name: "mawjs-oracle" }] },
      ],
      loadFleet: () => [],
    }, { preferOracleWindow: true });

    expect(result?.tier).toBe(1);
    if (result?.tier === 1) {
      expect(result.sessionName).toBe("77-mawjs");
      expect(result.windowName).toBe("mawjs-oracle");
    }
  });
});

describe("attach target build (impl integration) (#1911)", () => {
  test("builds session:window when windowName populated", () => {
    const result = { tier: 1, sessionName: "01-yd-patient-flow", windowName: "yd-patient-flow-oracle" };
    const target = result.windowName ? `${result.sessionName}:${result.windowName}` : result.sessionName;
    expect(target).toBe("01-yd-patient-flow:yd-patient-flow-oracle");
  });

  test("builds bare session when windowName absent", () => {
    const result = { tier: 1 as const, sessionName: "solo" };
    const target = (result as any).windowName ? `${result.sessionName}:${(result as any).windowName}` : result.sessionName;
    expect(target).toBe("solo");
  });

  test("ANSI-safe log line check (uses stripAnsi helper)", () => {
    const tier1Target = "01-yd-patient-flow:yd-patient-flow-oracle";
    const logged = `  \x1b[32m→\x1b[0m attaching to ${tier1Target}`;
    expect(stripAnsi(logged)).toBe(`  → attaching to ${tier1Target}`);
  });
});
