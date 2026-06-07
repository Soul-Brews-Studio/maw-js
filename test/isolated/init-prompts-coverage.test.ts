import { afterEach, describe, expect, test } from "bun:test";

import {
  runPromptLoop,
  validateGhqRoot,
  validateNodeName,
  validatePeerName,
  validatePeerUrl,
  type AskFn,
} from "../../src/vendor/mpr-plugins/init/prompts";

const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
});

function scriptedAsk(answers: string[], calls: Array<{ question: string; defaultVal?: string }>): AskFn {
  return async (question: string, defaultVal = "") => {
    calls.push({ question, defaultVal });
    return answers.shift() ?? defaultVal;
  };
}

describe("init prompts coverage", () => {
  test("validators accept supported shapes and reject invalid input with actionable errors", () => {
    expect(validateNodeName("white")).toBeNull();
    expect(validateNodeName("node-63-".replace(/-$/, "1"))).toBeNull();
    expect(validateNodeName("bad_name")).toContain("Node name must");
    expect(validateNodeName("-starts-with-hyphen")).toContain("Node name must");
    expect(validateNodeName("x".repeat(64))).toContain("Node name must");

    expect(validateGhqRoot("", "/Users/tester")).toEqual({ ok: false, err: "Path must be absolute" });
    expect(validateGhqRoot("relative/path", "/Users/tester")).toEqual({ ok: false, err: "Path must be absolute (start with / or ~)" });
    expect(validateGhqRoot("~/src", "/Users/tester")).toEqual({ ok: true, path: "/Users/tester/src" });
    expect(validateGhqRoot("/opt/Code", "/Users/tester")).toEqual({ ok: true, path: "/opt/Code" });

    expect(validatePeerUrl("")).toBe("URL required");
    expect(validatePeerUrl("ftp://host")).toBe("URL must start with http:// or https://");
    expect(validatePeerUrl("http://[broken")).toContain("Invalid URL");
    expect(validatePeerUrl("https://white.example.test:3456/path")).toBeNull();

    expect(validatePeerName("mba")).toBeNull();
    expect(validatePeerName("peer-31-chars-ok-1234567890x")).toBeNull();
    expect(validatePeerName("bad_name")).toContain("Name must");
    expect(validatePeerName("x".repeat(32))).toContain("Name must");
  });

  test("prompt loop retries invalid node names, warns for missing token, and skips peers when federation is declined", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const calls: Array<{ question: string; defaultVal?: string }> = [];
    const writes: string[] = [];
    const ask = scriptedAsk(["bad_name", "-bad", "white-1", "", "n"], calls);

    const result = await runPromptLoop(ask, { node: "white" }, "/Users/tester", (msg) => writes.push(msg));

    expect(result).toEqual({ node: "white-1", token: "", federate: false, peers: [] });
    expect(calls.map((call) => call.question)).toEqual([
      "Node name (this machine's identity in the federation)",
      "Node name (this machine's identity in the federation)",
      "Node name (this machine's identity in the federation)",
      "Claude token (blank = use $CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/credentials)",
      "Federate with other machines? (y/N)",
    ]);
    expect(writes.join("\n")).toContain("Node name must be 1-63 chars");
    expect(writes.join("\n")).toContain("no token provided");
  });

  test("prompt loop aborts after three invalid node attempts", async () => {
    const writes: string[] = [];
    const ask = scriptedAsk(["bad_name", "also_bad", "still_bad"], []);

    await expect(runPromptLoop(ask, { node: "white" }, "/Users/tester", (msg) => writes.push(msg))).rejects.toThrow(
      "Aborted after 3 invalid attempts: Node name (this machine's identity in the federation)",
    );
    expect(writes).toHaveLength(3);
    expect(writes.every((msg) => msg.includes("Node name must"))).toBe(true);
  });

  test("prompt loop accepts env token fallback, validates peer URLs, retries peer names, and stops on done", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";
    const calls: Array<{ question: string; defaultVal?: string }> = [];
    const writes: string[] = [];
    const ask = scriptedAsk([
      "white",
      "",
      "YES",
      "not-a-url",
      "http://mba.local:3456",
      "bad_name",
      "mba-1",
      "done",
    ], calls);

    const result = await runPromptLoop(ask, { node: "default-node" }, "/Users/tester", (msg) => writes.push(msg));

    expect(result).toEqual({
      node: "white",
      token: "",
      federate: true,
      peers: [{ name: "mba-1", url: "http://mba.local:3456" }],
    });
    expect(calls.map((call) => `${call.question}=${call.defaultVal}`)).toEqual([
      "Node name (this machine's identity in the federation)=default-node",
      "Claude token (blank = use $CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/credentials)=",
      "Federate with other machines? (y/N)=N",
      "Peer 1 URL=done",
      "Peer 1 URL=done",
      "Peer 1 name (short label)=peer-1",
      "Peer 1 name (short label)=peer-1",
      "Peer 2 URL=done",
    ]);
    expect(writes.join("\n")).toContain("URL must start with http:// or https://");
    expect(writes.join("\n")).toContain("Name must be 1-31 chars");
    expect(writes.join("\n")).not.toContain("no token provided");
  });
});
