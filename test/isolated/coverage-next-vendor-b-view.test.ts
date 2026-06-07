import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [],
  Tmux: class {
    async hasSession() { return true; }
  },
  resolveSocket: () => undefined,
  attachRemoteSession: () => undefined,
}));
mock.module("maw-js/config", () => ({ loadConfig: () => ({}) }));
mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: () => ({ kind: "none", hints: [] }),
}));
mock.module("maw-js/core/fleet/audit", () => ({ logAnomaly: () => undefined }));

const prompts = await import("../../src/vendor/mpr-plugins/view/internal/prompts.ts?coverage-next-vendor-b-view");
const { decideWakePrompt } = await import("../../src/vendor/mpr-plugins/view/impl.ts?coverage-next-vendor-b-view");

const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
});

describe("coverage-next vendor-b view prompt helpers", () => {
  test("wake prompt decision covers each override in priority order", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true, wake: true })).toBe("skip");
    expect(decideWakePrompt({ isTTY: true, wake: true })).toBe("force");
    expect(decideWakePrompt({ isTTY: false })).toBe("skip");
    expect(decideWakePrompt({ isTTY: true })).toBe("ask");
  });

  test("runPromptLoop warns on missing token, retries invalid peer URLs, and returns federated peers", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const answers = [
      "Bad Name!",
      "good-node",
      "",
      "yes",
      "not-a-url",
      "https://peer.example",
      "peer-1",
      "done",
    ];
    const writes: string[] = [];

    const result = await prompts.runPromptLoop(
      async () => answers.shift() ?? "done",
      { node: "default-node" },
      "/home/example",
      (msg) => writes.push(msg),
    );

    expect(result).toEqual({
      node: "good-node",
      token: "",
      federate: true,
      peers: [{ name: "peer-1", url: "https://peer.example" }],
    });
    expect(writes.join("\n")).toContain("Node name must be");
    expect(writes.join("\n")).toContain("no token provided");
    expect(writes.join("\n")).toContain("URL must start");
  });

  test("runPromptLoop aborts after repeated invalid node names", async () => {
    const writes: string[] = [];

    await expect(prompts.runPromptLoop(
      async () => "bad name!",
      { node: "default-node" },
      "/home/example",
      (msg) => writes.push(msg),
    )).rejects.toThrow("Aborted after 3 invalid attempts");

    expect(writes).toHaveLength(3);
  });
});
