/**
 * maw token — plugin entry point (#54).
 *
 * Port of laris-co/token-oracle (Python → TypeScript) as a maw plugin.
 * Mirrors token-cli's command routing: list, use, current, save, load,
 * scan. `tokens` is an alias for `list`.
 *
 * Security stance (see also src/lib.ts):
 *   - Token VALUES never appear in any output, log, or error message
 *   - subprocess calls to `pass` use stdin for writes (never argv)
 *   - The fingerprint map (full token text → name) lives inside scan
 *     and is only used for substring membership tests; never iterated
 *     for any printing path.
 *
 * The shape of this file mirrors plugins/peers/index.ts: console
 * output is captured via writer/logs, subcommands switch on the first
 * positional, and unknown subcommands print help and exit non-zero.
 */

import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "token",
  description:
    "Store and restore .envrc files via pass, and manage active Claude OAuth tokens.",
};

function helpText(): string {
  return [
    "usage: maw token <list|use|current|save|load|scan> [...]",
    "  list                                  — list vault tokens + saved .envrcs (active marked)",
    "  use <name> [--no-team]                — switch active Claude token in local .envrc",
    "  current                               — print active token name (for statuslines)",
    "  save [name] [-f|--force]              — save .envrc to pass vault (default name = cwd basename)",
    "  load [name] [-f|--force]              — restore .envrc from pass vault + direnv allow",
    "  scan                                  — scan ghq repos, map tokens to oracles",
    "",
    "aliases:",
    "  tokens                                — same as `list`",
    "  ls                                    — same as `list`",
    "",
    "security: token values are never printed, logged, or stored outside",
    "          memory. See README.md for the full threat model.",
  ].join("\n");
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

  const out = () => logs.join("\n");

  try {
    // CLI invocation contract: `ctx.args` is the raw argv-tail (post
    // the plugin command name). Non-CLI (HTTP/API) invocation may pass
    // an object — token is CLI-only for now, so we treat unknown
    // shapes as empty argv.
    const args: string[] = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const positional = args.filter(a => !a.startsWith("--"));
    const sub = positional[0];

    if (!sub) {
      console.log(helpText());
      return { ok: true, output: out() || helpText() };
    }

    switch (sub) {
      case "list":
      case "ls":
      case "tokens": {
        const { cmdList, formatList } = await import("./list");
        const r = cmdList();
        console.log(formatList(r));
        return { ok: true, output: out() };
      }

      case "current": {
        const { cmdCurrent } = await import("./current");
        const name = cmdCurrent();
        if (name) console.log(name);
        return { ok: true, output: out() };
      }

      case "use": {
        const name = positional[1];
        if (!name) {
          // Match token-cli: `use` with no name shows list + usage.
          const { cmdList, formatList } = await import("./list");
          console.log(formatList(cmdList()));
          console.log("Usage: maw token use <name> [--no-team]");
          return { ok: true, output: out() };
        }
        const noTeam = args.includes("--no-team");
        const { cmdUse } = await import("./use");
        const r = cmdUse({ name, noTeam });
        if (!r.ok) {
          return { ok: false, error: r.error ?? "use failed", output: out() };
        }
        console.log(`Now using: ${r.name}`);
        if (r.direnvOk === false) {
          console.error("warning: direnv allow failed — run `direnv allow .` manually");
        }
        return { ok: true, output: out() };
      }

      case "save": {
        const name = positional[1];
        const force = args.includes("-f") || args.includes("--force");
        // Non-TTY callers (CI, agents) can't answer the confirm; mark
        // them assumeYes-but-only-when-force is also set. Default
        // remains the interactive prompt for safety.
        const { cmdSave } = await import("./save");
        const r = await cmdSave({ name, force });
        if (!r.ok) return { ok: false, error: r.error, output: out() };
        if (r.skipped) {
          console.log(`Skipped (would overwrite ${r.path})`);
        } else {
          console.log(`Saved .envrc as ${r.path}`);
        }
        return { ok: true, output: out() };
      }

      case "load": {
        const name = positional[1];
        const force = args.includes("-f") || args.includes("--force");
        const { cmdLoad } = await import("./load");
        const r = await cmdLoad({ name, force });
        if (!r.ok) return { ok: false, error: r.error, output: out() };
        if (r.skipped) {
          console.log(`Skipped (would overwrite .envrc; ${r.path})`);
        } else {
          console.log(`Loaded ${r.path} into .envrc`);
          if (r.direnvOk === false) {
            console.error("warning: direnv allow failed — run `direnv allow .` manually");
          }
        }
        return { ok: true, output: out() };
      }

      case "scan": {
        const { cmdScan, formatScan } = await import("./scan");
        const r = cmdScan();
        console.log(formatScan(r));
        if (!r.ok) return { ok: false, error: r.error, output: out() };
        return { ok: true, output: out() };
      }

      default: {
        console.log(helpText());
        return {
          ok: false,
          error: `maw token: unknown subcommand "${sub}" (expected list|use|current|save|load|scan)`,
          output: out() || helpText(),
        };
      }
    }
  } catch (e: any) {
    // Re-raise the message but never include token values — error
    // messages from `pass` shouldn't contain secrets, but redact() is
    // available in lib.ts if a future change risks leaking. We keep
    // exception text here only because it's typically a structural
    // failure (missing binary, bad path).
    return { ok: false, error: out() || e.message, output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
