import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";
import { tmux } from "../../../core/transport/tmux-class";
import * as tmuxImpl from "../tmux/impl";

/**
 * Tests for `maw bg` — background tmux session verb (#1304).
 *
 * Uses spyOn on the live `tmux` singleton so we don't pollute the module
 * registry for sibling tests. Restored per-test via afterEach.
 */

const calls: {
  newSession: Array<{ name: string; opts: any }>;
  attach: string[];
  hasSession: string[];
} = { newSession: [], attach: [], hasSession: [] };

let existingSessions = new Set<string>();

describe("maw bg plugin", () => {
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

  it("default: spawns detached, does NOT attach", async () => {
    const result = await handler({ source: "cli", args: ["bg", "dev", "bun run dev"] });
    expect(result.ok).toBe(true);
    expect(calls.newSession).toHaveLength(1);
    expect(calls.newSession[0].name).toBe("dev");
    expect(calls.newSession[0].opts.command).toBe("bun run dev");
    expect(calls.newSession[0].opts.cwd).toBeDefined();
    expect(calls.attach).toEqual([]);
    expect(result.output).toContain("spawned (detached)");
  });

  it("--attach: spawns AND attaches", async () => {
    const result = await handler({ source: "cli", args: ["bg", "srv", "bun run dev", "--attach"] });
    expect(result.ok).toBe(true);
    expect(calls.newSession).toHaveLength(1);
    expect(calls.newSession[0].opts.command).toBe("bun run dev");
    expect(calls.attach).toEqual(["srv"]);
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: ["bg"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("name required");
    expect(calls.newSession).toHaveLength(0);
  });

  it("missing command: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: ["bg", "lonely"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("command required");
    expect(calls.newSession).toHaveLength(0);
  });

  it("existing session: fails loudly", async () => {
    existingSessions.add("dev");
    const result = await handler({ source: "cli", args: ["bg", "dev", "bun run dev"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
    expect(calls.newSession).toHaveLength(0);
    expect(calls.attach).toHaveLength(0);
  });

  it("--help: prints usage", async () => {
    const result = await handler({ source: "cli", args: ["bg", "--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw bg");
    expect(calls.newSession).toHaveLength(0);
  });
});
