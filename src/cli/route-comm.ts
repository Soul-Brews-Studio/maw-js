import { cmdPeek, cmdSend } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";

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
    const force = args.includes("--force");
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
      .filter(a => a !== "--force" && a !== "--approve" && a !== "--trust");

    // Distinguish: zero-args usage error vs missing-message error (#388.3)
    // A user who typed `maw hey mawjs` (just the target, no message) was
    // previously indistinguishable from `maw hey` alone — both hit the
    // same "usage:" error. Now the missing-message case names the target
    // so the user sees their input got through.
    if (!target) {
      console.error(`usage: maw ${cmd} <target> <message> [--force]`);
      console.error("  target forms (#759 Phase 2 — bare names removed):");
      console.error("    local:<agent>                this node");
      console.error("    <node>:<session>             canonical cross-node form (window 1)");
      console.error("    <node>:<session>:<window>    target a specific tmux window (#410)");
      console.error(`  e.g. maw ${cmd} local:mawjs "hello from neo"`);
      console.error(`       maw ${cmd} phaith:01-hojo:3 "hello hojo-hermes"`);
      console.error("       run `maw locate <agent>` to enumerate across federation");
      throw new UserError("missing target and message");
    }
    if (!msgArgs.length) {
      console.error(`✗ missing message for target '${target}'`);
      console.error(`  maw ${cmd} ${target} <message>`);
      console.error(`  (if '${target}' isn't a valid target, run 'maw ls' to see available ones)`);
      throw new UserError(`missing message for '${target}'`);
    }
    await cmdSend(target, msgArgs.join(" "), force, { approve, trust });
    return true;
  }
  return false;
}
