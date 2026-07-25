/**
 * kobo-405 — the ONE place that spawns a real `maw hey` subprocess for task-event
 * delivery. Both notify.ts's spawnHey and task/index.ts's ping() used to inline
 * their own `Bun.spawn(["maw","hey",...])` call, each guarded only by
 * `process.env.MAW_TEST_MODE === "1"` — a human has to remember to set that var
 * (or run via a package script that sets it) or a test with a real oracle in its
 * fixture fires a genuine `hey` into a live tmux pane. Isolating the raw spawn to
 * this one exported function lets the test preload (bunfig.toml → test.preload)
 * replace it fleet-wide with a fail-closed stub for EVERY `bun test` invocation,
 * including a bare `bun test <file>` that bypasses every package script — no env
 * var, no per-test opt-in required. Production code should always call this
 * function for hey delivery, never `Bun.spawn` directly.
 */
export function spawnHeyProcess(args: string[]): void {
  Bun.spawn(["maw", "hey", ...args], { stdout: "ignore", stderr: "ignore" });
}
