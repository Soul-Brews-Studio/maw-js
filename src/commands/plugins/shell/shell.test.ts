import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";
import { tmux } from "../../../core/transport/tmux-class";
import * as tmuxImpl from "../tmux/impl";

/**
 * Tests for `maw shell` — interactive tmux session verb (#1304).
 *
 * We spy on the live `tmux` singleton's methods (rather than `mock.module`)
 * so we don't pollute the module registry for sibling plugin tests that
 * legitimately import `Tmux` / `tmux-pane-tags`. spyOn is restored in
 * afterEach, so each test starts clean.
 */

const calls: {
  newSession: Array<{ name: string; opts: any }>;
  attach: string[];
  hasSession: string[];
} = { newSession: [], attach: [], hasSession: [] };

let existingSessions = new Set<string>();

describe("maw shell plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;
  let hasSpy: ReturnType<typeof spyOn>;
  let newSpy: ReturnType<typeof spyOn>;
  let attachSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    calls.newSession.length = 0;
    calls.attach.length = 0;
    calls.hasSession.length = 0;
    existingSessions = new Set();

    hasSpy = spyOn(tmux, "hasSession").mockImplementation(async (name: string) => {
      calls.hasSession.push(name);
      return existingSessions.has(name);
    });
    newSpy = spyOn(tmux, "newSession").mockImplementation(async (name: string, opts: any) => {
      calls.newSession.push({ name, opts });
    });
    attachSpy = spyOn(tmuxImpl, "cmdTmuxAttach").mockImplementation((target: string) => {
      calls.attach.push(target);
    });

    const mod = await import("./index");
    handler = mod.default;
  });

  afterEach(() => {
    hasSpy.mockRestore();
    newSpy.mockRestore();
    attachSpy.mockRestore();
    mock.restore();
  });

  it("default: creates session + attaches", async () => {
    const result = await handler({ source: "cli", args: ["shell", "scratch"] });
    expect(result.ok).toBe(true);
    expect(calls.newSession).toHaveLength(1);
    expect(calls.newSession[0].name).toBe("scratch");
    expect(calls.newSession[0].opts.cwd).toBeDefined();
    expect(calls.attach).toEqual(["scratch"]);
  });

  it("--no-attach: creates session, does NOT attach", async () => {
    const result = await handler({ source: "cli", args: ["shell", "svc", "--no-attach"] });
    expect(result.ok).toBe(true);
    expect(calls.newSession).toHaveLength(1);
    expect(calls.newSession[0].name).toBe("svc");
    expect(calls.attach).toEqual([]);
    expect(result.output).toContain("created (detached)");
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: ["shell"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
    expect(calls.newSession).toHaveLength(0);
  });

  it("existing session: fails loudly", async () => {
    existingSessions.add("scratch");
    const result = await handler({ source: "cli", args: ["shell", "scratch"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
    expect(calls.newSession).toHaveLength(0);
    expect(calls.attach).toHaveLength(0);
  });

  it("--help: prints usage", async () => {
    const result = await handler({ source: "cli", args: ["shell", "--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw shell");
    expect(calls.newSession).toHaveLength(0);
  });
});
