/**
 * Client side of the `[request:<id>]` tracking convention: when `maw hey`/`send`
 * dispatches a `[request:<id>]` message, the CLI registers that id into the
 * server's request-reply store via POST /api/request/track, so `maw reply <id>`
 * and `reply --list` (which read the same server store) can find it.
 *
 * Best-effort: if the local server is down the call just fails quietly — the
 * message still delivers; only the reply-tracking convenience is lost.
 */

function mawUrl(): string {
  return `http://localhost:${process.env.MAW_PORT || "3456"}`;
}

export async function trackRequest(
  correlationId: string,
  from: string,
  to: string,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${mawUrl()}/api/request/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correlationId, from, to, message }),
    });
    return res.ok;
  } catch {
    return false; // server unreachable — message still delivered, tracking skipped
  }
}
