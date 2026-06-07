import { cmdPeek, cmdSend } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";

function printCommUsage(cmd: "hey" | "send", write: (line: string) => void = console.log): void {
  write(`usage: maw ${cmd} <target> <message> [--inbox] [--force deprecated] [--approve] [--trust]`);
  write("  default: write receiver inbox and inject into the target pane");
  write("  --inbox: write receiver inbox only; skip pane injection");
  write("  --force: deprecated compatibility alias; delivery is already forced by default");
  write("  target forms:");
  write("    <oracle-window>              same-node window name (local-only)");
  write("    local:<agent>                explicit same-node target");
  write("    <session>:<window>[.<pane>]  paste a TARGET from maw ls -v");
  write("    <node>:<session>             canonical cross-node form (window 1)");
  write("    <node>:<session>:<window>    target a specific tmux window (#410)");
  write(`  e.g. maw ${cmd} mawjs-oracle "hello from neo"`);
  write(`       maw ${cmd} local:mawjs "hello from neo"`);
  write(`       maw ${cmd} phaith:01-hojo:3 "hello hojo-hermes"`);
  write("       run `maw locate <agent>` to enumerate across federation");
}

export async function routeComm(cmd: string, args: string[]): Promise<boolean> {
  // `peek` is a federation-aware comm verb. Keep `maw tmux peek` as the raw
  // tmux pane reader; top-level `maw peek <node>:<agent>` must reach cmdPeek.
  if (cmd === "peek") {
    await cmdPeek(args[1]);
    return true;
  }

  // `hey` and `send` stay core — they are message-delivery verbs.
  // #1388: restore `maw send` to the same submitted delivery path as `maw hey`.
  // The raw-text compositor plugin remains available through lower-level tmux
  // verbs; top-level `send` must not leave text buffered without Enter.
  if (cmd === "hey" || cmd === "send") {
    if (args[1] === "--help" || args[1] === "-h" || args[1] === "-help") {
      printCommUsage(cmd);
      return true;
    }

    const force = args.includes("--force");
    const inboxOnly = args.includes("--inbox");
    // #842 Sub-C — `--approve` bypasses the cross-scope ACL queue gate.
    // Operator-explicit opt-in for THIS message; mirrors the consent
    // `--pin` escape hatch already wired in #644. Optional `--trust`
    // pairs with `--approve` to also persist the sender↔target trust
    // entry so the same pair stops queuing on subsequent sends.
    const approve = args.includes("--approve");
    const trust = args.includes("--trust");
    const target = args[1];
    const msgArgs = args
      .slice(2)
      .filter(a => a !== "--force" && a !== "--inbox" && a !== "--approve" && a !== "--trust");

    // Distinguish: zero-args usage error vs missing-message error (#388.3)
    // A user who typed `maw hey mawjs` (just the target, no message) was
    // previously indistinguishable from `maw hey` alone — both hit the
    // same "usage:" error. Now the missing-message case names the target
    // so the user sees their input got through.
    if (!target) {
      printCommUsage(cmd, console.error);
      throw new UserError("missing target and message");
    }
    if (!msgArgs.length) {
      console.error(`✗ missing message for target '${target}'`);
      console.error(`  maw ${cmd} ${target} <message>`);
      console.error(`  (if '${target}' isn't a valid target, run 'maw ls' to see available ones)`);
      throw new UserError(`missing message for '${target}'`);
    }
    if (force) {
      console.error("\x1b[90mnote: --force is deprecated; maw hey delivers by default. Use --inbox to queue without pane injection.\x1b[0m");
    }
    await cmdSend(target, msgArgs.join(" "), force, { approve, trust, inboxOnly });
    return true;
  }
  return false;
}
