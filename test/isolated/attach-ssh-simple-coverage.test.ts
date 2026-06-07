import { describe, expect, mock, test } from "bun:test";

class MockSshAttachError extends Error {}

mock.module("maw-js/sdk", () => ({
  SshAttachError: MockSshAttachError,
  attachRemoteSession: () => {
    throw new Error("default ssh helper should not be used in this test");
  },
}));

const attachSsh = (await import("../../src/vendor/mpr-plugins/attach-ssh/index.ts?absent-lcov-attach-ssh")).default;

describe("attach-ssh strategy simple coverage", () => {
  const target = {
    tier: 3 as const,
    sessionName: "alpha-pane",
    node: "m5",
    peerUrl: "http://m5.local",
    sshAlias: "m5-ssh",
  };

  test("execute delegates to the provided ssh helper with the tier-3 target fields", async () => {
    const calls: unknown[] = [];

    await attachSsh.execute(target, {
      ssh: (opts) => {
        calls.push(opts);
      },
    });

    expect(calls).toEqual([{ node: "m5", sshAlias: "m5-ssh", sessionName: "alpha-pane" }]);
  });

  test("execute preserves friendly SshAttachError messages", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await expect(attachSsh.execute(target, {
        ssh: () => {
          throw new MockSshAttachError("ssh attach blocked");
        },
      })).rejects.toThrow("ssh attach blocked");
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual(["ssh attach blocked"]);
  });
});
