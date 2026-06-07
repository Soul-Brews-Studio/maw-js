import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "scope",
  description: "Routing scope primitive — list, create, show, delete (#642 Phase 1).",
};

/**
 * maw scope — primitive plugin (#642 Phase 1).
 *
 * Phase 1 ships ONLY the data primitive + CLI verbs. ACL evaluation,
 * trust list, and approval queue all land in follow-up issues. This
 * unblocks operators creating named scopes today; routing enforcement
 * comes later.
 *
 * Subcommand dispatcher mirrors the `peers` plugin (#568): peel
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
    "usage: maw scope <list|create|show|delete> [...]",
    "  list                                                    — list all scopes",
    "  create   <name> --members <a,b,c> [--lead <m>] [--ttl <iso>]",
    "                                                          — create new scope (refuses overwrite)",
    "  show     <name>                                         — print one scope's JSON",
    "  delete   <name> [--yes]                                 — remove scope file (confirms unless --yes)",
    "",
    "storage: <CONFIG_DIR>/scopes/<name>.json (one file per scope)",
    "",
    "note: Phase 1 of #642 — primitive only. ACL evaluation, trust list, and",
    "      cross-scope approval queue are deferred to follow-up issues.",
  ].join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const positional = args.filter(a => !a.startsWith("--"));
    const sub = positional[0];

    if (!sub) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    const flagValue = (flag: string): string | undefined => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    };

    switch (sub) {
      case "list":
      case "ls": {
        console.log(impl.formatList(impl.cmdList()));
        return { ok: true, output: out() };
      }
      case "create":
      case "new": {
        const name = positional[1];
        if (!name) {
          return { ok: false, error: "usage: maw scope create <name> --members <a,b,c> [--lead <m>] [--ttl <iso>]" };
        }
        const membersRaw = flagValue("--members");
        if (!membersRaw) {
          return { ok: false, error: `usage: maw scope create ${name} --members <a,b,c> [--lead <m>] [--ttl <iso>]` };
        }
        const members = membersRaw.split(",").map(s => s.trim()).filter(Boolean);
        const lead = flagValue("--lead");
        const ttlRaw = flagValue("--ttl");
        const ttl = ttlRaw === undefined ? null : ttlRaw;
        try {
          const created = impl.cmdCreate({ name, members, lead, ttl });
          console.log(`created scope "${created.name}" (${created.members.length} member${created.members.length === 1 ? "" : "s"})`);
          console.log(`  ${impl.scopePath(created.name)}`);
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      case "show":
      case "info": {
        const name = positional[1];
        if (!name) return { ok: false, error: "usage: maw scope show <name>" };
        try {
          const found = impl.cmdShow(name);
          if (!found) return { ok: false, error: `scope "${name}" not found`, output: out() };
          console.log(JSON.stringify(found, null, 2));
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      case "delete":
      case "rm":
      case "remove": {
        const name = positional[1];
        if (!name) return { ok: false, error: "usage: maw scope delete <name> [--yes]" };
        const confirmed = args.includes("--yes") || args.includes("-y");
        if (!confirmed) {
          console.log(`refusing to delete scope "${name}" without --yes`);
          console.log(`  to confirm: maw scope delete ${name} --yes`);
          return { ok: false, error: `delete requires --yes`, output: out() };
        }
        try {
          const removed = impl.cmdDelete(name);
          console.log(removed ? `deleted scope "${name}"` : `no-op: scope "${name}" not present`);
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw scope: unknown subcommand "${sub}" (expected list|create|show|delete)`,
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
