import { readLog, type LogEntry } from "../maw-log";

function displayName(name: string): string {
  return name.replace(/-oracle$/, "").replace(/-mawjs$/, "");
}

export function cmdLogLs(opts: { limit?: number; from?: string; to?: string }) {
  let entries = readLog();

  if (opts.from) entries = entries.filter(e => e.from.toLowerCase().includes(opts.from!.toLowerCase()));
  if (opts.to) entries = entries.filter(e => e.to.toLowerCase().includes(opts.to!.toLowerCase()));

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
    const msg = (e.msg || "").slice(0, 60).replace(/\n/g, " ");
    console.log(`  ${time.padEnd(8)} \x1b[32m${from}\x1b[0m \x1b[33m${to}\x1b[0m ${msg}`);
  }
  console.log();
}

export function cmdLogExport(opts: { date?: string; from?: string; to?: string; format?: string }) {
  let entries = readLog();

  if (opts.date) entries = entries.filter(e => e.ts.startsWith(opts.date!));
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
    const from = displayName(e.from);
    console.log(`**${time}** — **${from}** → ${e.to}`);
    console.log();
    console.log(e.msg);
    console.log();
    console.log("---");
    console.log();
  }
}

// ─── Agent color for terminal (ANSI 256-color) ───

const AGENT_ANSI: Record<string, string> = {
  "neo-oracle": "\x1b[38;5;75m",     // blue
  "pulse-oracle": "\x1b[38;5;203m",  // red
  "hermes-oracle": "\x1b[38;5;79m",  // teal
  "calliope-oracle": "\x1b[38;5;120m", // green
  "nexus-oracle": "\x1b[38;5;141m",  // purple
  "nat": "\x1b[38;5;222m",           // gold
};
const RST = "\x1b[0m";
const DIM = "\x1b[90m";

function agentAnsi(name: string): string {
  return AGENT_ANSI[name] || "\x1b[37m";
}

export function cmdLogChat(opts: { limit?: number; from?: string; to?: string; pair?: string }) {
  let entries = readLog();

  if (opts.from) entries = entries.filter(e => e.from.toLowerCase().includes(opts.from!.toLowerCase()));
  if (opts.to) entries = entries.filter(e => e.to.toLowerCase().includes(opts.to!.toLowerCase()));
  if (opts.pair) {
    const p = opts.pair.toLowerCase();
    entries = entries.filter(e =>
      e.from.toLowerCase().includes(p) || e.to.toLowerCase().includes(p)
    );
  }

  const limit = opts.limit || 30;
  const shown = entries.slice(-limit);

  if (shown.length === 0) {
    console.log("\n  \x1b[90mNo messages found.\x1b[0m\n");
    return;
  }

  console.log();
  console.log(`  \x1b[36m┌─ AI คุยกัน \x1b[90m(${entries.length} total, last ${shown.length})${RST}`);
  console.log(`  \x1b[36m│${RST}`);

  let lastFrom = "";
  for (const e of shown) {
    const time = new Date(e.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const from = displayName(e.from);
    const color = agentAnsi(e.from);
    const toName = displayName(e.to);
    const isNewSender = e.from !== lastFrom;
    const msg = (e.msg || "").replace(/\n/g, "\n  \x1b[36m│\x1b[0m   ");

    if (isNewSender) {
      console.log(`  \x1b[36m│${RST}`);
      console.log(`  \x1b[36m│${RST}  ${color}${from}${RST} ${DIM}→ ${toName}  ${time}${RST}`);
    } else {
      console.log(`  \x1b[36m│${RST}  ${DIM}${time}${RST}`);
    }
    console.log(`  \x1b[36m│${RST}   ${msg}`);
    lastFrom = e.from;
  }

  console.log(`  \x1b[36m│${RST}`);
  console.log(`  \x1b[36m└─${RST}`);
  console.log();
}
