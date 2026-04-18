import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdInit } from "./impl";

export const command = {
  name: "init",
  description: "First-run wizard — configure ~/.config/maw/maw.config.json",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const writer = (m: string) => {
    if (ctx.writer) ctx.writer(m);
    else logs.push(m);
  };
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => writer(a.map(String).join(" "));
  console.error = (...a: any[]) => writer(a.map(String).join(" "));

  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      if (args[0] === "--help" || args[0] === "-h") {
        return {
          ok: true,
          output: "maw init [--non-interactive --node <name> --ghq-root <path> --token <t> --federate --peer <url> --peer-name <name> --federation-token <hex> --force]\n\nInteractive 4-question wizard. Writes ~/.config/maw/maw.config.json.\nIn non-interactive mode, all required fields fall back to detected defaults\n(hostname, ghq root). Existing config requires --force to overwrite.",
        };
      }
      const result = await cmdInit({ args, writer });
      if (!result.ok) return { ok: false, error: result.error ?? "init failed", output: logs.join("\n") || undefined };
      return { ok: true, output: logs.join("\n") || undefined };
    }
    if (ctx.source === "api") {
      // API-mode init: accept the same options as the non-interactive CLI.
      // We translate the body into the equivalent flag array so we share
      // the parser and validation paths with the CLI.
      const body = (ctx.args ?? {}) as Record<string, unknown>;
      const args: string[] = ["--non-interactive"];
      if (body.node) args.push("--node", String(body.node));
      if (body.ghqRoot) args.push("--ghq-root", String(body.ghqRoot));
      if (body.token) args.push("--token", String(body.token));
      if (body.federate) args.push("--federate");
      if (Array.isArray(body.peers)) {
        for (const p of body.peers as Array<{ name: string; url: string }>) {
          args.push("--peer", p.url);
          args.push("--peer-name", p.name);
        }
      }
      if (body.federationToken) args.push("--federation-token", String(body.federationToken));
      if (body.force) args.push("--force");
      const result = await cmdInit({ args, writer });
      if (!result.ok) return { ok: false, error: result.error ?? "init failed", output: logs.join("\n") || undefined };
      return { ok: true, output: logs.join("\n") || undefined };
    }
    return { ok: false, error: "unsupported source" };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
