import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { spawn } from "child_process";
import { existsSync } from "fs";

export const command = {
  name: "no10",
  description: "No.10 X fleet operations."
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const out: string[] = [];
  const log = (s: string) => (ctx.writer ? ctx.writer(s) : out.push(s));
  const done = (ok: boolean): InvokeResult => ({ ok, output: ctx.writer ? "" : out.join("\n"), exitCode: ok ? 0 : 1 });
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

  const sub = args[0]?.toLowerCase();
  const action = args[1]?.toLowerCase();

  if (sub === "rust" && action === "serve") {
    log("🚀 Starting Rust-based Discord Proxy Server (Avengers) on port 8090...");
    
    // We will spawn the compiled avengers binary from /tmp/claude-proxy-main/
    const binPath = "/tmp/claude-proxy-main/claude-proxy-main/target/release/avengers";
    if (!existsSync(binPath)) {
      log(`❌ Error: Avengers binary not found at ${binPath}. Please compile it first.`);
      return done(false);
    }

    const child = spawn(binPath, [], {
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        PORT: "8090"
      }
    });

    child.unref();
    log(`✅ Avengers server spawned successfully in background (PID: ${child.pid}).`);
    return done(true);
  }

  log("Usage:");
  log("  maw no10 rust serve      — start the Rust-based Discord Rate Limit Proxy (Avengers)");
  return done(false);
}
