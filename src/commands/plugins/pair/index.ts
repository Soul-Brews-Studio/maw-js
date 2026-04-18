/**
 * maw pair — dispatcher (#573).
 * verbs: (none) → generate+listen; `accept <code>` → complete handshake.
 * flags: --expires <sec>, --at <url>, --port <n>.
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "pair",
  description: "Bluetooth-style federation pairing — ephemeral code handshake (#573).",
};

function help(): string {
  return [
    "usage:",
    "  maw pair [--expires <sec>]         — generate pair code, listen for accept",
    "  maw pair accept <code> [flags]     — complete handshake as acceptor",
    "",
    "flags (accept): --at <url>  explicit target  --port <n>  scan port (3456)",
    "replaces manual federation-token copy-paste (#565 facet 3).",
  ].join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { pairGenerate, pairAccept } = await import("./impl");

  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = (...a: any[]) => ctx.writer ? ctx.writer(...a) : logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => ctx.writer ? ctx.writer(...a) : logs.push(a.map(String).join(" "));
  console.warn = (...a: any[]) => ctx.writer ? ctx.writer(...a) : logs.push(a.map(String).join(" "));
  const out = () => logs.join("\n");

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const positional = args.filter(a => !a.startsWith("--"));
    const sub = positional[0];
    const flagVal = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

    if (!sub) {
      const expires = flagVal("--expires");
      const expiresSec = expires ? parseInt(expires, 10) : undefined;
      if (expires && (!expiresSec || expiresSec < 5 || expiresSec > 3600)) {
        return { ok: false, error: "--expires must be 5..3600 seconds" };
      }
      const res = await pairGenerate({ expiresSec });
      if (!res.ok) return { ok: false, error: res.error, output: out() || undefined };
      return { ok: true, output: out() };
    }

    if (sub === "accept") {
      const code = positional[1];
      if (!code) return { ok: false, error: "usage: maw pair accept <code> [--at <url>]" };
      const at = flagVal("--at");
      const portStr = flagVal("--port");
      const port = portStr ? parseInt(portStr, 10) : undefined;
      if (portStr && (!port || port < 1 || port > 65535)) return { ok: false, error: "--port must be 1..65535" };
      const res = await pairAccept(code, { at, port });
      if (!res.ok) return { ok: false, error: res.error, output: out() || undefined };
      return { ok: true, output: out() };
    }

    console.log(help());
    return { ok: false, error: `maw pair: unknown subcommand "${sub}"`, output: out() || help() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}
