/**
 * send-enter — manually submit pending input on a maw target.
 *
 * `maw hey` sometimes leaves text as pending input on the target pane
 * (older targets / interactive UIs without the #714 1500ms paste-render
 * delay). This is the manual escape hatch — sends Enter to any maw target
 * without attaching.
 *
 * Phase 1 (#728): local-only. Federation can be a follow-up.
 *
 *   maw send-enter <target>          # send single Enter
 *   maw send-enter <target> --N 3    # send N Enters
 */

import { listSessions, resolveTarget, tmux } from "../../../sdk";
import { loadConfig } from "../../../config";
import { resolveOraclePane } from "../../shared/comm-send";

export interface SendEnterOpts {
  target: string;
  count?: number;
}

export async function cmdSendEnter(opts: SendEnterOpts): Promise<void> {
  const { target: query } = opts;
  const count = Math.max(1, opts.count ?? 1);

  if (!query) throw new Error("usage: maw send-enter <target> [--N <count>]");

  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(query, config, sessions);

  if (!result) {
    throw new Error(`could not resolve target: ${query}`);
  }

  if (result.type === "error") {
    const hint = result.hint ? ` — ${result.hint}` : "";
    throw new Error(`${result.detail}${hint}`);
  }

  if (result.type === "peer") {
    // Phase 1: local-only. Federation deferred to follow-up (see #728).
    throw new Error(
      `send-enter: cross-node target '${query}' (node '${result.node}') not yet supported — Phase 1 is local-only. ` +
        `Workaround: ssh ${result.node} && maw send-enter ${result.target}`,
    );
  }

  // Local or self-node — resolve to specific pane (handles multi-pane oracle windows)
  const target = await resolveOraclePane(result.target);

  for (let i = 0; i < count; i++) {
    await tmux.sendKeys(target, "Enter");
  }

  const plural = count === 1 ? "Enter" : `${count} Enters`;
  console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${plural}`);
}

/**
 * Parse args: positional target, optional `--N <count>`.
 *   ["mba:sloworacle"]              → { target: "mba:sloworacle", count: 1 }
 *   ["mba:sloworacle", "--N", "3"]  → { target: "mba:sloworacle", count: 3 }
 *   ["--N", "3", "mba:sloworacle"]  → { target: "mba:sloworacle", count: 3 }
 */
export function parseSendEnterArgs(args: string[]): SendEnterOpts {
  let target: string | undefined;
  let count = 1;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--N" || a === "-N" || a === "--n") {
      const next = args[i + 1];
      const n = parseInt(next ?? "", 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--N requires a positive integer (got: ${next ?? "nothing"})`);
      }
      count = n;
      i++;
      continue;
    }
    if (a.startsWith("--N=") || a.startsWith("--n=")) {
      const n = parseInt(a.split("=")[1] ?? "", 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--N requires a positive integer (got: ${a})`);
      }
      count = n;
      continue;
    }
    if (!target && !a.startsWith("-")) {
      target = a;
      continue;
    }
  }

  if (!target) throw new Error("usage: maw send-enter <target> [--N <count>]");
  return { target, count };
}
