/**
 * Auto-restore: if no live tmux sessions exist and a recent (<24h) snapshot
 * is on disk, prompt the user to revive every session in the snapshot.
 *
 * Skipped for help-style invocations (--help / -h) so `maw --help` never
 * stalls waiting for tty input.
 *
 * Exceptions are intentionally swallowed — auto-restore is best-effort
 * UX sugar, never load-bearing for the actual command the user typed.
 */
export async function maybeAutoRestore(cmd: string | undefined): Promise<void> {
  if (!cmd || cmd === "--help" || cmd === "-h") return;
  try {
    const { listSessions } = await import("../sdk");
    const live = await listSessions().catch(() => [] as any[]);
    if (live.length !== 0) return;

    const { latestSnapshot } = await import("../core/fleet/snapshot");
    const snap = latestSnapshot();
    if (!snap) return;

    const ageMs = Date.now() - new Date(snap.timestamp).getTime();
    if (ageMs >= 24 * 60 * 60 * 1000) return;

    const mins = Math.round(ageMs / 60000);
    const ageStr = mins >= 60 ? `${Math.round(mins / 60)}h ago` : `${mins}m ago`;
    console.log(`\x1b[36m📸\x1b[0m Last snapshot: ${snap.sessions.length} sessions (${ageStr})`);
    for (const s of snap.sessions) console.log(`   ${s.name}`);
    process.stdout.write(`\nRestore all? [y/N] `);
    const buf = new Uint8Array(64);
    const fd = require("fs").openSync("/dev/tty", "r");
    const n = require("fs").readSync(fd, buf);
    require("fs").closeSync(fd);
    const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return;

    const { cmdWake } = await import("../commands/shared/wake-cmd");
    for (const s of snap.sessions) {
      const oracle = s.name.replace(/^\d+-/, "");
      try {
        await cmdWake(oracle, { attach: false });
        console.log(`  \x1b[32m✓\x1b[0m ${s.name}`);
      } catch (e: any) {
        console.log(`  \x1b[31m✗\x1b[0m ${s.name}: ${e?.message || String(e)}`);
      }
    }
    console.log("");
  } catch {}
}
