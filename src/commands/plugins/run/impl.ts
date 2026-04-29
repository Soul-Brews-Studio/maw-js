/**
 * run — type text into any tmux pane and submit with Enter.
 *
 * Idiomatic verb for shell panes: `maw run <target> "<cmd>"` is the same as
 * `maw send <target> "<cmd>" && maw send-enter <target>`. See #757.
 *
 * Unlike `maw hey`, this verb:
 *   - accepts ANY tmux pane (bash, claude, anything) — no readiness guard
 *   - uses `tmux send-keys -l` (literal) — no paste-mode, no smart escaping
 *   - always appends Enter — submits the line
 *
 *   maw run <target> "<cmd>"
 */

import { listSessions, resolveTarget, Tmux, curlFetch } from "../../../sdk";
import { loadConfig } from "../../../config";
import { resolveOraclePane } from "../../shared/comm-send";

export interface RunOpts {
  target: string;
  text: string;
}

export async function cmdRun(opts: RunOpts): Promise<void> {
  const { target: query, text } = opts;
  if (!query) throw new Error('usage: maw run <target> "<cmd>"');

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
    // Cross-node — route via federation /api/pane-keys (#757).
    const res = await curlFetch(`${result.peerUrl}/api/pane-keys`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text, enter: true }),
      from: "auto", // #804 Step 4 SIGN — sign cross-node /api/pane-keys
    });
    if (!res.ok || !res.data?.ok) {
      const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
      throw new Error(`peer run failed (${result.node} ${result.peerUrl}): ${underlying}`);
    }
    console.log(`\x1b[32mran\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${truncate(text)}`);
    return;
  }

  // Local or self-node — resolve to specific pane (handles multi-pane oracle windows)
  const target = await resolveOraclePane(result.target);

  const t = new Tmux();
  if (text.length > 0) {
    await t.sendKeysLiteral(target, text);
  }
  await t.sendKeys(target, "Enter");

  console.log(`\x1b[32mran\x1b[0m → ${target}: ${truncate(text)}`);
}

function truncate(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Parse args: <target> <cmd...>. The first positional (non-flag) arg is the
 * target; everything after is the cmd, joined with spaces. Dashes inside
 * the cmd are preserved so `maw run pane "ls -la"` and unquoted
 * `maw run pane ls -la` both work. Empty cmd is allowed (degenerates to a
 * bare Enter, same as `maw send-enter`).
 *   ["bash-pane", "ls", "-la"]  → { target: "bash-pane", text: "ls -la" }
 *   ["bash-pane"]               → { target: "bash-pane", text: "" }
 */
export function parseRunArgs(args: string[]): RunOpts {
  const targetIdx = args.findIndex(a => !a.startsWith("-"));
  if (targetIdx < 0) throw new Error('usage: maw run <target> "<cmd>"');
  const target = args[targetIdx];
  const text = args.slice(targetIdx + 1).join(" ");
  return { target, text };
}
