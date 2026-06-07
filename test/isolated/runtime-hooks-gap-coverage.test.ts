import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let readFileMode: "missing" | "configured" = "missing";
const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnThrows = false;

mock.module("fs/promises", () => ({
  readFile: async () => {
    if (readFileMode === "missing") throw new Error("no hooks config");
    return JSON.stringify({
      hooks: {
        after_send: "~/bin/after-send",
        before_send: "/tmp/before-send",
      },
    });
  },
}));

mock.module("child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    if (spawnThrows) throw new Error("spawn failed");
    spawnCalls.push({ command, args, options });
    return { unref: () => undefined };
  },
}));

beforeEach(() => {
  readFileMode = "missing";
  spawnCalls.length = 0;
  spawnThrows = false;
  delete process.env.CLAUDE_AGENT_NAME;
});

afterEach(() => {
  delete process.env.CLAUDE_AGENT_NAME;
});

describe("runtime hook coverage gaps", () => {
  test("missing config caches an empty hook map", async () => {
    const { runHook } = await import("../../src/core/runtime/hooks.ts?gap-missing");

    await runHook("after_send", { to: "receiver", message: "hello" });
    await runHook("after_send", { to: "receiver", message: "again" });

    expect(spawnCalls).toEqual([]);
  });

  test("configured hooks expand scripts, infer env, and swallow spawn failures", async () => {
    readFileMode = "configured";
    process.env.CLAUDE_AGENT_NAME = "codex";
    const { runHook } = await import("../../src/core/runtime/hooks.ts?gap-configured");

    await runHook("after_send", { to: "receiver", message: "hello" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.command).toBe("sh");
    expect(spawnCalls[0]!.args).toEqual(["-c", expect.stringContaining("/bin/after-send")]);
    expect(spawnCalls[0]!.options).toMatchObject({
      stdio: "ignore",
      detached: true,
    });
    expect(spawnCalls[0]!.options.env).toMatchObject({
      MAW_EVENT: "after_send",
      MAW_FROM: "codex",
      MAW_TO: "receiver",
      MAW_MESSAGE: "hello",
      MAW_CHANNEL: "hey",
    });

    spawnThrows = true;
    await expect(runHook("before_send", {
      from: "sender",
      to: "receiver",
      message: "blocked",
      channel: "direct",
    })).resolves.toBeUndefined();
  });
});
