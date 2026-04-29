import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "trust",
  description: "Pairwise trust list — list, add, remove (#842 Sub-B).",
};

/**
 * maw trust — primitive plugin (#842 Sub-B).
 *
 * Sub-B ships the data primitive + CLI verbs. ACL evaluation already
 * lives in Sub-A (#872) — `evaluateAcl(sender, target, scopes, trust?)`
 * accepts a `TrustList`. Sub-C will wire the loader into `comm-send.ts`
 * so that messages between non-shared-scope oracles get checked against
 * this list before queuing.
 *
 * Subcommand dispatcher mirrors `scope` (#829) and `peers` (#568): peel
 * positional[0] off as the verb, dispatch on a switch, print helpText()
 * on missing/unknown.
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const impl = await import("./impl");

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
  const help = () => [
    "usage: maw trust <list|add|remove> [...]",
    "  list                            — list all trust entries (sorted by addedAt)",
    "  add      <sender> <target>      — add a pair (idempotent, symmetric)",
    "  remove   <sender> <target> [--yes]",
    "                                  — remove a pair (confirms unless --yes; symmetric match)",
    "",
    "storage: <CONFIG_DIR>/trust.json (flat array of {sender, target, addedAt})",
    "",
    "note: Sub-B of #842 — primitive only. Caller integration (cross-scope",
    "      message routing in comm-send) lands in Sub-C.",
  ].join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const positional = args.filter(a => !a.startsWith("--"));
    const sub = positional[0];

    if (!sub) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    switch (sub) {
      case "list":
      case "ls": {
        console.log(impl.formatList(impl.cmdList()));
        return { ok: true, output: out() };
      }
      case "add": {
        const sender = positional[1];
        const target = positional[2];
        if (!sender || !target) {
          return { ok: false, error: "usage: maw trust add <sender> <target>" };
        }
        try {
          const res = impl.cmdAdd(sender, target);
          if (res.added) {
            console.log(`trusted "${res.entry.sender}" ↔ "${res.entry.target}"`);
            console.log(`  added at ${res.entry.addedAt}`);
          } else {
            console.log(
              `already trusted: "${res.entry.sender}" ↔ "${res.entry.target}" (added ${res.entry.addedAt})`,
            );
          }
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      case "remove":
      case "rm":
      case "delete": {
        const sender = positional[1];
        const target = positional[2];
        if (!sender || !target) {
          return {
            ok: false,
            error: "usage: maw trust remove <sender> <target> [--yes]",
          };
        }
        const confirmed = args.includes("--yes") || args.includes("-y");
        if (!confirmed) {
          console.log(
            `refusing to remove trust pair "${sender} ↔ ${target}" without --yes`,
          );
          console.log(
            `  to confirm: maw trust remove ${sender} ${target} --yes`,
          );
          return {
            ok: false,
            error: `remove requires --yes`,
            output: out(),
          };
        }
        try {
          const removed = impl.cmdRemove(sender, target);
          console.log(`removed trust pair "${removed.sender}" ↔ "${removed.target}"`);
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw trust: unknown subcommand "${sub}" (expected list|add|remove)`,
          output: out() || help(),
        };
      }
    }
  } catch (e: any) {
    return { ok: false, error: out() || e.message, output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
