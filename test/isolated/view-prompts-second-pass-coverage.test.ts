import { describe, expect, test } from "bun:test";

import {
  runPromptLoop,
  validateGhqRoot,
  validateNodeName,
  validatePeerName,
  validatePeerUrl,
} from "../../src/vendor/mpr-plugins/view/internal/prompts";

describe("view prompt helpers second-pass coverage", () => {
  test("validators accept documented shapes and reject invalid input", () => {
    expect(validateNodeName("white")).toBeNull();
    expect(validateNodeName("node-01")).toBeNull();
    expect(validateNodeName("bad name")).toContain("Node name");

    expect(validatePeerName("m5")).toBeNull();
    expect(validatePeerName("peer-123")).toBeNull();
    expect(validatePeerName("x".repeat(32))).toContain("Name must");

    expect(validatePeerUrl("")).toBe("URL required");
    expect(validatePeerUrl("localhost:3456")).toBe("URL must start with http:// or https://");
    expect(validatePeerUrl("http://localhost:3456")).toBeNull();
    expect(validatePeerUrl("https://peer.example/path")).toBeNull();

    expect(validateGhqRoot("", "/home/nat")).toEqual({ ok: false, err: "Path must be absolute" });
    expect(validateGhqRoot("relative", "/home/nat")).toEqual({ ok: false, err: "Path must be absolute (start with / or ~)" });
    expect(validateGhqRoot("~/ghq", "/home/nat")).toEqual({ ok: true, path: "/home/nat/ghq" });
    expect(validateGhqRoot("/opt/ghq", "/home/nat")).toEqual({ ok: true, path: "/opt/ghq" });
  });

  test("runPromptLoop warns about missing token and skips peers when not federating", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const answers = ["mawjs", "", "n"];
    const questions: Array<{ question: string; defaultVal?: string }> = [];
    const writes: string[] = [];

    try {
      const result = await runPromptLoop(
        async (question, defaultVal) => {
          questions.push({ question, defaultVal });
          return answers.shift()!;
        },
        { node: "default-node" },
        "/ignored-home",
        (msg) => writes.push(msg),
      );

      expect(result).toEqual({ node: "mawjs", token: "", federate: false, peers: [] });
      expect(questions.map(q => q.defaultVal)).toEqual(["default-node", "", "N"]);
      expect(writes.join("\n")).toContain("no token provided");
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  });

  test("runPromptLoop retries invalid node and peer values, then collects federated peers", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";
    const answers = [
      "bad node", "good-node",
      "explicit-token",
      "yes",
      "ftp://bad", "http://peer-one:3456", "bad peer name", "peer-one",
      "https://peer-two.example", "peer-two",
      "done",
    ];
    const writes: string[] = [];

    try {
      const result = await runPromptLoop(
        async () => answers.shift()!,
        { node: "default" },
        "/home/nat",
        (msg) => writes.push(msg),
      );

      expect(result).toEqual({
        node: "good-node",
        token: "explicit-token",
        federate: true,
        peers: [
          { name: "peer-one", url: "http://peer-one:3456" },
          { name: "peer-two", url: "https://peer-two.example" },
        ],
      });
      expect(writes.join("\n")).toContain("Node name must");
      expect(writes.join("\n")).toContain("URL must start");
      expect(writes.join("\n")).toContain("Name must");
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  });

  test("runPromptLoop aborts after three invalid answers for a validated prompt", async () => {
    const writes: string[] = [];

    await expect(runPromptLoop(
      async () => "bad node",
      { node: "default" },
      "/home/nat",
      (msg) => writes.push(msg),
    )).rejects.toThrow("Aborted after 3 invalid attempts");
    expect(writes).toHaveLength(3);
  });
});
