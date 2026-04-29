import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "profile",
  description: "Profile primitive — named plugin bundles (Phase 1 of #640 / #888).",
};

/**
 * maw profile — primitive plugin (#888, Phase 1 of #640 lean-core epic).
 *
 * Phase 1 ships READ verbs + the active-profile pointer write. Profile JSON
 * authoring is operator-driven (write the file by hand at
 * `<CONFIG_DIR>/profiles/<name>.json`); a Phase 1.5 follow-up will add a
 * scaffolder. Phase 2 (separate sub-issue) wires `getActiveProfile()` into the
 * plugin registry so the chosen profile actually narrows the loader. Until
 * then this module is purely additive.
 *
 * Subcommand dispatcher mirrors the `scope` plugin (#642 Phase 1).
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
  const help = () =>
    [
      "usage: maw profile <list|use|show|current>",
      "  list                 — list all profiles (active is marked with *)",
      "  use     <name>       — set active profile (refuses unknown names)",
      "  show    <name>       — print one profile's JSON",
      "  current              — print active profile name",
      "",
      "storage:",
      "  <CONFIG_DIR>/profiles/<name>.json   — one file per profile",
      "  <CONFIG_DIR>/profile-active         — active profile pointer (text)",
      "",
      "note: Phase 1 of #640 — additive read + active-pointer only. Profile",
      "      authoring is operator-driven (hand-edit JSON). Phase 2 wires this",
      "      into the plugin loader.",
    ].join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const positional = args.filter((a) => !a.startsWith("--"));
    const sub = positional[0];

    if (!sub) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    switch (sub) {
      case "list":
      case "ls": {
        const rows = impl.cmdList();
        const active = impl.cmdCurrent();
        console.log(impl.formatList(rows, active));
        return { ok: true, output: out() };
      }
      case "use":
      case "set": {
        const name = positional[1];
        if (!name) return { ok: false, error: "usage: maw profile use <name>" };
        try {
          const used = impl.cmdUse(name);
          console.log(`active profile: "${used.name}"`);
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      case "show":
      case "info": {
        const name = positional[1];
        if (!name) return { ok: false, error: "usage: maw profile show <name>" };
        try {
          const found = impl.cmdShow(name);
          if (!found) {
            return {
              ok: false,
              error: `profile "${name}" not found`,
              output: out(),
            };
          }
          console.log(JSON.stringify(found, null, 2));
          return { ok: true, output: out() };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e), output: out() };
        }
      }
      case "current":
      case "active": {
        console.log(impl.cmdCurrent());
        return { ok: true, output: out() };
      }
      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw profile: unknown subcommand "${sub}" (expected list|use|show|current)`,
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
