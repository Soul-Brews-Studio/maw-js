/**
 * #1905 — attach-ssh must preflight the SSH alias and refuse fast (3s)
 * instead of inheriting ssh's TCP-connect block on dead hosts.
 */
import { describe, expect, mock, test } from "bun:test";

class MockSshAttachError extends Error {}

mock.module("maw-js/sdk", () => ({
  SshAttachError: MockSshAttachError,
  attachRemoteSession: () => {
    throw new Error("ssh helper should not be invoked when preflight fails");
  },
}));

const attachSsh = (await import("../../src/vendor/mpr-plugins/attach-ssh/index.ts?preflight-1905")).default;

const target = {
  tier: 3 as const,
  sessionName: "alpha-pane",
  node: "m5",
  peerUrl: "http://m5.local",
  sshAlias: "white",
};

describe("attach-ssh preflight (#1905)", () => {
  test("aborts with actionable error when probe fails", async () => {
    const sshCalls: unknown[] = [];
    let captured = "";
    const origErr = console.error;
    console.error = (line: any) => { captured += String(line) + "\n"; };
    try {
      await expect(
        attachSsh.execute(target, {
          probe: () => ({ ok: false, reason: "Connection refused" }),
          ssh: ((args: unknown) => { sshCalls.push(args); }) as any,
        }),
      ).rejects.toThrow(/ssh white unreachable in 3s/);
    } finally {
      console.error = origErr;
    }

    expect(sshCalls).toEqual([]);
    expect(captured).toContain("check ~/.ssh/config for 'Host white'");
    expect(captured).toContain("WG hostname directly: ssh white.wg");
    expect(captured).toContain("(Connection refused)");
  });

  test("passes through to ssh helper when probe succeeds", async () => {
    const sshCalls: unknown[] = [];
    await attachSsh.execute(target, {
      probe: () => ({ ok: true }),
      ssh: ((args: unknown) => { sshCalls.push(args); }) as any,
    });
    expect(sshCalls).toEqual([
      { node: "m5", sshAlias: "white", sessionName: "alpha-pane" },
    ]);
  });

  test("timeout failure surfaces 'timed out' reason", async () => {
    await expect(
      attachSsh.execute(target, {
        probe: () => ({ ok: false, reason: "probe timed out after 4000ms" }),
        ssh: (() => {}) as any,
      }),
    ).rejects.toThrow(/timed out after 4000ms/);
  });

  test("calls probe with the target's sshAlias and 4000ms budget", async () => {
    let probedAlias = "";
    let probedTimeout = 0;
    await attachSsh.execute(target, {
      probe: (alias, timeoutMs) => { probedAlias = alias; probedTimeout = timeoutMs; return { ok: true }; },
      ssh: (() => {}) as any,
    });
    expect(probedAlias).toBe("white");
    expect(probedTimeout).toBe(4000);
  });
});
