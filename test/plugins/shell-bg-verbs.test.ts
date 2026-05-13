import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import type { InvokeContext } from "../../src/plugin/types";
import { tmux } from "../../src/core/transport/tmux-class";
import * as tmuxImpl from "../../src/commands/plugins/tmux/impl";

/**
 * Tests for `maw shell` + `maw bg` — the two new verbs added in #1304.
 *
 * Combined into a single test file (rather than co-located per-plugin) for
 * a specific CI reason: when shipped as two separate files at
 * `src/commands/plugins/{bg,shell}/*.test.ts`, they shifted Bun's
 * `--shard=N/8 --isolate` partitioning so that `test/isolated/plugin-install.test.ts`
 * landed in shard 1 (it wasn't there in alpha baseline). That file hits a
 * Bun-runtime EEXIST/epoll_ctl bug at line 64 (`process.stderr.write` access
 * during `capture()`) on Linux CI but not macOS, cascading into 20 unrelated
 * test failures. Placing this combined file at `test/plugins/...` — which
 * sorts AFTER `test/isolated/plugin-install.test.ts` in path order — keeps
 * plugin-install's sort-index at its baseline value, restoring it to its
 * original (passing) shard. See PR #1307 ship retro.
 *
 * Mocking strategy: `spyOn(tmux, "method")` + `mockRestore` in afterEach so
 * the live `tmux` singleton is patched per-test only — avoids `mock.module`
 * global pollution that breaks sibling oracle/fleet tests via the `Tmux`
 * class export.
 */

const calls: {
  newSession: Array<{ name: string; opts: any }>;
  attach: string[];
  hasSession: string[];
} = { newSession: [], attach: [], hasSession: [] };

let existingSessions = new Set<string>();

function resetCalls(): void {
  calls.newSession.length = 0;
  calls.attach.length = 0;
  calls.hasSession.length = 0;
  existingSessions = new Set();
}

function installSpies(): { has: any; ns: any; att: any } {
  const has = spyOn(tmux, "hasSession").mockImplementation(async (name: string) => {
    calls.hasSession.push(name);
    return existingSessions.has(name);
  });
  const ns = spyOn(tmux, "newSession").mockImplementation(async (name: string, opts: any) => {
    calls.newSession.push({ name, opts });
  });
  const att = spyOn(tmuxImpl, "cmdTmuxAttach").mockImplementation((target: string) => {
    calls.attach.push(target);
  });
  return { has, ns, att };
}

// -----------------------------------------------------------------------------
// maw shell
// -----------------------------------------------------------------------------

describe("maw shell plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;
  let spies: { has: any; ns: any; att: any };

  beforeEach(async () => {
    resetCalls();
    spies = installSpies();
    const mod = await import("../../src/commands/plugins/shell/index");
    handler = mod.default;
  });

  afterEach(() => {
    spies.has.mockRestore();
    spies.ns.mockRestore();
    spies.att.mockRestore();
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

// -----------------------------------------------------------------------------
// maw bg
// -----------------------------------------------------------------------------

describe("maw bg plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;
  let spies: { has: any; ns: any; att: any };

  beforeEach(async () => {
    resetCalls();
    spies = installSpies();
    const mod = await import("../../src/commands/plugins/bg/index");
    handler = mod.default;
  });

  afterEach(() => {
    spies.has.mockRestore();
    spies.ns.mockRestore();
    spies.att.mockRestore();
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
