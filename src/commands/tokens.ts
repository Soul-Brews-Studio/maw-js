import { buildIndex, loadIndex, summarize } from "../token-index";

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function cmdTokens(opts: { rebuild?: boolean; json?: boolean; top?: number }) {
  if (opts.rebuild) {
    console.log("\n  \x1b[36mRebuilding token index...\x1b[0m");
    buildIndex(true);
  }

  const index = loadIndex();
  if (index.sessions.length === 0) {
    console.log("\n  \x1b[90mNo index found. Run: maw tokens --rebuild\x1b[0m\n");
    return;
  }

  const stats = summarize(index);

  if (opts.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const top = opts.top || 15;

  console.log(`
  \x1b[36m┌─ Token Usage\x1b[0m \x1b[90m(${stats.sessionCount} sessions, indexed ${index.updatedAt.slice(0, 16)})\x1b[0m
  \x1b[36m│\x1b[0m
  \x1b[36m│\x1b[0m  Input:        \x1b[33m${formatNum(stats.totalInput)}\x1b[0m tokens
  \x1b[36m│\x1b[0m  Output:       \x1b[32m${formatNum(stats.totalOutput)}\x1b[0m tokens
  \x1b[36m│\x1b[0m  Cache read:   \x1b[90m${formatNum(stats.totalCacheRead)}\x1b[0m
  \x1b[36m│\x1b[0m  Cache create: \x1b[90m${formatNum(stats.totalCacheCreate)}\x1b[0m
  \x1b[36m│\x1b[0m  Turns:        ${stats.totalTurns.toLocaleString()}
  \x1b[36m│\x1b[0m`);

  console.log(`  \x1b[36m│\x1b[0m  \x1b[33mBy Project\x1b[0m (top ${top})`);
  console.log(`  \x1b[36m│\x1b[0m  ${"Project".padEnd(28)} ${"Input".padStart(10)} ${"Output".padStart(10)} ${"Turns".padStart(7)}`);
  console.log(`  \x1b[36m│\x1b[0m  ${"─".repeat(28)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(7)}`);
  for (const p of stats.byProject.slice(0, top)) {
    console.log(`  \x1b[36m│\x1b[0m  ${p.project.padEnd(28)} ${formatNum(p.input).padStart(10)} ${formatNum(p.output).padStart(10)} ${p.turns.toString().padStart(7)}`);
  }

  console.log(`  \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m│\x1b[0m  \x1b[33mBy Date\x1b[0m (recent)`);
  console.log(`  \x1b[36m│\x1b[0m  ${"Date".padEnd(12)} ${"Input".padStart(10)} ${"Output".padStart(10)} ${"Turns".padStart(7)}`);
  console.log(`  \x1b[36m│\x1b[0m  ${"─".repeat(12)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(7)}`);
  for (const d of stats.byDate.slice(0, 7)) {
    console.log(`  \x1b[36m│\x1b[0m  ${d.date.padEnd(12)} ${formatNum(d.input).padStart(10)} ${formatNum(d.output).padStart(10)} ${d.turns.toString().padStart(7)}`);
  }

  console.log(`  \x1b[36m│\x1b[0m`);
  console.log(`  \x1b[36m└─\x1b[0m`);
  console.log();
}
