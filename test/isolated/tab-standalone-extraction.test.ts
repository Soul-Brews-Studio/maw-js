import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const peekCalls: string[] = [];
const sendCalls: Array<{ target: string; message: string; force: boolean }> = [];
const talkToCalls: Array<{ target: string; message: string; force: boolean }> = [];
const talkToPath = import.meta.resolve("../../src/vendor/mpr-plugins/tab/internal/talk-to-impl.ts");

mock.module("maw-js/sdk", () => ({
  tmux: {
    run: async (subcommand: string) => subcommand === "display-message" ? "01-neo\n" : "",
  },
  tmuxCmd: () => "tmux",
  hostExec: async () => "0:main:1\n1:logs:0\n",
  cmdPeek: async (target: string) => { peekCalls.push(target); },
  cmdSend: async (target: string, message: string, force = false) => { sendCalls.push({ target, message, force }); },
}));

mock.module(talkToPath, () => ({
  cmdTalkTo: async (target: string, message: string, force = false) => {
    talkToCalls.push({ target, message, force });
  },
}));

describe("tab standalone extraction prep (#2113)", () => {
  test("tab impl routes peek/send through SDK instead of shared comm", () => {
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/tab/impl.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
    expect(impl).not.toContain("maw-js/commands/shared/comm");
  });

  test("handler can peek and send with only SDK mocked", async () => {
    peekCalls.length = 0;
    sendCalls.length = 0;
    talkToCalls.length = 0;
    const handler = (await import("../../src/vendor/mpr-plugins/tab/index.ts?tab-standalone-extraction")).default;
    expect(await handler({ source: "cli", args: ["1"] })).toMatchObject({ ok: true });
    expect(await handler({ source: "cli", args: ["1", "hello", "there", "--force"] })).toMatchObject({ ok: true });
    expect(peekCalls).toEqual(["logs"]);
    expect(sendCalls).toEqual([{ target: "logs", message: "hello there", force: true }]);
  });
});
