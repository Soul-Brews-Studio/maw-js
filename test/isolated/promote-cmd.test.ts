/**
 * #1910 — cmdPromote tests.
 *
 * All deps stubbed via the CmdPromoteDeps test seam — no live tmux required.
 */
import { describe, test, expect } from "bun:test";
import { cmdPromote, resolvePromoteTarget, type CmdPromoteDeps } from "../../src/commands/shared/promote-cmd";

function makeDeps(overrides: Partial<CmdPromoteDeps> = {}): CmdPromoteDeps & { logs: string[]; errors: string[]; calls: any[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const calls: any[] = [];
  return {
    logs,
    errors,
    calls,
    log: (l: string) => logs.push(l),
    error: (l: string) => errors.push(l),
    listAll: async () => [
      { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "test-cli" }] },
      { name: "scratch", windows: [{ name: "scratch" }] },
    ],
    hasSession: async (_n: string) => false,
    listWindows: async (s: string) => {
      calls.push(["listWindows", s]);
      if (s === "77-mawjs") return [{ name: "mawjs-oracle" }, { name: "test-cli" }];
      if (s === "scratch") return [{ name: "scratch" }];
      if (s === "isolated") return [{ name: "test-cli" }, { name: "__promote_placeholder__" }];
      return [];
    },
    newSession: async (n: string, opts) => { calls.push(["newSession", n, opts]); return undefined; },
    killSession: async (n: string) => { calls.push(["killSession", n]); },
    killWindow: async (t: string) => { calls.push(["killWindow", t]); },
    run: async (sub: string, ...args: string[]) => { calls.push(["run", sub, ...args]); return ""; },
    switchClient: async (s: string) => { calls.push(["switchClient", s]); },
    callerInTmux: () => true,
    ...overrides,
  };
}

