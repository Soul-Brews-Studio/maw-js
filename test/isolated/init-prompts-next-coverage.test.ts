import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AskFn } from "../../src/vendor/mpr-plugins/init/prompts";

let ttyMode: "success" | "fail" = "success";
let nextTtyAnswer = "";
let ttyPrompts: string[] = [];
let streamCalls: Array<{ path: string; fd: number }> = [];
let closeCount = 0;
let originalToken: string | undefined;

mock.module("fs", () => ({
  openSync: (path: string, flags: string) => {
    expect(path).toBe("/dev/tty");
    expect(flags).toBe("r+");
    if (ttyMode === "fail") throw new Error("no tty");
    return 777;
  },
  createReadStream: (path: string, opts: { fd: number }) => {
    streamCalls.push({ path, fd: opts.fd });
    return { path, fd: opts.fd };
  },
}));

mock.module("readline", () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      ttyPrompts.push(prompt);
      cb(nextTtyAnswer);
    },
    close: () => {
      closeCount++;
    },
  }),
}));

const {
  runPromptLoop,
  ttyAsk,
  validateGhqRoot,
  validateNodeName,
  validatePeerName,
  validatePeerUrl,
} = await import("../../src/vendor/mpr-plugins/init/prompts.ts?init-prompts-next-coverage");

beforeEach(() => {
  originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  ttyMode = "success";
  nextTtyAnswer = "";
  ttyPrompts = [];
  streamCalls = [];
  closeCount = 0;
});

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

describe("init prompts next coverage", () => {
  test("ttyAsk reports missing /dev/tty as non-interactive guidance", async () => {
    ttyMode = "fail";

    await expect(ttyAsk("Node name")).rejects.toThrow("/dev/tty unavailable — use --non-interactive");
    expect(ttyPrompts).toEqual([]);
    expect(streamCalls).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test("ttyAsk opens /dev/tty, renders both prompt shapes, trims answers, and falls back to defaults", async () => {
    nextTtyAnswer = "   ";
    await expect(ttyAsk("Node name", "white")).resolves.toBe("white");

    nextTtyAnswer = "  mba  ";
    await expect(ttyAsk("Peer name")).resolves.toBe("mba");

    expect(ttyPrompts).toEqual(["Node name [white]: ", "Peer name: "]);
    expect(streamCalls).toEqual([
      { path: "/dev/tty", fd: 777 },
      { path: "/dev/tty", fd: 777 },
    ]);
    expect(closeCount).toBe(2);
  });

  test("runPromptLoop accepts an explicit token and uppercase federation yes before stopping on a blank peer URL", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const calls: Array<{ question: string; defaultVal?: string }> = [];
    const writes: string[] = [];
    const ask = scriptedAsk(["white", "direct-token", "Y", ""], calls);

    const result = await runPromptLoop(ask, { node: "default-node" }, "/Users/tester", (msg) => writes.push(msg));

    expect(result).toEqual({ node: "white", token: "direct-token", federate: true, peers: [] });
    expect(calls.map((call) => `${call.question}=${call.defaultVal}`)).toEqual([
      "Node name (this machine's identity in the federation)=default-node",
      "Claude token (blank = use $CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/credentials)=",
      "Federate with other machines? (y/N)=N",
      "Peer 1 URL=done",
    ]);
    expect(writes).toEqual([]);
  });

  test("validators and retry failures are covered in the ttyAsk-enabled module load", async () => {
    expect(validateNodeName("m5")).toBeNull();
    expect(validateNodeName("bad_name")).toContain("Node name must");
    expect(validateGhqRoot("", "/Users/tester")).toEqual({ ok: false, err: "Path must be absolute" });
    expect(validateGhqRoot("relative", "/Users/tester")).toEqual({
      ok: false,
      err: "Path must be absolute (start with / or ~)",
    });
    expect(validateGhqRoot("~/Code", "/Users/tester")).toEqual({ ok: true, path: "/Users/tester/Code" });
    expect(validatePeerUrl("")).toBe("URL required");
    expect(validatePeerUrl("ftp://host")).toBe("URL must start with http:// or https://");
    expect(validatePeerUrl("http://[broken")).toContain("Invalid URL");
    expect(validatePeerUrl("https://ok.example.test")).toBeNull();
    expect(validatePeerName("peer-1")).toBeNull();
    expect(validatePeerName("bad_name")).toContain("Name must");

    const writes: string[] = [];
    const invalidNodeAsk = scriptedAsk(["bad_name", "also_bad", "still_bad"], []);
    await expect(runPromptLoop(invalidNodeAsk, { node: "default-node" }, "/Users/tester", (msg) => writes.push(msg))).rejects.toThrow(
      "Aborted after 3 invalid attempts",
    );
    expect(writes).toHaveLength(3);
  });

  test("runPromptLoop retries invalid peer URL and peer name in the ttyAsk-enabled module load", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";
    const calls: Array<{ question: string; defaultVal?: string }> = [];
    const writes: string[] = [];
    const ask = scriptedAsk([
      "m5",
      "",
      "yes",
      "not-a-url",
      "https://white.example.test:3456",
      "bad_name",
      "white",
      "done",
    ], calls);

    const result = await runPromptLoop(ask, { node: "default-node" }, "/Users/tester", (msg) => writes.push(msg));

    expect(result).toEqual({
      node: "m5",
      token: "",
      federate: true,
      peers: [{ name: "white", url: "https://white.example.test:3456" }],
    });
    expect(calls.map((call) => call.question)).toContain("Peer 1 URL");
    expect(writes.join("\n")).toContain("URL must start with http:// or https://");
    expect(writes.join("\n")).toContain("Name must be 1-31 chars");
  });
});
