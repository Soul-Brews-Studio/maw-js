import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdWorkspaceCreate, cmdWorkspaceJoin, cmdWorkspaceShare, cmdWorkspaceUnshare, cmdWorkspaceLs, cmdWorkspaceAgents, cmdWorkspaceInvite, cmdWorkspaceLeave, cmdWorkspaceStatus } from "maw-js/commands/shared/workspace";

export const command = {
  name: ["workspace", "ws"],
  description: "Multi-node workspace management.",
};

// ---------------------------------------------------------------------------
// Pure parsing helpers — exported for golden-master tests
// ---------------------------------------------------------------------------

/** Parse args for `workspace create <name> [--hub <url>]` */
export function _parseCreate(args: string[]): { name: string | undefined; hub: string | undefined } {
  const flags = parseFlags(args.slice(1), { "--hub": String }, 0);
  return { name: flags._[0] || undefined, hub: flags["--hub"] };
}

/** Parse args for `workspace join <code> [--hub <url>]` */
export function _parseJoin(args: string[]): { code: string | undefined; hub: string | undefined } {
  const flags = parseFlags(args.slice(1), { "--hub": String }, 0);
  return { code: flags._[0] || undefined, hub: flags["--hub"] };
}

/** Parse args for `workspace share/unshare [--workspace <id>] [--ws <id>] <agent...>` */
export function _parseShareAgents(args: string[]): { wsId: string | undefined; agents: string[] } {
  const flags = parseFlags(args.slice(1), {
    "--workspace": String,
    "--ws": "--workspace",
  }, 0);
  return { wsId: flags["--workspace"], agents: flags._ };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
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
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "create") {
      const { name, hub } = _parseCreate(args);
      if (!name) {
        logs.push("usage: maw workspace create <name> [--hub <url>]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      await cmdWorkspaceCreate(name, hub);
    } else if (sub === "join") {
      const { code, hub } = _parseJoin(args);
      if (!code) {
        logs.push("usage: maw workspace join <code> [--hub <url>]");
        return { ok: false, error: "code required", output: logs.join("\n") };
      }
      await cmdWorkspaceJoin(code, hub);
    } else if (sub === "share") {
      const { wsId, agents } = _parseShareAgents(args);
      if (agents.length === 0) {
        logs.push("usage: maw workspace share <agent...> [--workspace <id>]");
        return { ok: false, error: "agent required", output: logs.join("\n") };
      }
      await cmdWorkspaceShare(agents, wsId);
    } else if (sub === "unshare") {
      const { wsId, agents } = _parseShareAgents(args);
      if (agents.length === 0) {
        logs.push("usage: maw workspace unshare <agent...> [--workspace <id>]");
        return { ok: false, error: "agent required", output: logs.join("\n") };
      }
      await cmdWorkspaceUnshare(agents, wsId);
    } else if (sub === "ls" || sub === "list") {
      await cmdWorkspaceLs();
    } else if (sub === "agents") {
      await cmdWorkspaceAgents(args[1]);
    } else if (sub === "invite") {
      await cmdWorkspaceInvite(args[1]);
    } else if (sub === "leave") {
      await cmdWorkspaceLeave(args[1]);
    } else if (sub === "status") {
      await cmdWorkspaceStatus();
    } else if (!sub) {
      await cmdWorkspaceLs();
    } else {
      logs.push("\x1b[36mmaw workspace\x1b[0m \u2014 Multi-node workspace management\n");
      logs.push("  maw workspace create <name>          Create workspace on hub");
      logs.push("  maw workspace join <code>            Join with invite code");
      logs.push("  maw workspace share <agent...>       Share agents to workspace");
      logs.push("  maw workspace unshare <agent...>     Remove agents from workspace");
      logs.push("  maw workspace ls                     List joined workspaces");
      logs.push("  maw workspace agents [workspace-id]  List all agents in workspace");
      logs.push("  maw workspace invite [workspace-id]  Show join code");
      logs.push("  maw workspace leave [workspace-id]   Leave workspace");
      logs.push("  maw workspace status                 Connection status to hub(s)\n");
      logs.push("\x1b[90mAlias: maw ws ...\x1b[0m");
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
