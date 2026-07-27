/**
 * kobo-481 — the visibility half of a `maw hey` spawn (core/tasks/hey-spawn.ts
 * itself stays covered by the kobo-405 fail-closed test stub, which only
 * exports `spawnHeyProcess`; this sibling file is NOT stubbed, so it can be
 * imported and exercised directly in tests with real code, no module-mock
 * needed to reach it).
 *
 * Fire-and-forget callers of spawnHeyProcess (notify.ts, ping.ts,
 * task/index.ts) never passed `opts.stderr`, so it silently defaulted to
 * "ignore" — a spawn failure (identity refused, `maw` binary missing,
 * anything) vanished with zero trace. This makes a failure visible without
 * adding noise on success: only called when the subprocess exits non-zero.
 */
export function logHeySpawnFailure(args: string[], exitCode: number | null, stderrText: string): void {
  const detail = stderrText.trim() || "(no stderr captured)";
  console.error(`[hey-spawn] maw hey ${args.join(" ")} failed (exit ${exitCode}): ${detail}`);
}

/** Subset of Bun.Subprocess this needs — kept minimal so a test can pass a
 *  plain fake object instead of a real spawned process. */
export interface HeySpawnWatchTarget {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | number | undefined;
}

/**
 * Awaits the subprocess's exit and logs iff it failed. Never throws (a
 * failure-visibility path that itself fails uncaught would defeat the
 * purpose) — the caller fire-and-forgets this, same as the spawn itself.
 */
export async function watchHeySpawnForFailure(proc: HeySpawnWatchTarget, args: string[]): Promise<void> {
  let code: number;
  try {
    code = await proc.exited;
  } catch {
    return; // can't even learn the exit code — nothing more to report
  }
  if (code === 0) return; // success — no added noise, per AC
  let stderrText = "";
  if (proc.stderr instanceof ReadableStream) {
    try {
      stderrText = await new Response(proc.stderr).text();
    } catch {
      /* best-effort — still report the failure without stderr detail */
    }
  }
  try {
    logHeySpawnFailure(args, code, stderrText);
  } catch {
    /* logging itself must never throw into a fire-and-forget caller */
  }
}
