/**
 * `maw self-update` — sync local maw-js checkout (#1271).
 *
 * Thin CLI wrapper around impl.ts. Parses flags, dispatches, and
 * returns the impl's result + exit code.
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { runSelfUpdate } from "./impl";

export const command = {
  name: "self-update",
  description: "Sync local maw-js checkout with origin (#1271).",
};

const USAGE = [
  "usage: maw self-update [options]",
  "",
  "  Pull origin into the local maw-js checkout, refresh bun link.",
  "  Different from `maw update` — operates on the local DEV clone,",
  "  not a global `bun add -g` install.",
  "",
  "  Options:",
  "    --dry-run         show what WOULD update; don't apply",
  "    --check           exit 0 if synced, 1 if behind",
  "    --branch=<NAME>   branch to track (default: alpha)",
  "    --force           auto-stash dirty changes + restore around pull",
  "    -h, --help        show this message",
  "",
  "  Examples:",
  "    maw self-update",
  "    maw self-update --check",
  "    maw self-update --branch=main",
  "    maw self-update --dry-run",
  "    maw self-update --force          # stash + restore",
].join("\n");

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

  if (args.includes("--help") || args.includes("-h")) {
    return { ok: true, output: USAGE };
  }

  const spec = {
    "--dry-run": Boolean,
    "--check":   Boolean,
    "--branch":  String,
    "--force":   Boolean,
  };
  let flags: ReturnType<typeof parseFlags<typeof spec>>;
  try {
    flags = parseFlags(args, spec);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `${msg}\n\n${USAGE}` };
  }

  const branch = flags["--branch"];

  try {
    const result = await runSelfUpdate({
      dryRun: !!flags["--dry-run"],
      check:  !!flags["--check"],
      branch: branch && branch.length > 0 ? branch : undefined,
      force:  !!flags["--force"],
    });

    if (result.ok) {
      return { ok: true, output: result.output };
    }
    return {
      ok: false,
      error: result.output,
      exitCode: result.exitCode,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
