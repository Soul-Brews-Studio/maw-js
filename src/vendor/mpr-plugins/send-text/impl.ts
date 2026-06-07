/**
 * send-text — type text + Enter into any tmux pane.
 *
 * Sibling of `maw send` (raw-no-Enter, #757) and `maw send-enter` (#728):
 *   - `send`       — types text, no Enter (composable building block)
 *   - `send-enter` — sends Enter only (composable)
 *   - `send-text`  — types text AND presses Enter (one-shot submit)
 *
 * Uses `Tmux.sendText()` which auto-handles multi-line buffer paste, long
 * strings, and Enter timing — same primitive `maw hey` sits on top of, but
 * without hey's federation/inbox plumbing or readiness guards.
 *
 * Sister of `awaken` — used to fire `/awaken` into a freshly-woken oracle's
 * Claude TUI prompt.
 *
 *   maw send-text <target> "<text>"
 */
import { listSessions, resolveTarget, Tmux, curlFetch } from "maw-js/sdk";
import { loadConfig } from "maw-js/config";
import { resolveOraclePane } from "maw-js/commands/shared/comm-send";

export interface SendTextOpts {
  target: string;
  text: string;
}

export async function cmdSendText(opts: SendTextOpts): Promise<void> {
  const { target: query, text } = opts;
  if (!query) throw new Error('usage: maw send-text <target> "<text>"');
  if (text.length === 0) throw new Error('usage: maw send-text <target> "<text>" — text is required');

  const config = loadConfig();
  const sessions = await listSessions();
  const result = resolveTarget(query, config, sessions);

  if (!result) throw new Error(`could not resolve target: ${query}`);
  if (result.type === "error") {
    const hint = result.hint ? ` — ${result.hint}` : "";
    throw new Error(`${result.detail}${hint}`);
  }

  if (result.type === "peer") {
    // Cross-node — route via federation /api/pane-keys with enter:true.
    const res = await curlFetch(`${result.peerUrl}/api/pane-keys`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text, enter: true }),
      from: "auto",
    });
    if (!res.ok || !res.data?.ok) {
      const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
      throw new Error(`peer send-text failed (${result.node} ${result.peerUrl}): ${underlying}`);
    }
    console.log(`\x1b[32msent\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${truncate(text)}`);
    return;
  }

  // Local — resolve to specific pane (handles multi-pane oracle windows)
  const target = await resolveOraclePane(result.target);

  const t = new Tmux();
  await t.sendText(target, text);

  console.log(`\x1b[32msent\x1b[0m → ${target}: ${truncate(text)}`);
}

function truncate(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Parse args: <target> <text...>. The first positional (non-flag) arg is the
 * target; everything after is the text, joined with spaces. Mirrors send's
 * parser so users can swap `send` ↔ `send-text` interchangeably.
 *
 *   ["mba:sloworacle", "echo hi"]              → { target, text: "echo hi" }
 *   ["mba:sloworacle", "echo", "hi"]           → { target, text: "echo hi" }
 *   ["mba:sloworacle", "ls", "-la", "/tmp"]    → { target, text: "ls -la /tmp" }
 *   ["mba:01-newoarcle:newoarcle", "/awaken"]  → { target, text: "/awaken" }
 */
export function parseSendTextArgs(args: string[]): SendTextOpts {
  const targetIdx = args.findIndex((a) => !a.startsWith("-"));
  if (targetIdx < 0) throw new Error('usage: maw send-text <target> "<text>"');
  const target = args[targetIdx];
  const text = args.slice(targetIdx + 1).join(" ");
  if (text.length === 0) throw new Error('usage: maw send-text <target> "<text>" — text is required');
  return { target, text };
}
