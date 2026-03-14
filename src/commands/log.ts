import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_FILE = join(homedir(), ".oracle", "maw-log.jsonl");

interface LogEntry {
  ts: string;
  from: string;
  to: string;
  target: string;
  msg: string;
  host: string;
  sid?: string;
}

function readLog(): LogEntry[] {
  try {
    const raw = readFileSync(LOG_FILE, "utf-8");
    return raw.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as LogEntry[];
  } catch {
    return [];
  }
}

export function cmdLogLs(opts: { limit?: number; from?: string; to?: string }) {
  let entries = readLog();

  if (opts.from) entries = entries.filter(e => e.from.toLowerCase().includes(opts.from!.toLowerCase()));
  if (opts.to) entries = entries.filter(e => e.to.toLowerCase().includes(opts.to!.toLowerCase()));

  // Most recent last, show tail
  const limit = opts.limit || 20;
  const shown = entries.slice(-limit);

  if (shown.length === 0) {
    console.log("\n  \x1b[90mNo messages found.\x1b[0m\n");
    return;
  }

  console.log(`\n  \x1b[36mmaw log\x1b[0m (${entries.length} total, showing last ${shown.length})\n`);
  console.log(`  ${"Time".padEnd(8)} ${"From".padEnd(16)} ${"To".padEnd(16)} Message`);
  console.log(`  ${"─".repeat(8)} ${"─".repeat(16)} ${"─".repeat(16)} ${"─".repeat(40)}`);

  for (const e of shown) {
    const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const from = e.from.slice(0, 15).padEnd(16);
    const to = e.to.slice(0, 15).padEnd(16);
    const msg = e.msg.slice(0, 60).replace(/\n/g, " ");
    console.log(`  ${time.padEnd(8)} \x1b[32m${from}\x1b[0m \x1b[33m${to}\x1b[0m ${msg}`);
  }
  console.log();
}

export function cmdLogExport(opts: { date?: string; from?: string; to?: string; format?: string }) {
  let entries = readLog();

  if (opts.date) {
    entries = entries.filter(e => e.ts.startsWith(opts.date!));
  }
  if (opts.from) entries = entries.filter(e => e.from.toLowerCase().includes(opts.from!.toLowerCase()));
  if (opts.to) entries = entries.filter(e => e.to.toLowerCase().includes(opts.to!.toLowerCase()));

  if (opts.format === "json") {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  // Default: markdown
  const dateLabel = opts.date || "all";
  console.log(`# Oracle Conversations — ${dateLabel}`);
  console.log();
  console.log(`> ${entries.length} messages`);
  console.log();

  for (const e of entries) {
    const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const from = e.from.replace(/-oracle$/, "").replace(/-/g, " ");
    console.log(`**${time}** — **${from}** → ${e.to}`);
    console.log();
    console.log(e.msg);
    console.log();
    console.log("---");
    console.log();
  }
}
