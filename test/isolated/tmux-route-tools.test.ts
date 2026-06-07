import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let hostCommands: string[] = [];

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "local",
  node: "m5",
  port: 3456,
  sessions: {},
})));

mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: async (cmd: string) => {
    hostCommands.push(cmd);
    if (cmd.includes("capture-pane")) return "PEEKED";
    return "";
  },
  ssh: async (cmd: string) => {
    hostCommands.push(cmd);
    return "";
  },
}));

describe("routeTools tmux core route", () => {
  let originalWrite: typeof process.stdout.write;
  let stdout: string[];

  beforeEach(() => {
    hostCommands = [];
    stdout = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("maw tmux peek streams output without recursive console writer (#1459)", async () => {
    const { routeTools } = await import("../../src/cli/route-tools");

    const handled = await routeTools("tmux", ["tmux", "peek", "47-mawjs:2.0", "--lines", "1"]);

    expect(handled).toBe(true);
    expect(stdout.join("")).toContain("PEEKED");
    expect(hostCommands.some((cmd) => cmd.includes("tmux capture-pane"))).toBe(true);
  });
});