describe("resolvePromoteTarget (#1910)", () => {
  const sessions = [
    { name: "77-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "test-cli" }] },
    { name: "scratch", windows: [{ name: "scratch" }] },
  ];
  const listAll = async () => sessions;

  test("qualified session:window trusted as-is", async () => {
    const r = await resolvePromoteTarget("77-mawjs:test-cli", listAll);
    expect(r).toEqual({ session: "77-mawjs", window: "test-cli" });
  });

  test("qualified session:window with tmux trailing-dash display suffix resolves to canonical window", async () => {
    const r = await resolvePromoteTarget("77-mawjs:test-cli-", listAll);
    expect(r).toEqual({ session: "77-mawjs", window: "test-cli" });
  });

  test("bare name with single match resolves cleanly", async () => {
    const r = await resolvePromoteTarget("test-cli", listAll);
    expect(r).toEqual({ session: "77-mawjs", window: "test-cli" });
  });

  test("bare name with tmux trailing-dash display suffix resolves to canonical window", async () => {
    const r = await resolvePromoteTarget("test-cli-", listAll);
    expect(r).toEqual({ session: "77-mawjs", window: "test-cli" });
  });

  test("bare name with no match returns { kind: 'none' }", async () => {
    const r = await resolvePromoteTarget("nosuch", listAll);
    expect(r).toEqual({ kind: "none" });
  });

  test("bare name with multiple matches returns ambiguous candidates", async () => {
    const ambiguousSessions = [
      { name: "alpha", windows: [{ name: "shared" }] },
      { name: "beta", windows: [{ name: "shared" }] },
    ];
    const r = await resolvePromoteTarget("shared", async () => ambiguousSessions);
    expect((r as any).kind).toBe("ambiguous");
    expect((r as any).candidates).toEqual([
      { session: "alpha", window: "shared" },
      { session: "beta", window: "shared" },
    ]);
  });
});

describe("cmdPromote (#1910)", () => {
  test("missing target → throws + prints usage", async () => {
    const deps = makeDeps();
    await expect(cmdPromote([], deps)).rejects.toThrow(/missing window/);
    expect(deps.errors.some(e => e.startsWith("usage: maw promote"))).toBe(true);
  });

  test("--help prints usage and exits without throwing", async () => {
    const deps = makeDeps();
    await cmdPromote(["--help"], deps);
    expect(deps.errors.some(e => e.startsWith("usage: maw promote"))).toBe(true);
  });

  test("qualified target — happy path — creates dest, moves window, kills placeholder", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps);

    expect(deps.calls).toContainEqual(["newSession", "isolated", { window: "__promote_placeholder__" }]);
    expect(deps.calls).toContainEqual(["run", "move-window", "-s", "77-mawjs:test-cli", "-t", "isolated:"]);
    expect(deps.calls).toContainEqual(["killWindow", "isolated:__promote_placeholder__"]);
    expect(deps.logs.some(l => l.includes("✓") && l.includes("promoted — 77-mawjs:test-cli → isolated:test-cli"))).toBe(true);
    expect(deps.logs.some(l => l.includes("↻ undo: tmux move-window"))).toBe(true);
  });

  test("bare-name ambiguous → refuses with candidates listed", async () => {
    const deps = makeDeps({
      listAll: async () => [
        { name: "alpha", windows: [{ name: "shared" }] },
        { name: "beta", windows: [{ name: "shared" }] },
      ],
    });
    await expect(cmdPromote(["shared"], deps)).rejects.toThrow(/matches 2 windows/);
    expect(deps.errors.some(e => e.includes("'shared' is ambiguous"))).toBe(true);
    expect(deps.errors.some(e => e.includes("alpha:shared"))).toBe(true);
    expect(deps.errors.some(e => e.includes("beta:shared"))).toBe(true);
  });

  test("source-is-only-window → refuses with rename hint", async () => {
    const deps = makeDeps({
      listAll: async () => [{ name: "solo", windows: [{ name: "lonely" }] }],
      listWindows: async () => [{ name: "lonely" }],
    });
    await expect(cmdPromote(["solo:lonely", "--as", "newhome"], deps)).rejects.toThrow(/only window in 'solo'/);
    expect(deps.errors.some(e => e.includes("only window in session 'solo'"))).toBe(true);
    expect(deps.errors.some(e => e.includes("tmux rename-session"))).toBe(true);
    expect(deps.calls.find(c => c[0] === "newSession")).toBeUndefined();
    expect(deps.calls.find(c => c[0] === "run")).toBeUndefined();
  });

  test("destination exists without --force → refuses with hint", async () => {
    const deps = makeDeps({
      hasSession: async (n) => n === "isolated",
    });
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps)).rejects.toThrow(/already exists/);
    expect(deps.errors.some(e => e.includes("session 'isolated' already exists"))).toBe(true);
    expect(deps.errors.some(e => e.includes("--force"))).toBe(true);
    expect(deps.calls.find(c => c[0] === "newSession")).toBeUndefined();
  });

  test("destination exists with --force → skips newSession, just move-window", async () => {
    const deps = makeDeps({
      hasSession: async (n) => n === "isolated",
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated", "--force"], deps);
    expect(deps.calls.find(c => c[0] === "newSession")).toBeUndefined();
    expect(deps.calls.find(c => c[0] === "killWindow")).toBeUndefined();
    expect(deps.calls).toContainEqual(["run", "move-window", "-s", "77-mawjs:test-cli", "-t", "isolated:"]);
  });

  test("--as with invalid session name → throws via validateForeignSessionName", async () => {
    const deps = makeDeps();
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "bad name"], deps)).rejects.toThrow(/invalid target session/);
    expect(deps.calls.find(c => c[0] === "newSession")).toBeUndefined();
  });

  test("--attach in tmux → switch-client called", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      callerInTmux: () => true,
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated", "--attach"], deps);
    expect(deps.calls).toContainEqual(["switchClient", "isolated"]);
  });

  test("--attach when headless → warning + no switch-client", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      callerInTmux: () => false,
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated", "--attach"], deps);
    expect(deps.calls.find(c => c[0] === "switchClient")).toBeUndefined();
    expect(deps.logs.some(l => l.includes("⚠") && l.includes("--attach ignored"))).toBe(true);
    expect(deps.logs.some(l => l.includes("maw a isolated"))).toBe(true);
  });

  test("--attach switchClient failure → logs warning, doesn't throw", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      callerInTmux: () => true,
      switchClient: async () => { throw new Error("no current client"); },
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated", "--attach"], deps);
    expect(deps.logs.some(l => l.includes("--attach failed: no current client"))).toBe(true);
    expect(deps.logs.some(l => l.includes("switch manually: tmux switch-client -t isolated"))).toBe(true);
  });

  test("placeholder kill failure silently ignored — promote still reports success", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      killWindow: async () => { throw new Error("window already gone"); },
    });
    await cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps);
    expect(deps.logs.some(l => l.includes("✓") && l.includes("promoted"))).toBe(true);
  });

  test("move-window failure → throws UserError with tmux reason", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      run: async (sub) => {
        if (sub === "move-window") throw new Error("permission denied");
        return "";
      },
    });
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps))
      .rejects.toThrow(/tmux move failed — permission denied/);
    expect(deps.calls).toContainEqual(["killSession", "isolated"]);
  });

  test("move-window failure rollback falls back to killing placeholder window", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      killSession: async (n) => {
        deps.calls.push(["killSession", n]);
        throw new Error("session busy");
      },
      run: async (sub) => {
        if (sub === "move-window") throw new Error("permission denied");
        return "";
      },
    });
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps))
      .rejects.toThrow(/tmux move failed — permission denied/);
    expect(deps.calls).toContainEqual(["killSession", "isolated"]);
    expect(deps.calls).toContainEqual(["killWindow", "isolated:__promote_placeholder__"]);
  });

  test("move-window silent no-op → verifies destination and rolls back placeholder session", async () => {
    const deps = makeDeps({
      hasSession: async () => false,
      listWindows: async (s: string) => {
        deps.calls.push(["listWindows", s]);
        if (s === "77-mawjs") return [{ name: "mawjs-oracle" }, { name: "test-cli" }];
        if (s === "isolated") return [{ name: "__promote_placeholder__" }];
        return [];
      },
    });
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps))
      .rejects.toThrow(/did not appear in 'isolated'.*rolled back placeholder session/);
    expect(deps.calls).toContainEqual(["run", "move-window", "-s", "77-mawjs:test-cli", "-t", "isolated:"]);
    expect(deps.calls).toContainEqual(["killSession", "isolated"]);
  });

  test("listWindows failure → throws UserError with source-list reason", async () => {
    const deps = makeDeps({
      listWindows: async () => { throw new Error("tmux server lost"); },
    });
    await expect(cmdPromote(["77-mawjs:test-cli", "--as", "isolated"], deps))
      .rejects.toThrow(/cannot list windows in source session '77-mawjs': tmux server lost/);
  });

  test("bare-name resolve no-match → throws UserError", async () => {
    const deps = makeDeps();
    await expect(cmdPromote(["nosuch"], deps)).rejects.toThrow(/no window matches 'nosuch'/);
  });
});
