import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { scanSignals } from "../../shared/scan-signals";
import type { ScannedSignal } from "../../shared/scan-signals";

export const command = {
  name: "signals",
  description: "List bud signals written to ψ/memory/signals/",
};

const KIND_COLOR: Record<string, string> = {
  alert: "\x1b[31m",
  pattern: "\x1b[33m",
  info: "\x1b[36m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[90m";

function formatSignal(s: ScannedSignal): string {
  const color = KIND_COLOR[s.kind] ?? "\x1b[37m";
  const date = s.timestamp.slice(0, 10);
  return `  ${color}[${s.kind}]${RESET} ${DIM}${date}${RESET} ${s.bud}: ${s.message}`;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const body = ctx.source === "api" ? (ctx.args as Record<string, unknown>) : {};

    const flags = parseFlags(args, {
      "--days": Number,
      "--root": String,
      "--json": Boolean,
    }, 0);

    const root = (flags["--root"] ?? body.root ?? process.cwd()) as string;
    const days = (flags["--days"] ?? body.days ?? 7) as number;
    const asJson = (flags["--json"] ?? body.json ?? false) as boolean;

    const signals = scanSignals(root, { days });

    if (asJson) {
      console.log(JSON.stringify(signals, null, 2));
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (signals.length === 0) {
      console.log(`  ${DIM}no signals in the last ${days} days${RESET}`);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    console.log(`\n  \x1b[36mBud signals\x1b[0m (last ${days}d — ${signals.length} total)\n`);
    for (const s of signals) {
      console.log(formatSignal(s));
    }
    console.log();

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
