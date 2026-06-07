import { describe, expect, mock, test } from "bun:test";

mock.module("fs", () => ({
  openSync: () => {
    throw new Error("no controlling tty");
  },
  createReadStream: () => {
    throw new Error("createReadStream should not run when /dev/tty is unavailable");
  },
}));

const { ttyAsk } = await import("../../src/vendor/mpr-plugins/init/prompts.ts?ttyask-extra-coverage");

describe("init prompt ttyAsk extra coverage", () => {
  test("ttyAsk reports non-interactive environments before creating readline", async () => {
    await expect(ttyAsk("Node name", "m5")).rejects.toThrow("/dev/tty unavailable — use --non-interactive");
  });
});
