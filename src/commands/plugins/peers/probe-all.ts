/**
 * maw peers probe-all — parallel federation ping (#669).
 *
 * Loops over every alias in peers.json, runs probePeer() concurrently
 * via Promise.all, and returns a per-peer row with timing + result.
 * Keeps store mutation minimal: on success bumps lastSeen and clears
 * lastError; on failure records lastError. Mirrors cmdProbe()'s write
 * semantics so the store stays consistent whether you probe one or all.
 *
 * Exit semantics live in the dispatcher: 0 if every peer is ok, else
 * the exit code of the worst failure family (PROBE_EXIT_CODES) unless
 * the caller passed --allow-unreachable.
 */
import { loadPeers, mutatePeers, type LastError, type Peer } from "./store";
import { probePeer, PROBE_EXIT_CODES, type ProbeErrorCode } from "./probe";

export interface ProbeAllRow {
  alias: string;
  url: string;
  node: string | null;
  lastSeen: string | null;
  ok: boolean;
  /** Elapsed wall-clock ms for this peer's probe. */
  ms: number;
  error?: LastError;
}

export interface ProbeAllResult {
  rows: ProbeAllRow[];
  okCount: number;
  failCount: number;
  /** The numerically-highest PROBE_EXIT_CODE seen across failures; 0 if all ok. */
  worstExitCode: number;
}

export async function cmdProbeAll(timeoutMs = 2000): Promise<ProbeAllResult> {
  const data = loadPeers();
  const entries = Object.entries(data.peers).sort(([a], [b]) => a.localeCompare(b));

  const settled = await Promise.all(
    entries.map(async ([alias, peer]): Promise<ProbeAllRow> => {
      const started = Date.now();
      const probe = await probePeer(peer.url, timeoutMs);
      const ms = Date.now() - started;
      return {
        alias,
        url: peer.url,
        node: probe.node ?? peer.node,
        lastSeen: peer.lastSeen,
        ok: !probe.error,
        ms,
        error: probe.error,
      };
    }),
  );

  // Batch-apply all mutations under a single lock — avoids one lock
  // acquisition per peer for large fleets and keeps the store update
  // atomic from the caller's perspective.
  if (settled.length > 0) {
    const now = new Date().toISOString();
    mutatePeers((d) => {
      for (const row of settled) {
        const p = d.peers[row.alias];
        if (!p) continue; // removed between load and mutate
        if (row.ok) {
          delete p.lastError;
          p.lastSeen = now;
          if (row.node) p.node = row.node;
        } else if (row.error) {
          p.lastError = row.error;
        }
      }
    });
    for (const row of settled) {
      if (row.ok) row.lastSeen = now;
    }
  }

  const okCount = settled.filter(r => r.ok).length;
  const failCount = settled.length - okCount;
  const worstExitCode = settled
    .filter(r => !r.ok && r.error)
    .reduce((worst, r) => {
      const code = PROBE_EXIT_CODES[r.error!.code as ProbeErrorCode] ?? 2;
      return code > worst ? code : worst;
    }, 0);

  return { rows: settled, okCount, failCount, worstExitCode };
}

/**
 * Render a fixed-width table:
 *   alias  url  node  lastSeen  result
 * Result cell: "✓ ok (Nms)" on success, "✗ CODE" on failure.
 * Color is applied to the result column only; everything else is plain
 * so the output stays readable in non-TTY logs.
 */
export function formatProbeAll(result: ProbeAllResult): string {
  if (result.rows.length === 0) return "no peers";

  const header = ["alias", "url", "node", "lastSeen", "result"];
  const rows = result.rows.map(r => [
    r.alias,
    r.url,
    r.node ?? "-",
    r.lastSeen ?? "-",
    r.ok ? `\x1b[32m✓\x1b[0m ok (${r.ms}ms)` : `\x1b[31m✗\x1b[0m ${r.error?.code ?? "UNKNOWN"}`,
  ]);

  // Width calc must ignore ANSI escapes in the result column — otherwise
  // the color codes shove other columns right. strip-ansi for width only.
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(row => strip(row[i]).length)));

  const fmt = (cols: string[]) =>
    cols.map((c, i) => c + " ".repeat(Math.max(0, widths[i] - strip(c).length))).join("  ");

  const lines = [
    fmt(header),
    fmt(widths.map(w => "-".repeat(w))),
    ...rows.map(fmt),
    "",
    `${result.okCount}/${result.rows.length} ok${result.failCount > 0 ? `, ${result.failCount} failed` : ""}`,
  ];
  return lines.join("\n");
}
