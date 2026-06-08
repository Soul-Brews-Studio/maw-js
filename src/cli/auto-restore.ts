/**
 * Auto-restore hint: if no live tmux sessions exist and a recent (<24h)
 * snapshot is on disk, print a non-blocking hint showing what can be restored.
 *
 * Previously this did a blocking /dev/tty read which could hang the CLI
 * in wrapper scripts, multiplexers, or shell-init contexts. Now it just
 * prints and returns — the user runs `maw wake <name>` themselves.
 *
 * Skipped for help-style invocations (--help / -h), non-interactive shells,
 * and diagnostic commands so automation output stays machine-readable.
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
    console.log(`\x1b[36m📸\x1b[0m Last snapshot: ${snap.sessions.length} session${snap.sessions.length === 1 ? "" : "s"} (${ageStr})`);
    for (const s of snap.sessions) console.log(`   ${s.name}`);
    console.log(`\x1b[36m↻\x1b[0m  restore: \x1b[1mmaw wake <name>\x1b[0m   or   \x1b[1mmaw wake --all\x1b[0m`);
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
