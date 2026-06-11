import { parseFlags, type InvokeContext, type InvokeResult } from "maw-js/sdk";

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_READ_ONLY = true;

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    if (ctx.source !== "cli") {
      return { ok: false, error: "maw share currently supports CLI usage only" };
    }

    const flags = parseFlags(ctx.args as string[], {
      "--read-only": Boolean,
      "--ttl": Number,
      "--port": Number,
    }, 0);

    const target = flags._[0] ?? "";
    const readOnly = flags["--read-only"] ?? DEFAULT_READ_ONLY;
    const ttl = typeof flags["--ttl"] === "number" && Number.isFinite(flags["--ttl"]) ? flags["--ttl"] : DEFAULT_TTL_SECONDS;
    const port = typeof flags["--port"] === "number" && Number.isFinite(flags["--port"]) ? flags["--port"] : undefined;

    if (!target) {
      return { ok: false, error: "usage: maw share <session-or-pane> [--read-only] [--ttl <seconds>] [--port <number>]" };
    }

    console.log(`share ${target} readOnly=${readOnly} ttl=${ttl}s port=${port === undefined ? "auto" : port}`);

    // TODO(#2685): call share impl (target resolve + auth + stream + registry).

    return { ok: true, output: `share ${target}` };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}


export async function serve(_ctx: { http?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
  return { ok: true };
}
