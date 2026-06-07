/**
 * is-agent-command-config.test.ts — #10, config.commands branch.
 *
 * isAgentCommand also matches panes whose command equals a binary from
 * `config.commands`. That match used a loose `.includes()` substring, so a
 * configured `node`-launched agent made every `nodemon` / `node-*` pane look
 * like an agent. #10 tightens it to an exact (whole-name) comparison.
 *
 * Isolated: mocks src/config (mock.module is process-global) so the
 * config.commands map is controllable. The plain-name regex branch is
 * covered without mocks in test/is-agent-command.test.ts.
 */
import { describe, test, expect, beforeAll, mock } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({
    node: "test-node",
    commands: {
      // bin tokens: "myagent", "node", "default" (the "default" key's value
      // is intentionally the literal string the loop skips on)
      primary: "myagent --run --flag",
      secondary: "node /opt/agent/index.js",
      default: "default",
    },
  }));
});

let isAgentCommand: typeof import("../../src/core/transport/ssh").isAgentCommand;

beforeAll(async () => {
  isAgentCommand = (await import("../../src/core/transport/ssh")).isAgentCommand;
});

describe("isAgentCommand — config.commands exact match (#10)", () => {
  test("matches a configured binary by exact command name", () => {
    expect(isAgentCommand("myagent")).toBe(true);
  });

  test("does NOT match commands that merely contain a configured binary name", () => {
    expect(isAgentCommand("myagentx")).toBe(false);
    expect(isAgentCommand("xmyagent")).toBe(false);
    expect(isAgentCommand("my-myagent-wrapper")).toBe(false);
  });

  test("a configured `node`-launched agent does not make nodemon look like an agent", () => {
    // "node" is a configured bin (secondary) AND a name-regex match — bare
    // `node` is an agent, but `nodemon` must not inherit that.
    expect(isAgentCommand("node")).toBe(true);
    expect(isAgentCommand("nodemon")).toBe(false);
  });

  test("the literal 'default' key value is still skipped", () => {
    expect(isAgentCommand("default")).toBe(false);
  });
});
