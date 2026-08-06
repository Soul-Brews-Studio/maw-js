import { spawn } from "child_process";

export interface CodespaceCommandCtx {
  args: string[];
  writer?: (...a: any[]) => void;
}

function defaultRelayPath(): string {
  return process.env.CODESPACE_RELAY_SCRIPT ?? "/workspaces/Jit/network/federation/codespace_relay.py";
}

function runPython(
  argv: string[],
  writer?: (...a: any[]) => void,
): Promise<{ ok: boolean; output: string; rc: number }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", argv, { encoding: "utf-8" });
    let output = "";
    proc.stdout?.on("data", (chunk) => { output += String(chunk); writer?.(String(chunk)); });
    proc.stderr?.on("data", (chunk) => { output += String(chunk); writer?.(String(chunk)); });
    proc.on("error", (err) => {
      writer?.(`[codespace] spawn error: ${err.message}`);
      resolve({ ok: false, output: err.message, rc: -1 });
    });
    proc.on("close", (rc) => {
      resolve({ ok: rc === 0, output, rc: rc ?? -1 });
    });
  });
}

export async function cmdFleetCodespace(ctx: CodespaceCommandCtx): Promise<{ ok: boolean; output?: string; error?: string }> {
  const args = ctx.args;
  const sub = args[0];
  const relay = defaultRelayPath();

  if (sub === "list" || sub === "ls") {
    const result = await runPython([relay, "list"], ctx.writer);
    let parsed: any;
    try { parsed = JSON.parse(result.output); } catch { parsed = null; }
    if (parsed?.codespaces) {
      ctx.writer?.(`Codespaces (${parsed.live_count} live):`);
      for (const cs of parsed.codespaces) {
        const state = cs.reachable ? `\x1b[32m${cs.state}\x1b[0m` : `\x1b[90m${cs.state}\x1b[0m`;
        ctx.writer?.(`  ${cs.label || cs.name}  ${cs.repo || ""} [${state}]`);
      }
    } else {
      ctx.writer?.(result.output || "no output");
    }
    return { ok: result.ok, output: result.output };
  }

  if (sub === "ssh") {
    const label = args[1];
    const cmd = args.slice(2).join(" ");
    if (!label || !cmd) {
      return { ok: false, error: "usage: maw fleet codespace ssh <label> <cmd>" };
    }
    const result = await runPython([relay, "run", label, cmd], ctx.writer);
    return { ok: result.ok, output: result.output };
  }

  if (sub === "task") {
    const label = args[1];
    const cmd = args.slice(2).join(" ");
    if (!label || !cmd) {
      return { ok: false, error: "usage: maw fleet codespace task <label> <cmd>" };
    }
    const result = await runPython([relay, "run", label, cmd], ctx.writer);
    return { ok: result.ok, output: result.output };
  }

  return {
    ok: false,
    error: "usage: maw fleet codespace <list|ssh|task> [args]",
  };
}
