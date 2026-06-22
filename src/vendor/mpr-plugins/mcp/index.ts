import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server";

export const command = {
  name: "mcp",
  description: "Run the stdio MCP server (register in ~/.claude.json).",
};

/**
 * `maw mcp` (and `maw mcp serve`) launch a long-lived stdio MCP server. This
 * handler BLOCKS on the transport for the life of the process — it never
 * returns under normal operation.
 *
 * CRITICAL: stdout is the MCP JSON-RPC channel. Readiness/errors go to stderr
 * only. We do NOT touch ctx.writer (it would write to stdout for CLI source).
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  // `serve` is the default/only action; both `maw mcp` and `maw mcp serve`
  // behave identically.
  try {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    console.error("[maw:mcp] ready — stdio MCP server listening (stdout = JSON-RPC)");
    // Block forever: the transport keeps the process alive. We await a promise
    // that only rejects if the transport closes.
    await new Promise<void>((resolve) => {
      server.server.onclose = () => resolve();
    });
    return { ok: true };
  } catch (e: any) {
    console.error("[maw:mcp] fatal:", e?.message ?? e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}
