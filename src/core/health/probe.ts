/**
 * kobo-458 — a health probe that answers "did the server actually respond?"
 * instead of "does pm2 think it's online?" (pm2 reported `online`, uptime
 * ~61min, while the port returned nothing for 2 consecutive checks 40s apart —
 * a zombie, alive to the supervisor, dead to every real caller. That repro
 * used `curl --max-time 8` and got nothing back within the full budget — a
 * TIMEOUT shape, not an instant connection-refused. See the `dead.cause`
 * doc below: this is why timeout counts as dead here.)
 *
 * Reuses /api/probe (src/vendor/mpr-plugins/health/impl.ts's `cmdHealth`
 * already established this as the meaningful endpoint, not the bare root — it
 * walks the same code path as /api/send, so it can't report healthy while
 * delivery is actually broken, kobo-804/#1979's hard-won lesson).
 *
 * Four states, not two — collapsing any pair of these back into one is the
 * exact defect class this card exists to fix:
 *   ok           — responded within the fast window
 *   slow         — responded, but past the slow-threshold (still a REAL
 *                  answer — must never be treated as unhealthy; this is the
 *                  kobo-453 case, a hung/slow call is not the same thing as a
 *                  refused one)
 *   dead         — a genuine network-level answer that isn't usable. Carries
 *                  `cause` (%5 review at ccac44d): "refused" (TCP-level
 *                  rejection — the process is gone) and "timeout" (we waited
 *                  the full budget and got nothing — the process MIGHT be
 *                  gone, or might be alive-but-overloaded, kobo-408's
 *                  territory) are different claims about the world and must
 *                  not be silently indistinguishable in a log. Both still
 *                  count toward restart here — see the note on `dead.cause`
 *                  below for why that's a deliberate call, not a collapse.
 *   probe-error  — the check couldn't even be ATTEMPTED (malformed URL, a
 *                  broken fetchImpl), OR threw something that isn't a
 *                  recognized network failure — this is the WATCHER failing,
 *                  not a statement about the server at all, and must never be
 *                  read as either "healthy" or "dead" (F1, %11/front review:
 *                  a bare catch-everything here would let the watcher's OWN
 *                  bugs restart a server we never actually reached)
 */

export type ProbeResult =
  | { status: "ok"; elapsedMs: number }
  | { status: "slow"; elapsedMs: number }
  | { status: "dead"; elapsedMs: number; cause: "refused" | "timeout" | "http-error" }
  | { status: "probe-error"; reason: string };

export interface ProbeOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  slowThresholdMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000; // matches the card's own repro (`curl --max-time 8`)
const DEFAULT_SLOW_THRESHOLD_MS = 2000;

/**
 * kobo-458 F1 (%11/front review at ccac44d): the original bare `catch` folded
 * EVERY runtime throw into `dead` — a real connection-refused alongside a
 * broken `fetchImpl`, a DNS failure, a caller wiring bug, anything. Since
 * `dead` is the only state that drives a restart, that meant a failure of the
 * WATCHER itself could restart a server we never actually managed to ask —
 * "don't know" collapsing into an action, not a silence, which is worse than
 * this card's usual shape.
 *
 * Verified directly on this Bun runtime (1.3.14), not assumed:
 *   connection-refused → Error, e.code === "ConnectionRefused"
 *   DNS failure        → same shape, e.code === "ConnectionRefused"
 *   AbortSignal.timeout firing → DOMException, e.name === "TimeoutError"
 * Anything else thrown (a bug in a caller-supplied fetchImpl, an unexpected
 * exception) matches neither shape and is NOT a network-level answer about
 * the server — it's the watcher failing, so it must not count as `dead`.
 *
 * Returns the specific cause for a recognized network failure, or `null` if
 * the throw isn't one at all (caller falls through to probe-error).
 */
function networkFailureCause(e: unknown): "refused" | "timeout" | null {
  if (e instanceof DOMException && e.name === "TimeoutError") return "timeout";
  if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "ConnectionRefused") return "refused";
  return null;
}

export async function probeServer(url: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;

  // Validate BEFORE attempting anything network-related. A malformed URL or a
  // non-function fetchImpl means the WATCHER is misconfigured, not that the
  // server is unreachable — this must never fall through to "dead", or a
  // broken watcher would restart a server it never actually asked.
  try {
    new URL(url);
  } catch (e) {
    return { status: "probe-error", reason: `invalid probe URL: ${(e as Error).message}` };
  }
  if (typeof fetchImpl !== "function") {
    return { status: "probe-error", reason: "fetchImpl is not a function" };
  }

  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - start;
    // kobo-458, %5 review: health/impl.ts's cmdHealth treats a non-2xx as
    // "warn", not a hard failure — this function treats it as "dead"
    // (restart-worthy) instead. Deliberately different, not an oversight: a
    // non-2xx from THIS specific probe endpoint means the delivery code path
    // itself errored (it walks the same route /api/send uses), which is a
    // stronger signal than a generic health-check returning non-2xx.
    if (!res.ok) return { status: "dead", elapsedMs, cause: "http-error" };
    return elapsedMs > slowThresholdMs ? { status: "slow", elapsedMs } : { status: "ok", elapsedMs };
  } catch (e) {
    const elapsedMs = Date.now() - start;
    const cause = networkFailureCause(e);
    if (cause) {
      // kobo-458, %5 review: "refused" (the process is gone) and "timeout"
      // (we waited the full budget and got nothing) are different claims,
      // carried in `cause` so a log/caller isn't blind to which happened.
      // Both still count toward `dead` here, deliberately: this card's own
      // motivating incident (see file header) was timeout-shaped, not
      // refused-shaped, and shouldRestart() only acts on N CONSECUTIVE dead
      // results — a single slow-under-load blip (kobo-408's territory) stays
      // `slow` and never reaches here; only SUSTAINED total unresponsiveness
      // across the whole polling window reaches `dead` N times in a row,
      // which is worth restarting regardless of whether the underlying cause
      // is "gone" or "so overloaded it might as well be."
      return { status: "dead", elapsedMs, cause };
    }
    // an unrecognized throw is the CHECK failing, not the server — never
    // let it drive a restart.
    return { status: "probe-error", reason: `probe threw an unrecognized error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
