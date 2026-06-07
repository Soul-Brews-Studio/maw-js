/**
 * Auto-restore: if no live tmux sessions exist and a recent (<24h) snapshot
 * is on disk, prompt the user to revive every session in the snapshot.
 *
 * Skipped for help-style invocations (--help / -h), non-interactive shells,
 * and diagnostic commands so automation output stays machine-readable.
 *
 * Exceptions are intentionally swallowed — auto-restore is best-effort
 * UX sugar, never load-bearing for the actual command the user typed.
 */
export async function maybeAutoRestore(cmd: string | undefined): Promise<void> {
  if (!cmd || cmd === "--help" || cmd === "-h") return;
  if (shouldSkipAutoRestore(cmd)) return;
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
    const fs = await import("fs");
    const buf = new Uint8Array(64);
    const fd = fs.openSync("/dev/tty", "r");
    const n = fs.readSync(fd, buf);
    fs.closeSync(fd);
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

function shouldSkipAutoRestore(cmd: string): boolean {
  if (isTruthyEnv(process.env.MAW_NO_PROMPT) || isTruthyEnv(process.env.CI)) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  return new Set(["capture", "locate", "messages", "oracle", "peek"]).has(cmd);
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
