import { cmdSend } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";

export async function routeComm(cmd: string, args: string[]): Promise<boolean> {
  // hey stays core — it's the transport layer
  if (cmd === "hey" || cmd === "send" || cmd === "tell") {
    const force = args.includes("--force");
    const target = args[1];
    const msgArgs = args.slice(2).filter(a => a !== "--force");

    // Distinguish: zero-args usage error vs missing-message error (#388.3)
    // A user who typed `maw hey mawjs` (just the target, no message) was
    // previously indistinguishable from `maw hey` alone — both hit the
    // same "usage:" error. Now the missing-message case names the target
    // so the user sees their input got through.
    if (!target) {
      console.error("usage: maw hey <agent> <message> [--force]");
      console.error("  e.g. maw hey mawjs \"hello from neo\"");
      throw new UserError("missing target and message");
    }
    if (!msgArgs.length) {
      console.error(`✗ missing message for target '${target}'`);
      console.error(`  maw hey ${target} <message>`);
      console.error(`  (if '${target}' isn't a valid target, run 'maw ls' to see available ones)`);
      throw new UserError(`missing message for '${target}'`);
    }
    await cmdSend(target, msgArgs.join(" "), force);
    return true;
  }
  return false;
}
