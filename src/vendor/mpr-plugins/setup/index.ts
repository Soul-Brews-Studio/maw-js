import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { setupAutoWake } from "./auto-wake";

export const command = {
  name: "setup",
  description: "Host setup helpers for reboot-safe maw operation",
};

function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): string {
  return [
    "maw setup auto-wake [--dry-run] [--user <name>] [--repo <path>]",
    "",
    "Registers the maw-boot PM2 one-shot so reboot restores the latest fleet snapshot:",
    "  loginctl enable-linger <user>",
    "  pm2 startup systemd -u <user> --hp <home>",
    "  pm2 start ecosystem.config.cjs --only maw-boot",
    "  pm2 save",
  ].join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const sub = args[0];

  if (!sub || has(args, "--help") || has(args, "-h")) {
    return { ok: true, output: usage() };
  }

  if (sub !== "auto-wake") {
    return { ok: false, error: `unknown setup subcommand: ${sub}\n${usage()}` };
  }

  try {
    const result = await setupAutoWake({
      dryRun: has(args, "--dry-run"),
      user: valueAfter(args, "--user"),
      repoRoot: valueAfter(args, "--repo"),
    });

    const lines = [
      "maw setup auto-wake",
      ...result.steps.map((step) => {
        const prefix = step.skipped ? "  · dry-run" : "  ✓";
        return `${prefix} ${step.command.join(" ")}`;
      }),
      "  ✓ next reboot will restore fleet from the latest snapshot",
    ];
    return { ok: true, output: lines.join("\n") };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

