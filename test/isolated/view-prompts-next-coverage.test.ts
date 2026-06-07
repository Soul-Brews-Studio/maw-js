import { describe, expect, mock, test } from "bun:test";

let openThrows = false;
let nextAnswer = "";
let lastPrompt = "";
let closeCount = 0;

mock.module("fs", () => ({
  openSync: () => {
    if (openThrows) throw new Error("no tty");
    return 42;
  },
  createReadStream: (_path: string, opts: unknown) => ({ path: "/dev/tty", opts }),
}));

mock.module("readline", () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      lastPrompt = prompt;
      cb(nextAnswer);
    },
    close: () => {
      closeCount += 1;
    },
  }),
}));

const prompts = await import("../../src/vendor/mpr-plugins/view/internal/prompts.ts?view-prompts-next-coverage");

describe("view prompts next coverage", () => {
  test("ttyAsk trims answers, renders defaults, and falls back to default on blank input", async () => {
    openThrows = false;
    closeCount = 0;
    nextAnswer = "  typed value  ";

    await expect(prompts.ttyAsk("Node", "default-node")).resolves.toBe("typed value");
    expect(lastPrompt).toBe("Node [default-node]: ");
    expect(closeCount).toBe(1);

    nextAnswer = "   ";
    await expect(prompts.ttyAsk("Peer URL", "done")).resolves.toBe("done");
    expect(lastPrompt).toBe("Peer URL [done]: ");
    expect(closeCount).toBe(2);
  });

  test("ttyAsk rejects when /dev/tty is unavailable", async () => {
    openThrows = true;
    await expect(prompts.ttyAsk("Node")).rejects.toThrow("/dev/tty unavailable — use --non-interactive");
    openThrows = false;
  });

  test("validatePeerUrl reports URL constructor failures after protocol validation", () => {
    expect(prompts.validatePeerUrl("http://[bad")).toBe("Invalid URL: http://[bad");
  });
});
