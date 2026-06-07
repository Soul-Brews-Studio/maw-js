/**
 * maw avengers — rate limit monitor integration with ARRA-01/avengers.
 */

import { loadConfig } from "maw-js/config";

function getAvengersUrl(): string | null {
  return (loadConfig() as any).avengers || null;
}

export async function cmdAvengers(sub: string) {
  const base = getAvengersUrl();

  if (!base) {
    throw new Error(`Avengers not configured. Add to maw.config.json:\n  "avengers": "http://white.local:8090"`);
  }

  if (sub === "status" || sub === "all") {
    await showStatus(base);
  } else if (sub === "best") {
    await showBest(base);
  } else if (sub === "traffic") {
    await showTraffic(base);
  } else if (sub === "health") {
    await showHealth(base);
  } else {
    console.log(`\x1b[36mmaw avengers\x1b[0m — ARRA-01 rate limit monitor\n`);
    console.log(`  maw avengers status    All accounts + rate limits`);
    console.log(`  maw avengers best      Account with most capacity`);
    console.log(`  maw avengers traffic   Traffic stats`);
    console.log(`  maw avengers health    Quick connectivity check\n`);
  }
}

async function showStatus(base: string) {
  try {
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(5000) });
    const accounts = await res.json();

    console.log(`\n\x1b[36;1mAvengers Status\x1b[0m  \x1b[90m${base}\x1b[0m\n`);

    if (Array.isArray(accounts)) {
      for (const acc of accounts) {
        const name = acc.name || acc.email || acc.id || "?";
        const remaining = acc.remaining ?? acc.requests_remaining ?? "?";
        const limit = acc.limit ?? acc.requests_limit ?? "?";
        const pct = typeof remaining === "number" && typeof limit === "number" && limit > 0
          ? Math.round((remaining / limit) * 100) : null;
        const color = pct !== null ? (pct > 50 ? "\x1b[32m" : pct > 20 ? "\x1b[33m" : "\x1b[31m") : "\x1b[37m";
        const bar = pct !== null ? `${color}${remaining}/${limit} (${pct}%)\x1b[0m` : `${remaining}`;
        console.log(`  ${color}●\x1b[0m  ${String(name).padEnd(30)}  ${bar}`);
      }
    } else {
      console.log(JSON.stringify(accounts, null, 2));
    }
    console.log();
  } catch (err: any) {
    console.error(`\x1b[31merror\x1b[0m: avengers unreachable at ${base}: ${err.message}`);
  }
}

async function showBest(base: string) {
  try {
    const res = await fetch(`${base}/best`, { signal: AbortSignal.timeout(5000) });
    const best = await res.json();
    console.log(`\n\x1b[36;1mBest Account\x1b[0m\n`);
    console.log(`  ${JSON.stringify(best, null, 2)}`);
    console.log();
  } catch (err: any) {
    console.error(`\x1b[31merror\x1b[0m: ${err.message}`);
  }
}

async function showTraffic(base: string) {
  try {
    const res = await fetch(`${base}/traffic-stats`, { signal: AbortSignal.timeout(5000) });
    const traffic = await res.json();
    console.log(`\n\x1b[36;1mTraffic Stats\x1b[0m\n`);
    console.log(JSON.stringify(traffic, null, 2));
    console.log();
  } catch (err: any) {
    console.error(`\x1b[31merror\x1b[0m: ${err.message}`);
  }
}

async function showHealth(base: string) {
  const start = Date.now();
  try {
    const res = await fetch(`${base}/all`, { signal: AbortSignal.timeout(3000) });
    const latency = Date.now() - start;
    const accounts = await res.json();
    const count = Array.isArray(accounts) ? accounts.length : 0;

    console.log(`\n\x1b[32m●\x1b[0m  Avengers \x1b[32monline\x1b[0m  \x1b[90m${latency}ms · ${count} account${count !== 1 ? "s" : ""}\x1b[0m`);
    console.log(`   \x1b[90m${base}\x1b[0m\n`);
  } catch {
    const latency = Date.now() - start;
    console.log(`\n\x1b[31m●\x1b[0m  Avengers \x1b[31moffline\x1b[0m  \x1b[90m${latency}ms\x1b[0m`);
    console.log(`   \x1b[90m${base}\x1b[0m\n`);
  }
}
