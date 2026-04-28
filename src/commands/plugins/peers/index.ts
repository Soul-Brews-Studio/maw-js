import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "peers",
  description: "Federation peer aliases — add, list, info, remove (#568).",
};

/**
 * maw peers — core plugin (#568).
 *
 * Subcommand dispatcher over the impl.ts CRUD functions. Shape mirrors
 * the `project` plugin (#560): peel off positional[0] as the verb,
 * dispatch on a switch, print helpText() on missing/unknown.
 *
 * Integration with `maw hey`/`peek`/`send` (alias:agent resolution)
 * is intentionally deferred — this PR stands on its own with CRUD.
 * Follow-up: resolve `<alias>:<agent>` via loadPeers() before the
 * existing federation node lookup.
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
    "usage: maw peers <add|list|info|probe|probe-all|remove|forget> [...]",
    "  add       <alias> <url> [--node <name>] [--allow-unreachable]",
    "            — register alias (auto-probes /info). Exits non-zero on handshake failure:",
    "              2=UNKNOWN/BAD_BODY/TLS  3=DNS  4=REFUSED  5=TIMEOUT  6=HTTP_4XX/5XX",
    "            --allow-unreachable keeps exit 0 even when the probe fails (CI/bootstrap).",
    "  list                                      — tabular list of all peers",
    "  info      <alias>                         — JSON details for one peer (includes lastError if set)",
    "  probe     <alias>                         — re-run /info handshake; updates lastSeen / lastError (#565)",
    "  probe-all [--timeout <ms>] [--allow-unreachable]",
    "            — probe every peer in parallel; prints liveness table. Exit = worst PROBE_EXIT_CODE (#669).",
    "  remove    <alias>                         — remove (idempotent)",
    "  forget    <alias>                         — clear cached pubkey so next contact re-TOFUs (#804 Step 2)",
    "",
    "storage: ~/.maw/peers.json (v1)",
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
      case "add": {
        const alias = positional[1];
        const url = positional[2];
        if (!alias || !url) {
          return { ok: false, error: "usage: maw peers add <alias> <url> [--node <name>] [--allow-unreachable]" };
        }
        const nodeIdx = args.indexOf("--node");
        const node = nodeIdx >= 0 ? args[nodeIdx + 1] : undefined;
        const allowUnreachable = args.includes("--allow-unreachable");
        const res = await impl.cmdAdd({ alias, url, node });
        // TOFU mismatch refusal — fail loud, do not write. Operator must
        // `maw peers forget <alias>` first to re-pin (#804 Step 2).
        if (res.pubkeyMismatch) {
          console.error(`\x1b[31m✗\x1b[0m ${res.pubkeyMismatch.message}`);
          return {
            ok: false,
            output: out(),
            error: res.pubkeyMismatch.message,
            exitCode: 7,
          };
        }
        if (res.overwrote) console.log(`warning: alias "${alias}" already existed — overwriting`);
        console.log(`added ${alias} → ${url}${res.peer.node ? ` (${res.peer.node})` : ""}`);
        if (res.probeError) {
          const { formatProbeError, PROBE_EXIT_CODES } = await import("./probe");
          console.error(formatProbeError(res.probeError, url, alias));
          if (!allowUnreachable) {
            return {
              ok: false,
              output: out(),
              error: `peer handshake failed: ${res.probeError.code} — pass --allow-unreachable to bypass`,
              exitCode: PROBE_EXIT_CODES[res.probeError.code] ?? 2,
            };
          }
        }
        return { ok: true, output: out() };
      }
      case "probe": {
        const alias = positional[1];
        if (!alias) return { ok: false, error: "usage: maw peers probe <alias>" };
        const data = await import("./store").then(s => s.loadPeers());
        const existing = data.peers[alias];
        if (!existing) return { ok: false, error: `peer "${alias}" not found` };
        console.log(`probing ${alias} → ${existing.url} ...`);
        const r = await impl.cmdProbe(alias);
        // TOFU mismatch — fail loud, separate from network-level probe errors.
        if (r.pubkeyMismatch) {
          console.error(`\x1b[31m✗\x1b[0m ${r.pubkeyMismatch.message}`);
          return {
            ok: false,
            output: out(),
            error: r.pubkeyMismatch.message,
            exitCode: 7,
          };
        }
        if (r.ok) {
          console.log(`\x1b[32m✓\x1b[0m reached ${alias}${r.node ? ` (${r.node})` : ""}`);
          return { ok: true, output: out() };
        }
        const { formatProbeError } = await import("./probe");
        console.error(formatProbeError(r.error!, existing.url, alias));
        return { ok: false, error: `probe failed: ${r.error!.code}`, output: out() };
      }
      case "probe-all": {
        const timeoutIdx = args.indexOf("--timeout");
        let timeoutMs = 2000;
        if (timeoutIdx >= 0) {
          const raw = args[timeoutIdx + 1];
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return { ok: false, error: `usage: maw peers probe-all [--timeout <ms>]  (got --timeout ${raw ?? ""})` };
          }
          timeoutMs = parsed;
        }
        const allowUnreachable = args.includes("--allow-unreachable");
        const { cmdProbeAll, formatProbeAll } = await import("./probe-all");
        const r = await cmdProbeAll(timeoutMs);
        console.log(formatProbeAll(r));
        if (r.failCount > 0 && !allowUnreachable) {
          return {
            ok: false,
            output: out(),
            error: `probe-all: ${r.failCount}/${r.rows.length} peer(s) failed — pass --allow-unreachable to exit 0`,
            exitCode: r.worstExitCode || 2,
          };
        }
        return { ok: true, output: out() };
      }
      case "list":
      case "ls": {
        console.log(impl.formatList(impl.cmdList()));
        return { ok: true, output: out() };
      }
      case "info": {
        const alias = positional[1];
        if (!alias) return { ok: false, error: "usage: maw peers info <alias>" };
        const found = impl.cmdInfo(alias);
        if (!found) return { ok: false, error: `peer "${alias}" not found` };
        console.log(JSON.stringify(found, null, 2));
        return { ok: true, output: out() };
      }
      case "remove":
      case "rm": {
        const alias = positional[1];
        if (!alias) return { ok: false, error: "usage: maw peers remove <alias>" };
        const removed = impl.cmdRemove(alias);
        console.log(removed ? `removed ${alias}` : `no-op: ${alias} not present`);
        return { ok: true, output: out() };
      }
      case "forget": {
        const alias = positional[1];
        if (!alias) return { ok: false, error: "usage: maw peers forget <alias>" };
        const outcome = await impl.cmdForget(alias);
        switch (outcome) {
          case "cleared":
            console.log(`forgot pubkey for ${alias} — next contact will re-TOFU`);
            return { ok: true, output: out() };
          case "no-pubkey":
            console.log(`no-op: ${alias} has no cached pubkey (legacy peer)`);
            return { ok: true, output: out() };
          case "not-found":
            return { ok: false, error: `peer "${alias}" not found`, output: out() };
        }
        return { ok: true, output: out() };
      }
      default: {
        console.log(help());
        return {
          ok: false,
          error: `maw peers: unknown subcommand "${sub}" (expected add|list|info|probe|probe-all|remove|forget)`,
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
