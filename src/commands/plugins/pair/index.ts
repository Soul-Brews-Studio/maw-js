/**
 * maw pair — dispatcher (#573).
 * HTTP server-to-server pairing with explicit URL + ephemeral code.
 *
 *   maw pair generate [--expires <sec>]   — recipient: mint code, listen
 *   maw pair <url> <code>                 — initiator: post to remote server
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "pair",
  description: "HTTP server-to-server federation pairing — ephemeral code handshake (#573).",
};

function help(): string {
  return [
    "usage:",
    "  maw pair generate [--expires <sec>]    — recipient: print code, listen",
    "  maw pair <url> <code>                  — initiator: post handshake to <url>",
    "",
    "example: B: `maw pair generate` → prints W4K-7F3; A: `maw pair http://b:5002 W4K-7F3`",
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
    const flagVal = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

    if (positional.length === 0) {
      console.log(help());
      return { ok: true, output: out() || help() };
    }

    if (positional[0] === "generate") {
      const expires = flagVal("--expires");
      const expiresSec = expires ? parseInt(expires, 10) : undefined;
      if (expires && (!expiresSec || expiresSec < 5 || expiresSec > 3600)) {
        return { ok: false, error: "--expires must be 5..3600 seconds" };
      }
      const res = await pairGenerate({ expiresSec });
      if (!res.ok) return { ok: false, error: res.error, output: out() || undefined };
      return { ok: true, output: out() };
    }

    if (positional.length >= 2 && /^https?:\/\//.test(positional[0])) {
      const [url, code] = positional;
      const res = await pairAccept(url, code);
      if (!res.ok) return { ok: false, error: res.error, output: out() || undefined };
      return { ok: true, output: out() };
    }

    console.log(help());
    return {
      ok: false,
      error: `maw pair: unexpected args (got "${positional.join(" ")}") — expected 'generate' or '<url> <code>'`,
      output: out() || help(),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), output: out() || undefined };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}
