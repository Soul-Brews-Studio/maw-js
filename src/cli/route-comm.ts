import { cmdPeek, cmdSend, cmdFlush } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";

function printCommUsage(cmd: "hey" | "send" | "notify", write: (line: string) => void = console.log): void {
  if (cmd === "notify") {
    write(`usage: maw notify [--from <node:oracle>] <target> <message> [--approve] [--trust]`);
    write("  Routine push — persists to recipient's ψ/inbox/ for them to pull via `maw inbox --unread`.");
    write("  Does NOT inject into the target pane (unlike `maw hey`). #1882");
    write("  --from <node:oracle>: explicit sender for SSH relays; env fallback: MAW_SENDER");
    write("  target forms: same as maw hey (oracle-window | local:agent | session:window | node:session)");
    write(`  e.g. maw notify mawjs-oracle "task done — fyi, recipient pulls when ready"`);
    write(`       maw notify phaith:01-hojo:3 "routine cross-node ping"`);
    write("  Pairs with `maw hey` (urgent, pane-injecting) and `maw broadcast` (fleet-wide).");
    return;
  }
  write(`usage: maw ${cmd} [--from <node:oracle>] <target> <message> [--inbox] [--force deprecated] [--approve] [--trust] [--no-verify-submit]`);
  if (cmd === "send") {
    write("  note: top-level `maw send` is an alias of `maw hey` (#1388 / #1915) — both pane-inject");
    write("        with a signed identity envelope and a trailing Enter. For raw text (no envelope,");
    write("        no Enter), use `maw send-text`.");
  }
  write("  default: write receiver inbox and inject into the target pane");
  write("  --from <node:oracle>: explicit sender for SSH relays; env fallback: MAW_SENDER");
  write("  --inbox: write receiver inbox only; skip pane injection");
  write("  --no-verify-submit: skip the post-send Enter-retry probe (#1907). Saves ~800ms per call; only set for tight loops.");
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

  // eq3-003 — `maw flush [oracle]` drains the deferred-message queue (pane-input
  // guard). Default oracle = self. Pairs with the periodic server sweep; the
  // Claude Code hook calls this on UserPromptSubmit/Stop for instant delivery.
  if (cmd === "flush") {
    if (args[1] === "--help" || args[1] === "-h" || args[1] === "-help") {
      console.log("usage: maw flush [oracle]");
      console.log("  Drain deferred messages held back by the pane-input guard (eq3-003).");
      console.log("  Re-checks pane-clean before each inject; dirty panes keep their queue.");
      console.log("  oracle defaults to self (CLAUDE_AGENT_NAME / attached tmux pane).");
      return true;
    }
    await cmdFlush(args[1]);
    return true;
  }

  // `hey` and `send` stay core — they are message-delivery verbs.
  // #1388: restore `maw send` to the same submitted delivery path as `maw hey`.
  // The raw-text compositor plugin remains available through lower-level tmux
  // verbs; top-level `send` must not leave text buffered without Enter.
  // #1882: `notify` is a routine push — same transport as `hey --inbox` with a
  //  cleaner verb. The --inbox flag is implicit; --force is N/A since notify
  //  never pane-injects. Other flags (--from, --approve, --trust) parse the same.
  if (cmd === "hey" || cmd === "send" || cmd === "notify") {
    const isNotify = cmd === "notify";

    if (args[1] === "--help" || args[1] === "-h" || args[1] === "-help") {
      printCommUsage(cmd);
      return true;
    }

    const rest = args.slice(1);
    let force = false;
    let inboxOnly = isNotify;  // #1882 — notify always inbox-only
    // #842 Sub-C — `--approve` bypasses the cross-scope ACL queue gate.
    // Operator-explicit opt-in for THIS message; mirrors the consent
    // `--pin` escape hatch already wired in #644. Optional `--trust`
    // pairs with `--approve` to also persist the sender↔target trust
    // entry so the same pair stops queuing on subsequent sends.
    let approve = false;
    let trust = false;
    let noVerifySubmit = false;
    let from: string | undefined;
    let target: string | undefined;
    const msgArgs: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--force") { force = true; continue; }
      if (arg === "--inbox") { inboxOnly = true; continue; }
      if (arg === "--approve") { approve = true; continue; }
      if (arg === "--trust") { trust = true; continue; }
      if (arg === "--no-verify-submit") { noVerifySubmit = true; continue; }
      if (arg === "--from") {
        if (!rest[i + 1] || rest[i + 1].startsWith("--")) {
          console.error("✗ missing value for --from");
          console.error(`  maw ${cmd} --from <node:oracle> <target> <message>`);
          throw new UserError("missing value for --from");
        }
        from = rest[i + 1];
        i += 1;
        continue;
      }
      if (arg.startsWith("--from=")) {
        from = arg.slice("--from=".length);
        continue;
      }
      if (!target) target = arg;
      else msgArgs.push(arg);
    }

    if (from !== undefined && !from.trim()) {
      console.error("✗ missing value for --from");
      console.error(`  maw ${cmd} --from <node:oracle> <target> <message>`);
      throw new UserError("missing value for --from");
    }

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
      if (isNotify) {
        console.error("\x1b[90mnote: --force is not meaningful for notify (delivery is always inbox-only).\x1b[0m");
      } else {
        console.error("\x1b[90mnote: --force is deprecated; maw hey delivers by default. Use --inbox to queue without pane injection.\x1b[0m");
      }
    }
    const message = msgArgs.join(" ");

    // `[request:<id>]` convention hooks — turn a dispatch into (1) a board card
    // (Track 3) and (2) a tracked request-reply entry so `maw reply <id>` works.
    // Both MUST run BEFORE cmdSend: cmdSend calls process.exit() on many delivery
    // outcomes, so a hook placed after it never executes (the live #50 bug).
    // Recording first is also the right semantics — "this request was sent",
    // independent of whether delivery then succeeds. Cheap substring gate first
    // → normal hey/send pay ~nothing; best-effort try/catch so a hook failure
    // never blocks delivery; notify + broadcast excluded.
    if (!isNotify && message.includes("[request:")) {
      try {
        const [{ autoCreateFromDispatch, parseRequestDispatch }, { resolveSenderIdentity }, { loadConfig }, { trackRequest }] = await Promise.all([
          import("../core/tasks/auto-create"),
          import("../commands/shared/comm-send"),
          import("../config"),
          import("../core/request-track-client"),
        ]);
        const resolveSender = (): string | null => {
          try {
            return resolveSenderIdentity(loadConfig(), from ? { from } : {}).senderName;
          } catch {
            return null; // can't resolve sender (e.g. SSH relay without --from) → skip
          }
        };
        autoCreateFromDispatch(message, target, resolveSender);
        // register the correlationId into the server store so `maw reply` finds it
        const parsed = parseRequestDispatch(message);
        if (parsed) {
          const sender = resolveSender();
          if (sender) await trackRequest(parsed.requestId, sender, target, message);
        }
      } catch {
        /* request-convention hooks are best-effort — never break hey/send delivery */
      }
    }

    await cmdSend(target, message, force, { approve, trust, inboxOnly, ...(noVerifySubmit ? { noVerifySubmit } : {}), ...(from ? { from } : {}) });
    return true;
  }
  return false;
}
