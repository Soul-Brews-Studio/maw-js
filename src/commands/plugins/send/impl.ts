/**
 * send — type raw text into any tmux pane (no Enter, composable).
 *
 * Dual of `maw send-enter` (#728). `maw send` puts characters on the prompt
 * line without submitting; pair with `maw send-enter` to submit, or use
 * `maw run` for the text+Enter combo. See #757.
 *
 * Unlike `maw hey`, this verb:
 *   - accepts ANY tmux pane (bash, claude, anything) — no readiness guard
 *   - uses `tmux send-keys -l` (literal) — no paste-mode, no smart escaping
 *   - never appends Enter — the caller composes
 *
 *   maw send <target> "<text>"
 */

import { listSessions, resolveTarget, Tmux, curlFetch } from "../../../sdk";
import { loadConfig } from "../../../config";
import { resolveOraclePane } from "../../shared/comm-send";

export interface SendOpts {
  target: string;
  text: string;
}

export async function cmdSend(opts: SendOpts): Promise<void> {
  const { target: query, text } = opts;
  if (!query) throw new Error('usage: maw send <target> "<text>"');

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
      body: JSON.stringify({ target: result.target, text, enter: false }),
      from: "auto", // #804 Step 4 SIGN — sign cross-node /api/pane-keys
    });
    if (!res.ok || !res.data?.ok) {
      const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
      throw new Error(`peer send failed (${result.node} ${result.peerUrl}): ${underlying}`);
    }
    console.log(`\x1b[32mtyped\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${truncate(text)}`);
    return;
  }

  // Local or self-node — resolve to specific pane (handles multi-pane oracle windows)
  const target = await resolveOraclePane(result.target);

  const t = new Tmux();
  await t.sendKeysLiteral(target, text);

  console.log(`\x1b[32mtyped\x1b[0m → ${target}: ${truncate(text)}`);
}

function truncate(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Parse args: <target> <text...>. The first positional (non-flag) arg is the
 * target; everything after is the text, joined with spaces. Dashes inside
 * the text are preserved so `maw send pane "ls -la"` and unquoted
 * `maw send pane ls -la` both work.
 *   ["mba:sloworacle", "echo hi"]              → { target, text: "echo hi" }
 *   ["mba:sloworacle", "echo", "hi"]           → { target, text: "echo hi" }
 *   ["mba:sloworacle", "ls", "-la", "/tmp"]    → { target, text: "ls -la /tmp" }
 */
export function parseSendArgs(args: string[]): SendOpts {
  // Find the first non-flag arg — that's the target. Everything after
  // (regardless of dashes) is text.
  const targetIdx = args.findIndex(a => !a.startsWith("-"));
  if (targetIdx < 0) throw new Error('usage: maw send <target> "<text>"');
  const target = args[targetIdx];
  const text = args.slice(targetIdx + 1).join(" ");
  if (text.length === 0) throw new Error('usage: maw send <target> "<text>" — text is required');
  return { target, text };
}
