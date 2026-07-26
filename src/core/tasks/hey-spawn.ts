/**
 * kobo-405 — the ONE place in the whole codebase that spawns a real `maw hey`
 * subprocess. Originally just notify.ts's spawnHey + task/index.ts's ping();
 * widened (same card, AC is suite-wide) to also cover the 4 other independent
 * `Bun.spawn(["maw","hey",...])` call sites found by class-closure sweep:
 * core/worklog/ping.ts, commands/plugins/scheduler/hooks.ts,
 * vendor/mpr-plugins/doctor/impl.ts, vendor/mpr-plugins/company/company-knowledge.ts.
 * Every one of those was guarded only by `process.env.MAW_TEST_MODE === "1"`
 * (or, for 3 of the 4, no guard at all) — a human has to remember to set that
 * var (or run via a package script that sets it), or a test with a real oracle
 * in its fixture fires a genuine `hey` into a live tmux pane. Isolating the raw
 * spawn to this one exported function lets the test preload (bunfig.toml →
 * test.preload) replace it fleet-wide with a fail-closed stub for EVERY
 * `bun test` invocation, including a bare `bun test <file>` that bypasses
 * every package script — no env var, no per-test opt-in required. Production
 * code should always call this function for hey delivery, never `Bun.spawn`
 * directly. Returns the live `Bun.Subprocess` (not void) so callers that need
 * to await exit code / read stderr (doctor's forward, company-knowledge's
 * defaultSend) still can — the 2 original fire-and-forget callers just ignore
 * the return value, unaffected.
 */
export function spawnHeyProcess(
  args: string[],
  opts: {
    stdout?: "ignore" | "inherit" | "pipe";
    stderr?: "ignore" | "inherit" | "pipe";
    stdin?: "ignore" | "inherit" | "pipe";
    env?: NodeJS.ProcessEnv;
  } = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["maw", "hey", ...args], {
    stdout: opts.stdout ?? "ignore",
    stderr: opts.stderr ?? "ignore",
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
}
