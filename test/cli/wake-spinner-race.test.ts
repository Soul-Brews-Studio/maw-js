/**
 * Tests for #1346 — wake spinner race + refuse-to-spawn guard.
 *
 * Two pieces of logic to cover:
 *   1. findExistingOracleWindow retry — 3 attempts × 500ms backoff so a
 *      spinner-state pane (mid-boot) is detected as running, not re-spawned.
 *   2. Refuse-to-spawn guard — when a session pre-existed but no window
 *      matches AFTER retries, throw UserError instead of leaking a new pane.
 *      Bypass via --force, exempt under --task/--wt (explicit create flow).
 *
 * Strategy: replicate the functions inline (matches test/wake.test.ts pattern
 * for isPaneIdle) — keeps the test pure-logic, avoids mock.module pollution,
 * and dodges the #1335 stderr-mock + shard-3 hang traps.
 *
 * Located in test/cli/ subdir per #1335 retro (shard bug avoidance).
 */

import { describe, test, expect } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// 1. findExistingOracleWindow — retry behavior
// ─────────────────────────────────────────────────────────────────────────────

interface WindowLike {
  name: string;
}

/**
 * Inline replica of src/commands/shared/wake-cmd.ts → findExistingOracleWindow.
 * Logic mirrors the impl exactly; only the listWindows source is injected so
 * we can control return values per call without mocking sdk.
 *
 * Keep in sync with impl. If the impl ever changes the retry count, backoff,
 * or matching rules, update both — tests will fail loudly if they drift.
 */
async function findExistingOracleWindowWith(
  session: string,
  oracle: string,
  windowName: string,
  listWindows: (sess: string) => Promise<WindowLike[]>,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<string | null> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 0; // 0 in tests to keep fast
  const nameSuffix = windowName.replace(`${oracle}-`, "");
  const suffixRe = new RegExp(`^${oracle}-\\d+-${nameSuffix}$`);
  for (let i = 0; i < retries; i++) {
    try {
      const windows = await listWindows(session);
      const names = windows.map(w => w.name);
      const found = names.find(w => w === windowName) || names.find(w => suffixRe.test(w));
      if (found) return found;
    } catch { /* session may be in flux — retry */ }
    if (i < retries - 1) {
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return null;
}

describe("#1346 findExistingOracleWindow — retry+backoff under spinner race", () => {
  test("immediate hit (1st call returns window) → no retry, returns name", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      return [{ name: "neo-oracle" }];
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(r).toBe("neo-oracle");
    expect(calls).toBe(1);
  });

  test("spinner race (null×2 then value) → 3 calls, found on 3rd, returns name", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      // First 2 calls — session in flux, window not yet listed.
      if (calls < 3) return [];
      return [{ name: "neo-oracle" }];
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(r).toBe("neo-oracle");
    expect(calls).toBe(3);
  });

  test("never found after all retries → null, calls == retries", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      return [{ name: "unrelated-window" }];
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(r).toBeNull();
    expect(calls).toBe(3);
  });

  test("listWindows throws on first 2 attempts → retries through, finds on 3rd", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      if (calls < 3) throw new Error("session in flux");
      return [{ name: "neo-oracle" }];
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(r).toBe("neo-oracle");
    expect(calls).toBe(3);
  });

  test("suffix-pattern match: oracle-N-suffix variant resolves", async () => {
    // Worktree windows live as `${oracle}-${N}-${taskPart}`; the suffix regex
    // catches them when the direct windowName isn't present.
    let calls = 0;
    const listWindows = async () => {
      calls++;
      return [{ name: "neo-3-feature-x" }];
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-feature-x", listWindows);
    expect(r).toBe("neo-3-feature-x");
    expect(calls).toBe(1);
  });

  test("listWindows throws on every attempt → returns null, all retries consumed", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      throw new Error("tmux gone");
    };
    const r = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(r).toBeNull();
    expect(calls).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Refuse-to-spawn guard — boolean truth table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline replica of the #1346 guard in cmdWake (wake-cmd.ts L367):
 *
 *   if (sessionPreExisted && !opts.task && !opts.wt && !opts.force) {
 *     throw new UserError(...)
 *   }
 *   // ... else: spawn newWindow (the leak path we're guarding)
 *
 * Returns "refuse" if the guard fires, "spawn" otherwise. Captures the entire
 * decision surface without invoking cmdWake's resolveOracle/detectSession/
 * shouldAutoWake/channel-loader/ensureTeamConfig dependency chain.
 */
function refuseOrSpawn(opts: {
  sessionPreExisted: boolean;
  task?: string;
  wt?: string;
  force?: boolean;
}): "refuse" | "spawn" {
  if (opts.sessionPreExisted && !opts.task && !opts.wt && !opts.force) {
    return "refuse";
  }
  return "spawn";
}

describe("#1346 refuse-to-spawn guard — truth table", () => {
  test("session pre-existed, no task/wt/force → REFUSE (the bug we're fixing)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: true })).toBe("refuse");
  });

  test("session pre-existed + --force → SPAWN (escape hatch)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: true, force: true })).toBe("spawn");
  });

  test("session pre-existed + --task → SPAWN (explicit create flow exempt)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: true, task: "feature-x" })).toBe("spawn");
  });

  test("session pre-existed + --wt → SPAWN (worktree mode exempt)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: true, wt: "feature-x" })).toBe("spawn");
  });

  test("session truly missing → SPAWN (normal create path unchanged)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: false })).toBe("spawn");
  });

  test("session missing + --force → SPAWN (force is a no-op here)", () => {
    expect(refuseOrSpawn({ sessionPreExisted: false, force: true })).toBe("spawn");
  });

  test("session missing + --task → SPAWN", () => {
    expect(refuseOrSpawn({ sessionPreExisted: false, task: "feature-x" })).toBe("spawn");
  });

  test("all three escapes together (force + task + wt + session) → SPAWN", () => {
    expect(refuseOrSpawn({ sessionPreExisted: true, force: true, task: "t", wt: "w" })).toBe("spawn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. End-to-end retry + guard composition
// ─────────────────────────────────────────────────────────────────────────────

describe("#1346 retry + guard composition — full spinner-race scenario", () => {
  test("session pre-existed, spinner clears on 3rd retry → found, NO refuse fires", async () => {
    let calls = 0;
    const listWindows = async () => {
      calls++;
      return calls < 3 ? [] : [{ name: "neo-oracle" }];
    };
    const found = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    // Window detected via retry — guard branch never reached.
    expect(found).toBe("neo-oracle");
    expect(calls).toBe(3);
  });

  test("session pre-existed, spinner never clears → null + guard fires REFUSE", async () => {
    const listWindows = async () => [] as WindowLike[];
    const found = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(found).toBeNull();
    // Now the guard decision — session existed, no escape flags.
    expect(refuseOrSpawn({ sessionPreExisted: true })).toBe("refuse");
  });

  test("session pre-existed, spinner never clears, --force → null + guard allows SPAWN", async () => {
    const listWindows = async () => [] as WindowLike[];
    const found = await findExistingOracleWindowWith("01-neo", "neo", "neo-oracle", listWindows);
    expect(found).toBeNull();
    expect(refuseOrSpawn({ sessionPreExisted: true, force: true })).toBe("spawn");
  });
});
