import { describe, it, expect, beforeEach } from "bun:test";
import type { InvokeContext } from "../../src/plugin/types";
import { cmdShell } from "../../src/commands/plugins/shell/impl";
import { cmdBg } from "../../src/commands/plugins/bg/impl";

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
 * Mocking strategy (#1309): Behavioral tests call `cmdShell` / `cmdBg`
 * directly with `{tmux, attachFn}` dependency-injection fakes. This
 * sidesteps the `spyOn(tmux, ...)` foot-gun: under `bun run test` (no
 * `--isolate`), sibling test files can mock `ssh.ts` or replace
 * properties on the `tmux` singleton with Promises, leaving spyOn's
 * `mockRestore` unable to clean up — 6 of 11 tests would fail with
 * module-pollution. DI fakes never touch the singleton, so module
 * order is irrelevant.
 *
 * Handler-level concerns (parseFlags, --help, missing-arg usage prints)
 * are still tested via the index.ts `handler` — those code paths
 * short-circuit before touching tmux, so no mocking is needed.
 *
 * Arg-shape note (#1306): ctx.args from the real CLI dispatcher does NOT
 * include the command name (the dispatcher strips it via
 * `args.slice(matchedWords)`). The original #1304 tests passed
 * `["shell", "scratch"]` which masked a parseFlags(…, skip=1) bug that made
 * `maw shell foo` always fail at the real CLI. Tests below pass the real
 * shape `["scratch"]` so they would catch the regression next time.
 */

interface FakeTmux {
  hasSession: (name: string) => Promise<boolean>;
  newSession: (name: string, opts: { cwd?: string; command?: string }) => Promise<void>;
  _calls: {
    hasSession: string[];
    newSession: Array<{ name: string; opts: { cwd?: string; command?: string } }>;
  };
}

function makeFakeTmux(existing: Set<string> = new Set()): FakeTmux {
  const calls = {
    hasSession: [] as string[],
    newSession: [] as Array<{ name: string; opts: { cwd?: string; command?: string } }>,
  };
  return {
    _calls: calls,
    async hasSession(name: string): Promise<boolean> {
      calls.hasSession.push(name);
      return existing.has(name);
    },
    async newSession(name: string, opts: { cwd?: string; command?: string }): Promise<void> {
      calls.newSession.push({ name, opts });
    },
  };
}

function makeAttachFn(): { fn: (target: string) => void; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: (target: string) => { calls.push(target); },
  };
}

// -----------------------------------------------------------------------------
// maw shell — impl (DI-injected)
// -----------------------------------------------------------------------------

describe("maw shell impl", () => {
  let tmux: FakeTmux;
  let attach: { fn: (t: string) => void; calls: string[] };

  beforeEach(() => {
    tmux = makeFakeTmux();
    attach = makeAttachFn();
  });

  it("default: creates session + attaches", async () => {
    await cmdShell("scratch", { tmux, attachFn: attach.fn });
    expect(tmux._calls.newSession).toHaveLength(1);
    expect(tmux._calls.newSession[0].name).toBe("scratch");
    expect(tmux._calls.newSession[0].opts.cwd).toBeDefined();
    expect(attach.calls).toEqual(["scratch"]);
  });

  it("--no-attach: creates session, does NOT attach", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      await cmdShell("svc", { attach: false, tmux, attachFn: attach.fn });
    } finally {
      console.log = origLog;
    }
    expect(tmux._calls.newSession).toHaveLength(1);
    expect(tmux._calls.newSession[0].name).toBe("svc");
    expect(attach.calls).toEqual([]);
    expect(logs.join("\n")).toContain("created (detached)");
  });

  it("existing session: fails loudly", async () => {
    tmux = makeFakeTmux(new Set(["scratch"]));
    let err: unknown;
    try {
      await cmdShell("scratch", { tmux, attachFn: attach.fn });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("already exists");
    expect(tmux._calls.newSession).toHaveLength(0);
    expect(attach.calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// maw shell — handler-level (parseFlags / usage prints; no tmux contact)
// -----------------------------------------------------------------------------

describe("maw shell handler", () => {
  let handler: (ctx: InvokeContext) => Promise<{ ok: boolean; output?: string; error?: string }>;

  beforeEach(async () => {
    const mod = await import("../../src/commands/plugins/shell/index");
    handler = mod.default;
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("--help: prints usage", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw shell");
  });
});

// -----------------------------------------------------------------------------
// maw bg — impl (DI-injected)
// -----------------------------------------------------------------------------

describe("maw bg impl", () => {
  let tmux: FakeTmux;
  let attach: { fn: (t: string) => void; calls: string[] };

  beforeEach(() => {
    tmux = makeFakeTmux();
    attach = makeAttachFn();
  });

  it("default: spawns detached, does NOT attach", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      await cmdBg("dev", "bun run dev", { tmux, attachFn: attach.fn });
    } finally {
      console.log = origLog;
    }
    expect(tmux._calls.newSession).toHaveLength(1);
    expect(tmux._calls.newSession[0].name).toBe("dev");
    expect(tmux._calls.newSession[0].opts.command).toBe("bun run dev");
    expect(tmux._calls.newSession[0].opts.cwd).toBeDefined();
    expect(attach.calls).toEqual([]);
    expect(logs.join("\n")).toContain("spawned (detached)");
  });

  it("--attach: spawns AND attaches", async () => {
    await cmdBg("srv", "bun run dev", { attach: true, tmux, attachFn: attach.fn });
    expect(tmux._calls.newSession).toHaveLength(1);
    expect(tmux._calls.newSession[0].opts.command).toBe("bun run dev");
    expect(attach.calls).toEqual(["srv"]);
  });

  it("existing session: fails loudly", async () => {
    tmux = makeFakeTmux(new Set(["dev"]));
    let err: unknown;
    try {
      await cmdBg("dev", "bun run dev", { tmux, attachFn: attach.fn });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("already exists");
    expect(tmux._calls.newSession).toHaveLength(0);
    expect(attach.calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// maw bg — handler-level (parseFlags / usage prints; no tmux contact)
// -----------------------------------------------------------------------------

describe("maw bg handler", () => {
  let handler: (ctx: InvokeContext) => Promise<{ ok: boolean; output?: string; error?: string }>;

  beforeEach(async () => {
    const mod = await import("../../src/commands/plugins/bg/index");
    handler = mod.default;
  });

  it("missing name: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("name required");
  });

  it("missing command: prints usage and errors", async () => {
    const result = await handler({ source: "cli", args: ["lonely"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("command required");
  });

  it("--help: prints usage", async () => {
    const result = await handler({ source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw bg");
  });
});
