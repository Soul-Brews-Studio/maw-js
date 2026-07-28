/**
 * comm-send.ts — cmdSend + resolveOraclePane + resolveMyName.
 */

import {
  listSessions, capture, sendKeys, isAgentCommand, findPeerForTarget, resolveTarget,
  curlFetch, runHook,
} from "../../sdk";
import { Tmux } from "../../core/transport/tmux";
import { AmbiguousMatchError } from "../../core/runtime/find-window";
import { detectWindowMismatch } from "../../core/routing";
import { loadConfig, cfgLimit } from "../../config";
import { logMessage, emitFeed } from "./comm-log-feed";
import { buildMessageLifecycleFeedEvent, type MessageLifecycleInput } from "../../lib/message-events";
import {
  defaultReceiverInboxWriter,
  type ReceiverInboxResult,
  type ReceiverInboxWriter,
} from "./receiver-inbox";
import {
  resolveBareHeyByLocatePath,
  type HeyLocateResolution,
} from "./hey-locate-resolution";
import { checkBusyGuard, queueForDispatch } from "../../core/agent-status-guard";
import { runPluginEventHooks } from "../../plugin/event-hooks";
import { notifyLiveInboxReceiver } from "./live-inbox-notify";
import { getPaneRoute } from "../../core/pane-routes";
// Pane-aware oracle extraction for the presence gate: unlike agent-status-guard's
// (which takes the last `:`-segment → returns "0.2" for a crew pane address like
// "13-patchwork:0.2"), this pulls the session slug → "patchwork". kobo-120: the gate
// keys presence per-pane, so a pane-addressed hey must still resolve its owning oracle.
import { extractOracleName as extractPaneOracle } from "./target-cwd";

/**
 * Resolve a `session:window` target to a specific pane running an agent
 * (claude / codex / node). Fixes the multi-pane routing bug: when an oracle
 * window has multiple panes (e.g., team-agents split beside it), tmux's
 * `send-keys -t session:window` defaults to the LAST-ACTIVE pane — which
 * becomes whichever teammate just spawned, not the oracle itself.
 *
 * Strategy: list all panes in the window, pick the lowest-index pane
 * running a claude/codex/node process. Pane 0 is conventionally the
 * oracle's main pane (created by `tmux.newWindow` during `maw wake`);
 * team-agents spawn LATER as splits and take higher indexes.
 *
 * If the target already specifies a pane (`.N` suffix) the caller knows
 * what they want — pass through untouched. If no agent pane is found,
 * return the target unchanged so the existing "no active Claude session"
 * error path surfaces correctly.
 *
 * kobo-36 (eq3-036) — channel→pane routing. When the caller supplies a
 * `route: { oracle, channel }`, we first consult the pane-route registry:
 * if that oracle declared a pane for the channel AND that pane is live in
 * the window, deliver there (e.g. board/task/federation events → the coord
 * pane, not the default `.0` main pane). No mapping / stale pane → fall
 * through to the existing lowest-agent-pane default (backward-compatible).
 */
/**
 * kobo-596 (option C): resolution can fail for reasons that have nothing to do
 * with the target being wrong (a transient tmux error, a race with the pane
 * dying/respawning) — the function's existing contract is to fall back to the
 * unchanged raw target rather than throw, so every OTHER caller keeps working
 * unmodified. But a caller that's about to print a delivery RECEIPT (cmdSend)
 * needs to know that fallback happened, because "resolved cleanly to pane X"
 * and "resolution failed, guessing pane X" are different levels of confidence
 * that the send is even reaching the RIGHT pane — collapsing them is exactly
 * the class of over-claiming receipt this card exists to close. Optional and
 * additive: omitted by the other 9 call sites, so nothing about their behavior
 * changes; a caller that wants to know passes a mutable object and reads it
 * back after the call.
 */
export interface OraclePaneResolution {
  degraded?: boolean;
  error?: string;
}

/** @internal */
export async function resolveOraclePane(
  target: string,
  deps: {
    tmuxRun?: (...args: string[]) => Promise<string>;
    isAgentCommandFn?: typeof isAgentCommand;
    getPaneRouteFn?: typeof getPaneRoute;
  } = {},
  route: { oracle?: string; channel?: string } = {},
  diagnostics?: OraclePaneResolution,
): Promise<string> {
  // Already pane-specific — honor caller's choice.
  if (/\.[0-9]+$/.test(target)) return target;

  // kobo-83 — a tmux pane-id (`%NNN`, e.g. a maw-team member's bound pane from
  // kobo-81) is ALREADY an exact send-keys target. It must NOT get a
  // `.{pane_index}` suffix: `tmux send-keys -t '%678.1'` is invalid (there is no
  // window `%678`). Only session:window targets get the lowest-agent-pane index
  // appended below; a `%`-prefixed pane id is passed straight through.
  if (target.startsWith("%")) return target;

  try {
    const run = deps.tmuxRun ?? ((...args: string[]) => new Tmux().run(...args));
    const isAgent = deps.isAgentCommandFn ?? isAgentCommand;
    const raw = await run("list-panes", "-t", target, "-F", "#{pane_index} #{pane_current_command}");
    const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return target; // single-pane window: active pane is the only pane

    const paneIndexes = new Set<number>();
    const agentIndexes: number[] = [];
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const idx = parseInt(line.slice(0, spaceIdx), 10);
      if (!Number.isFinite(idx)) continue;
      paneIndexes.add(idx);
      const cmd = line.slice(spaceIdx + 1);
      if (isAgent(cmd)) agentIndexes.push(idx);
    }

    // kobo-36 — channel→pane registry consult. Only overrides the default when a
    // mapping exists AND the declared pane is actually present (guards stale
    // layouts: a closed coord pane routes to default, not a dead index). No route
    // context / no mapping → skip straight to the existing default.
    if (route.oracle && route.channel) {
      const getRoute = deps.getPaneRouteFn ?? getPaneRoute;
      const mapped = getRoute(route.oracle, route.channel);
      if (mapped !== null && paneIndexes.has(mapped)) return `${target}.${mapped}`;
    }

    if (agentIndexes.length === 0) return target;
    return `${target}.${Math.min(...agentIndexes)}`;
  } catch (e) {
    // kobo-596 (option C): this used to fail SILENTLY — same return value
    // (the unchanged raw target) as the deliberate short-circuits above, with
    // no way for a caller to tell "resolution wasn't needed" apart from
    // "resolution was needed and failed." Surface the failure through the
    // optional diagnostics out-param instead of changing the return type
    // (every other call site of this function passes nothing and is
    // unaffected).
    if (diagnostics) {
      diagnostics.degraded = true;
      diagnostics.error = e instanceof Error ? e.message : String(e);
    }
    return target;
  }
}

/**
 * Canonicalize a send-keys target to its stable tmux pane id (`%N`) — the same form
 * the worklog stamps in `paneId` (kobo-120). Bridges the key-format gap between a
 * resolved target (`session:window.N` | `session:window` | `%N`) and per-pane presence:
 * `#{pane_id}` resolves every target form to one `%N`. A `%`-target is already an id.
 * Returns undefined when tmux can't resolve it (non-tmux / dead pane) → the caller
 * falls back to oracle-level presence.
 */
export async function paneIdOfTarget(
  target: string,
  tmuxRun?: (...args: string[]) => Promise<string>,
): Promise<string | undefined> {
  if (target.startsWith("%")) return target;
  try {
    const run = tmuxRun ?? ((...args: string[]) => new Tmux().run(...args));
    const id = (await run("display-message", "-p", "-t", target, "#{pane_id}")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the current oracle name from CLAUDE_AGENT_NAME or the attached tmux
 * pane, PLUS whether that name came from a real signal (kobo-474 T3) — the
 * bottom fallback (`config.node || "cli"`) means we genuinely don't know who
 * is sending, which callers that make an authorization decision (the
 * company-scope gate) need to treat differently from a real, just-not-a-
 * member identity: "we don't know" and "we know and it's someone else" must
 * not collapse into the same refusal (the same two-states-collapsed shape as
 * isPaneAway conflating found-back with found-nothing, kobo-471).
 */
function resolveMyNameWithConfidence(config: ReturnType<typeof loadConfig>): { name: string; resolved: boolean } {
  if (process.env.CLAUDE_AGENT_NAME) return { name: process.env.CLAUDE_AGENT_NAME, resolved: true };
  // Only trust tmux when this process is actually running inside a tmux pane.
  // Outside tmux, `tmux display-message` can still succeed by reporting the
  // server's current/last-active session, which misattributes sender envelopes.
  if (process.env.TMUX) {
    try {
      const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
      if (tmuxSession) return { name: tmuxSession.replace(/^\d+-/, ""), resolved: true };
    } catch {}
  }
  return { name: config.node || "cli", resolved: false };
}

/** Resolve the current oracle name from CLAUDE_AGENT_NAME or the attached tmux pane. */
/** @internal */
export function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  return resolveMyNameWithConfidence(config).name;
}

async function currentTmuxSessionName(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  try {
    const session = (await new Tmux().run("display-message", "-p", "#S")).trim();
    return session || undefined;
  } catch {
    return undefined;
  }
}

export interface SenderIdentity {
  /** Human-facing node name used in visible `[node:oracle]` message prefixes. */
  node: string;
  /** Human-facing oracle/session name used in visible `[node:oracle]` message prefixes. */
  oracle: string;
  /** `node:oracle`, the form operators type with `--from` / `MAW_SENDER`. */
  display: string;
  /** `oracle:node`, the existing v3 from-signing wire form. */
  wireFrom: string | "auto";
  /** Back-compat name for message log rows. */
  senderName: string;
  source: "auto" | "flag" | "env";
  /**
   * kobo-474 T3 — true when `senderName` came from a real signal (explicit
   * --from/MAW_SENDER, CLAUDE_AGENT_NAME, or a real tmux session). False only
   * for the "auto" path's bottom fallback (`config.node || "cli"`), where we
   * genuinely do not know who is sending — distinct from "we know, and they
   * aren't a member," which is the ordinary cross-company refusal.
   */
  identityResolved: boolean;
}

const SENDER_PART_RE = /^[A-Za-z0-9_.-]+$/;

/** @internal exported for tests. Parse user-facing `<node>:<oracle>` sender overrides. */
export function parseSenderOverride(raw: string | undefined | null): Pick<SenderIdentity, "node" | "oracle" | "display" | "wireFrom" | "senderName"> | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [node, oracle] = parts.map((part) => part.trim());
  if (!node || !oracle) return null;
  if (!SENDER_PART_RE.test(node) || !SENDER_PART_RE.test(oracle)) return null;
  return {
    node,
    oracle,
    display: `${node}:${oracle}`,
    // Existing from-signing contract is `<oracle>:<node>` even though human
    // message attribution is `[node:oracle]`. Keep both explicit.
    wireFrom: `${oracle}:${node}`,
    senderName: oracle,
  };
}

/** @internal exported for tests. */
export function hasSshRelayEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CLIENT || env.SSH_CONNECTION || env.SSH_TTY);
}

/**
 * kobo-335: the AUTHENTICATED local agent identity — CLAUDE_AGENT_NAME (spawn-set) or
 * the tmux session name (pane identity), whichever is present. Returns null when
 * NEITHER exists (a bare CLI / a person, not an oracle). Distinct from resolveMyName,
 * which falls back to config.node: here "no agent identity" must stay null so the
 * actor-auth layer can tell a real agent from a person-at-the-CLI. This is the trust
 * root a --from/MAW_SENDER claim is bound to.
 */
export function resolveAgentSelf(env: NodeJS.ProcessEnv = process.env): string | null {
  const agent = env.CLAUDE_AGENT_NAME?.trim();
  if (agent) return agent;
  if (env.TMUX) {
    try {
      const session = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
      if (session) return session.replace(/^\d+-/, "");
    } catch { /* not in a live tmux pane */ }
  }
  return null;
}

/**
 * kobo-335: authenticate the actor for a task WRITE. Binds the claimed identity to the
 * local agent self (resolveAgentSelf). Rules:
 *   • no --from/MAW_SENDER claim → the authenticated self (or "human" at a bare CLI).
 *   • claim's oracle-part == self → ALLOW (redundant but legit).
 *   • claim != self → REFUSE (can't act as another oracle).
 *   • claim + NO self → REFUSE (a bare CLI can't assert an oracle actor).
 * REFUSE throws — the task verb's top-level catch turns it into {ok:false, error}.
 * This rejects the OBSERVED forge (`task sign --from mba:tony`). It is NOT unforgeable:
 * a node-local shell can still set CLAUDE_AGENT_NAME or rename its tmux session to
 * change its own self (the same node-local ceiling); an airtight actor identity needs
 * out-of-band crypto (future). Lives in the task-actor layer only — `maw hey`'s
 * resolveSenderIdentity (cross-node relay) is untouched.
 */
export function authenticateActor(from?: string, env: NodeJS.ProcessEnv = process.env): string {
  const self = resolveAgentSelf(env);
  const claimRaw = (from?.trim() || env.MAW_SENDER?.trim()) || null;
  if (!claimRaw) return self ?? "human";
  const parsed = parseSenderOverride(claimRaw);
  if (!parsed) throw new Error(`invalid actor '${claimRaw}' (expected <node>:<oracle>)`);
  if (!self) {
    throw new Error(`refusing actor '${claimRaw}': no authenticated identity (no CLAUDE_AGENT_NAME, no tmux) — a task write can't assert an actor from a bare CLI (kobo-335 actor-auth).`);
  }
  if (parsed.senderName !== self) {
    throw new Error(`refusing actor '${claimRaw}': authenticated identity is "${self}", can't act as "${parsed.senderName}" (kobo-335 actor-auth). Drop the override or use <node>:${self}.`);
  }
  return self;
}

/**
 * Resolve the visible + signed sender for `maw hey`.
 *
 * Precedence for #1889:
 *   1. CLI `--from <node:oracle>`
 *   2. `MAW_SENDER=<node:oracle>` for SSH relay wrappers
 *   3. Auto local identity, but only when not running under SSH relay env
 */
export function resolveSenderIdentity(
  config: ReturnType<typeof loadConfig>,
  opts: Pick<CmdSendOptions, "from"> = {},
  env: NodeJS.ProcessEnv = process.env,
): SenderIdentity {
  const explicit = opts.from?.trim();
  const envSender = env.MAW_SENDER?.trim();
  const raw = explicit || envSender;
  if (raw) {
    const parsed = parseSenderOverride(raw);
    if (!parsed) throw new Error(`invalid sender '${raw}' (expected <node>:<oracle>)`);
    return { ...parsed, source: explicit ? "flag" : "env", identityResolved: true };
  }

  if (hasSshRelayEnv(env)) {
    throw new Error("refusing to stamp SSH-relayed maw hey as the local oracle; set --from <node:oracle> or MAW_SENDER=<node:oracle>");
  }

  const { name: senderName, resolved: identityResolved } = resolveMyNameWithConfidence(config);
  const node = config.node || "local";
  return {
    node,
    oracle: senderName,
    display: `${node}:${senderName}`,
    wireFrom: "auto",
    senderName,
    source: "auto",
    identityResolved,
  };
}

function rejectSenderIdentity(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31merror\x1b[0m: ${message}`);
  console.error("\x1b[33mhint\x1b[0m:  use `maw hey --from alpha:volt-oracle <target> <message>` or set `MAW_SENDER=alpha:volt-oracle`");
  process.exit(1);
}

/**
 * kobo-474 — fixed root cause. Used to special-case `source === "auto"` and
 * substitute the NODE's static `config.oracle` (a single, shared, per-file
 * value — no per-pane override exists) instead of the already-correctly-
 * resolved `senderIdentity.senderName`. That was a NODE-identity answer
 * plugged into a PANE-identity question: `resolveSenderIdentity`'s auto path
 * (comm-send.ts:300) already calls `resolveMyNameWithConfidence`, which
 * reads CLAUDE_AGENT_NAME / the real tmux session for THIS process — always
 * the better answer, explicit sender or not. Threat model + the "obvious
 * one-line alternative fix is worse" finding are in the PR body (kobo-474).
 */
function aclSenderOracle(_config: ReturnType<typeof loadConfig>, senderIdentity: SenderIdentity): string {
  return senderIdentity.senderName;
}

/**
 * Visible internal federation attribution.
 *
 * Transport-level signing (`curlFetch(..., { from: "auto" })`) authenticates
 * cross-node HTTP calls, but same-node tmux delivery has no protocol envelope.
 * Internal Oracle convention is a body-level `[node:oracle]` prefix for human
 * chat. Preserve executable slash/$ commands and already-signed messages so
 * `maw hey target /skill` keeps invoking the command instead of turning into
 * prose.
 *
 * @internal exported for regression tests.
 */
export function formatSignedMessage(
  message: string,
  config: Pick<ReturnType<typeof loadConfig>, "node">,
  senderName: string,
): string {
  const leading = message.match(/^\s*/)?.[0] ?? "";
  const body = message.slice(leading.length);
  if (!body) return message;
  if (body.startsWith("/") || body.startsWith("$")) return message;
  if (/^\[[^\]\s:]+:[^\]]+\](?:\s|$)/.test(body)) return message;

  const node = config.node || "local";
  return `${leading}[${node}:${senderName}] ${body}`;
}

function emitMessageFeed(input: MessageLifecycleInput, port: number) {
  const event = buildMessageLifecycleFeedEvent(input);
  emitFeed(event.event, event.oracle, event.host, event.message, port, event.data);
}

/**
 * Check if a pane is idle — i.e., no user input is in progress on the prompt line.
 *
 * #405 originally inspected only the literal last line. That is a NO-OP on a
 * Claude Code TUI pane (#eq3-003b): its bottom is a divider + footer
 * (`⏵⏵ … · ← for agents   N tokens`), so the `❯ <input>` row sits ~4 lines
 * ABOVE the last line — the old check always saw the footer, never matched a
 * marker, and returned idle:true → the guard overtyped every Claude Code pane.
 *
 * Two-pass detection over the captured tail:
 *   Pass 1 (TUI / modern prompt): scan bottom-up for an input row that STARTS
 *     (after optional whitespace) with a prompt marker `❯ > › »`. Claude Code's
 *     input box is always the bottom-most such row — agent output (incl.
 *     markdown `>` quotes) and the footer/divider sit elsewhere — so the lowest
 *     start-anchored marker row is the real input line. `❯` + only-whitespace =
 *     empty (idle); `❯ text` = the operator is typing (not idle).
 *   Pass 2 (classic shell): the marker sits MID-line (`user@host:~$ cmd`), so
 *     fall back to the original last-non-empty-line heuristic.
 *
 * Capture failure / no prompt visible (agent rendering) → idle:true, so a flaky
 * pane never blocks delivery permanently.
 */
/**
 * kobo-503 — drop GHOST text (dim / cursor-block) from one captured row.
 *
 * Replaces the old regex span-match (`ESC[2m … ESC[0m`), which required the dim
 * opener to be IMMEDIATELY followed by plain text: Claude Code emits
 * `ESC[2m ESC[39m Press up…` and `ESC[7m ESC[39m P ESC[0;2m ress…` for the very
 * same hint row, so an interleaved code broke the match and the ghost text
 * survived → read as live operator input → every pane holding a queued message
 * was declared "typing" and locked out of delivery (a self-sustaining deadlock:
 * the queue draws the hint, the hint blocks the drain).
 *
 * Attribute STATE, not span shape: walk the row, track SGR dim (2 / off 22) and
 * reverse (7 / off 27, the cursor block that sits on the first ghost char), and
 * keep only characters rendered plain. Immune to how many codes interleave and
 * to the hint's wording. `0`/empty params reset both — and `ESC[0;2m` is
 * left-to-right, so it correctly lands dim-ON.
 */
export function stripGhostText(line: string): string {
  let out = "";
  let dim = false;
  let reverse = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      const ctrl = line.slice(i + 2).search(/[A-Za-z]/);
      const stop = ctrl === -1 ? -1 : i + 2 + ctrl;
      if (end !== -1 && stop === end) {
        const ps = line.slice(i + 2, end).split(";");
        for (let k = 0; k < ps.length; k++) {
          const n = ps[k] === "" ? 0 : Number(ps[k]);
          // %5's request-change: 38/48 (extended fg/bg) OWN the params that
          // follow them — `38;5;2` is palette index 2 and `38;2;r;g;b` is
          // truecolour. Read left-to-right without consuming those, and a
          // colour's literal `2` reads as "dim" and swallows the whole rest of
          // the row, including text a human is actually typing. That is worse
          // than kobo-503 itself (the guard exists to stop overtyping), and the
          // old regex did NOT have it. Skip the sub-params so only a standalone
          // 2 is dim.
          if (n === 38 || n === 48 || n === 58) { k += ps[k + 1] === "5" ? 2 : ps[k + 1] === "2" ? 4 : 0; continue; }
          if (n === 0) { dim = false; reverse = false; }
          else if (n === 2) dim = true;
          else if (n === 22) dim = false;
          // kobo-508: this treats ANY reverse span as ghost and deletes it whole —
          // including, hypothetically, a permission-menu selected row, IF Claude
          // Code ever draws it in reverse instead of today's colour (38;5;153).
          // That would make checkPaneIdle alone read the pane as idle while a
          // confirm dialog sits open. It's safe today only because of that colour
          // choice, not because this function knows what a menu is — see
          // isSafeToInject below, which is the actual second gate that closes
          // this regardless of which way the TUI happens to render it.
          else if (n === 7) reverse = true;
          else if (n === 27) reverse = false;
        }
        i = end;
        continue;
      }
    }
    if (!dim && !reverse) out += line[i];
  }
  return out;
}

/**
 * kobo-508 — the single declared source for how many rows the send-gate
 * captures. checkPaneIdle and detectPermissionMenu both read the input box
 * above its divider+footer and MUST request the same depth: widen this once
 * to catch a taller menu and both see it. If the two call sites ever drift
 * apart, the two gates read a different depth of the same pane — a silent
 * behavioral hole, which is exactly why check-pane-idle-real-captures.test.ts
 * pins each call site against this constant and goes red on that drift. NOT
 * covered: a call site re-hardcoding a literal that happens to equal this
 * value — that class of regression is out of scope for that test.
 */
export const SEND_GATE_SNAPSHOT_LINES = 12;

export async function checkPaneIdle(
  target: string,
  host?: string,
  deps: { captureFn?: typeof capture } = {},
): Promise<{ idle: boolean; lastInput: string }> {
  const capturePane = deps.captureFn ?? capture;
  try {
    // Capture enough rows to see the TUI input box above its divider+footer.
    const content = await capturePane(target, SEND_GATE_SNAPSHOT_LINES, host);
    const lines = content
      .split("\n")
      .map(l => stripGhostText(l)
        // Strip OSC sequences (e.g. OSC 8 hyperlinks the footer wraps PR links
        // in: ESC ] 8 ; … ST). ST terminator is `ESC \`, BEL is the legacy form.
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, "")
        .replace(/\r/g, ""));

    // Pass 1 — bottom-up scan for a start-anchored prompt marker (Claude Code
    // `❯`, modern shells `❯`/`›`, basic `>`). Restricted to these markers so
    // line-leading `#`/`$`/`%` in agent output (markdown headings, `$ ` code
    // snippets) can't false-trigger.
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s*[>❯›»]\s?(.*)$/);
      if (!m) continue;
      const typed = (m[1] ?? "").trim();
      return typed.length > 0
        ? { idle: false, lastInput: typed }
        : { idle: true, lastInput: "" };
    }

    // Pass 2 — classic shell prompt, marker mid-line on the last non-empty row.
    const lastLine = lines.filter(l => l.trim()).at(-1) ?? "";
    if (/[#$%>❯»›]\s*$/.test(lastLine)) return { idle: true, lastInput: "" };
    const shellTyping = lastLine.match(/[#$%>❯»›]\s+(\S.*)$/);
    if (shellTyping) return { idle: false, lastInput: shellTyping[1] };

    // No prompt visible (command running or agent output) → treat as idle.
    return { idle: true, lastInput: "" };
  } catch {
    return { idle: true, lastInput: "" };
  }
}

/**
 * eq3-004 — detect a Claude Code permission/confirm MODAL on a pane.
 *
 * Deliberately SEPARATE from checkPaneIdle's typing detection (the #38 dim-strip
 * + Pass1/Pass2 logic, which must stay untouched). A permission menu's selected
 * row (`❯ 1. Yes`) already reads as "typing" to Pass 1, so it DEFERS correctly —
 * but the sender is never told why, and a menu never self-clears the way mid-
 * typed operator input does. This additive layer recognizes the modal so the
 * dispatch engine can notify the sender immediately instead of waiting out the
 * stall threshold.
 *
 * Signature (stable across confirm prompts — verified on real captures,
 * kang / demo-web-qa): a numbered selection cursor `❯ <n>.` together with the
 * modal-only footer `Esc to cancel`. BOTH are required so an operator literally
 * typing "1. ..." on the prompt line — with no modal footer — can't false-trigger.
 * We strip only ANSI codes here (not whole dim spans): the footer text must
 * survive the strip so it can be matched.
 */
export async function detectPermissionMenu(
  target: string,
  host?: string,
  deps: { captureFn?: typeof capture } = {},
): Promise<boolean> {
  const capturePane = deps.captureFn ?? capture;
  try {
    const text = (await capturePane(target, SEND_GATE_SNAPSHOT_LINES, host))
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, "")
      .replace(/\r/g, "");
    const hasModalFooter = /Esc to cancel/i.test(text);
    const hasNumberedCursor = /❯\s*\d+\./.test(text);
    return hasModalFooter && hasNumberedCursor;
  } catch {
    return false;
  }
}

/**
 * kobo-508 — answers the question this card exists to force an answer to:
 * should detectPermissionMenu also gate SENDING, not just notify? Yes. On the
 * two paths this fix touches — cmdSend's direct injection below, and the
 * DispatchEngine sweep via server.ts's sweepPaneIdleCheck — checkPaneIdle used
 * to be the only send-gate (dispatch-engine's own detectMenu call is
 * notify-only — see checkStall). checkPaneIdle's ghost-strip deletes a whole
 * reverse-video span; detectPermissionMenu strips only ANSI codes and never a
 * whole attribute span, so its numbered-cursor + modal-footer signal survives a
 * shape that would fool checkPaneIdle alone (a menu row drawn in reverse
 * instead of colour — not observed yet, but no longer able to slip through
 * silently on these two paths if it happens). This does NOT claim every send
 * path in the codebase is gated this way — see kobo-508's card note for the
 * enumeration of paths that are and aren't. Callers should use this instead of
 * checkPaneIdle directly when the result gates an actual injection.
 */
export async function isSafeToInject(
  target: string,
  host?: string,
  deps: { captureFn?: typeof capture } = {},
): Promise<{ safe: boolean; reason?: "typing" | "menu"; lastInput: string }> {
  // %5's request-change: checkPaneIdle + detectPermissionMenu each captured
  // independently doubled the real tmux round-trips per send (1 -> 2) — on a
  // shared tmux server that has already hung once tonight (kobo-477) with an
  // open latency card (kobo-408), that is not a cost to pay silently as a
  // side effect of wiring two functions together. Capture once, feed the SAME
  // snapshot to both — one round-trip, same behavior either function had on
  // its own.
  let captured: Promise<string> | undefined;
  const captureOnce: typeof capture = (...args) => (captured ??= (deps.captureFn ?? capture)(...args));
  const onceDeps = { captureFn: captureOnce };

  const pane = await checkPaneIdle(target, host, onceDeps);
  if (!pane.idle) return { safe: false, reason: "typing", lastInput: pane.lastInput };
  const menuOpen = await detectPermissionMenu(target, host, onceDeps);
  if (menuOpen) return { safe: false, reason: "menu", lastInput: pane.lastInput };
  return { safe: true, lastInput: pane.lastInput };
}

/**
 * eq3-005 — federation-vs-local guard. When an explicit `node:name` target was
 * routed to a peer but `name` ALSO has a live local session, surface a hint that
 * a direct local path exists. We deliberately do NOT auto-redirect: addressing a
 * specific node may be intentional (a different node's like-named oracle). This
 * just makes the choice visible. Returns null when no hint applies.
 *
 * @internal exported for tests only.
 */
export function peerLocalOverrideHint(query: string, bareName: string, localIsLive: boolean): string | null {
  if (!query.includes(":") || !localIsLive) return null;
  const node = query.slice(0, query.indexOf(":"));
  return `'${bareName}' is live locally — use the bare name (\`maw hey ${bareName}\`) to inject directly; you addressed the '${node}' node explicitly so this was sent cross-node`;
}

/**
 * #1572 — bare oracle names are allowed only as a same-node convenience.
 *
 * `maw hey <oracle-window> "..."` now resolves locally first. If there is no
 * local window match, we still refuse to fall through to peer discovery or the
 * agents map: cross-node delivery must keep an explicit `<node>:` prefix.
 *
 * @internal — exported for tests only (test/comm-send-deprecation-759.test.ts).
 *   The production caller is `cmdSend` in this same file. No other module
 *   imports this symbol.
 */
export function formatBareNameError(query: string): string {
  const RED = "\x1b[31m"; // error marker
  const C = "\x1b[36m";   // cyan — for canonical suggestion lines
  const D = "\x1b[90m";   // dim — for explanatory tail
  const R = "\x1b[0m";
  return [
    `${RED}error${R}: bare target '${query}' not found locally`,
    ``,
    `  same-node targets:`,
    `    ${C}maw hey local:${query} "..."${R}`,
    `    ${D}or copy a TARGET from \`maw ls -v\`${R}`,
    ``,
    `  cross-node targets:`,
    `    ${C}maw hey <node>:${query} "..."${R}`,
    `    ${C}maw hey <node>:<session>:<window> "..."${R}`,
    ``,
    `  ${D}bare names are local-only; run \`maw locate ${query}\` to enumerate federation candidates${R}`,
  ].join("\n");
}

/** @internal exported for tests only. */
export function formatBareNameAmbiguousError(query: string, candidates: string[]): string {
  const RED = "\x1b[31m";
  const C = "\x1b[36m";
  const R = "\x1b[0m";
  return [
    `${RED}error${R}: bare target '${query}' is ambiguous — matches ${candidates.length} local windows:`,
    ...candidates.map((candidate) => `  ${C}${candidate}${R}`),
    ``,
    `Use one full TARGET from \`maw ls -v\`, for example:`,
    `  ${C}maw hey ${candidates[0] ?? `local:${query}`} "..."${R}`,
  ].join("\n");
}

function isBareLocalHeyTarget(query: string): boolean {
  return query.length > 0 && !query.includes(":") && !query.includes("/");
}

function isTmuxSessionIdTarget(target: string): boolean {
  return /^\d+-[A-Za-z0-9_.-]+$/.test(target.trim());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function teamWorkspaceWindowCandidates(member: string): string[] {
  const raw = member.trim();
  const stripped = raw.replace(/-oracle$/i, "");
  return uniqueStrings([
    raw,
    stripped,
    stripped ? `${stripped}-oracle` : "",
  ]);
}

/**
 * Resolve a persistent team member to its workspace window when
 * `maw team bring <team>` already opened that oracle inside the team session.
 *
 * This is intentionally scoped to team fan-out only: ordinary `maw hey
 * <oracle>` keeps its local/home-session behavior, while `maw hey team:<team>`
 * now targets the workspace windows that `maw team bring` created (#1742).
 *
 * @internal exported for regression tests.
 */
export function resolveTeamWorkspaceMemberTarget(
  teamName: string,
  member: string,
  sessions: Awaited<ReturnType<typeof listSessions>>,
): string | null {
  const workspace = sessions.find((s) => s.name === teamName);
  if (!workspace) return null;

  const wanted = new Set(teamWorkspaceWindowCandidates(member).map((name) => name.toLowerCase()));
  const win = workspace.windows.find((w) => wanted.has(w.name.toLowerCase()));
  return win ? `${workspace.name}:${win.name}` : null;
}

function formatAmbiguousCandidates(query: string, candidates: string[]): string[] {
  if (candidates.length) return candidates;
  return [query];
}

function rejectBareMiss(query: string): never {
  console.error(formatBareNameError(query));
  process.exit(1);
}

function rejectBareAmbiguous(query: string, candidates: string[]): never {
  console.error(formatBareNameAmbiguousError(query, formatAmbiguousCandidates(query, candidates)));
  process.exit(1);
}

function normalizeBareLocalResult(
  query: string,
  result: ReturnType<typeof resolveTarget>,
  config: ReturnType<typeof loadConfig>,
): ReturnType<typeof resolveTarget> | null {
  if (!result) return null;
  if (result.type === "local" || result.type === "self-node") return result;
  // A bare query may discover a remote peer via config.agents/manifest. Do not
  // use that implicit remote route: #1572 makes bare names local-only so
  // operators must spell cross-node delivery with `<node>:`. Peer aliases are
  // the narrow exception: `maw peers add world-mawjs ...` should make
  // `maw hey world-mawjs ...` usable (#1940).
  if (result.type === "peer" && isConfiguredPeerAlias(query, config)) return result;
  return null;
}

function isConfiguredPeerAlias(query: string, config: ReturnType<typeof loadConfig>): boolean {
  if (!isBareLocalHeyTarget(query)) return false;
  const peer = (config.namedPeers ?? []).find((p: any) => p?.name === query);
  if (peer && (typeof (peer as any).node === "string" || typeof (peer as any).identity?.node === "string")) return true;
  try {
    const { loadPeers } = require("../../lib/peers/store");
    const stored = loadPeers().peers?.[query];
    return Boolean(stored && (typeof stored.node === "string" || typeof stored.identity?.node === "string"));
  } catch {
    return false;
  }
}

async function resolveBareLocalTarget(
  query: string,
  config: ReturnType<typeof loadConfig>,
  sessions: Awaited<ReturnType<typeof listSessions>>,
  currentSession?: string,
): Promise<{ result: ReturnType<typeof resolveTarget> | null; locate: HeyLocateResolution | null }> {
  if (!isBareLocalHeyTarget(query)) return { result: null, locate: null };

  try {
    const localResult = normalizeBareLocalResult(query, resolveTarget(query, config, sessions, currentSession), config);
    if (localResult) return { result: localResult, locate: null };
  } catch (e) {
    if (e instanceof AmbiguousMatchError) {
      rejectBareAmbiguous(query, e.candidates);
    }
    throw e;
  }

  const locate = await resolveBareHeyByLocatePath(query, config, sessions);
  if (locate.result) return { result: locate.result, locate };
  if (locate.repoPath) return { result: null, locate };

  // kobo-81 — fallback: a live maw-team member's bound tmux pane is a valid local
  // target even though the worker isn't a federation oracle (no repo → the locate
  // path above can't find it). Placed LAST so no existing oracle/locate target is
  // affected — only names that would otherwise miss (the "bare = local-only fail"
  // symptom) now resolve to the worker's real pane. Dynamic import keeps comm-send
  // free of the fs/path/os top-level import (mock.module link-time safety).
  try {
    const { resolveTeamMemberPane } = await import("./team-member-pane");
    const memberPane = resolveTeamMemberPane(query);
    if (memberPane) return { result: { type: "local", target: memberPane }, locate: null };
  } catch { /* fall through to the miss error */ }

  rejectBareMiss(query);
}

/**
 * Caller-supplied options for `cmdSend`. Backward compatible — the field
 * is optional and the legacy 3-arg signature still works (positional
 * `force` second-to-last).
 *
 * - `approve` (#842 Sub-C): bypass the ACL queue gate for THIS send.
 *   Operator opted in explicitly via `maw hey --approve`. Equivalent to
 *   the human-approval path that drives `maw inbox approve <id>`.
 * - `trust` (#842 Sub-C): paired with `approve` — also append the
 *   sender↔target pair to the on-disk trust list so subsequent sends in
 *   either direction skip the gate without operator intervention.
 * - `inboxOnly` (#1860): persist to the receiver inbox without injecting
 *   into the live pane. Normal sends now always inject by default.
 * - `from` (#1889): explicit user-facing sender override, `<node>:<oracle>`,
 *   used for SSH relays where auto local identity would impersonate the host.
 * - `currentSession` (#2134): caller-known tmux session used to scope bare
 *   target resolution before cross-session matching.
 */
export interface CmdSendOptions {
  approve?: boolean;
  trust?: boolean;
  inboxOnly?: boolean;
  from?: string;
  currentSession?: string;
  receiverInbox?: ReceiverInboxWriter | false;
  /**
   * #1907 — opt out of post-send verify-submit retry. Default behaviour
   * (when this is undefined or false) is to peek the target pane after
   * send-keys, detect when the implicit Enter was eaten by Claude TUI
   * scroll-mode / popup, and send an explicit C-m. Set true for tight
   * loops where the +800ms verify cost is unacceptable.
   */
  noVerifySubmit?: boolean;
  /**
   * kobo-36 (eq3-036) — logical channel for this send (e.g. "task-events").
   * When set, local pane resolution consults the target oracle's pane-route
   * registry so a role-specific pane (coord vs worker) receives the message
   * instead of the default main pane. Unset → default pane behavior.
   */
  channel?: string;
  /**
   * kobo-306 — when the target pane is AWAY, queue the message for auto-delivery
   * on return (via the dispatch bridge) instead of parking it to a silent inbox.
   * Scoped opt-in for the room nudge (route.ts roomNudgeArgs): a brainstorm turn
   * must reach an away lead the moment they /seat back, not sit unseen in the
   * inbox (kobo-305). Default (unset) preserves the deliberate away≠busy park —
   * a plain hey to an away oracle is NOT auto-delivered (could overtype a
   * /clear'ing pane, kobo-288). Only the room channel opts in.
   */
  queueOnAway?: boolean;
  /**
   * kobo-368 — compact-ack sweep. Default (unset/false): print a compact ack
   * (target + char-count), never echo the full sent message back to the
   * sender's own terminal — every `maw hey`/`send`/`notify` call otherwise
   * paid for its own message twice (sent once, echoed back a second time).
   * true: reproduce the PRE-368 behavior byte-for-byte (full message text +
   * captured tail-line) — regression-pinned, nothing lost (Principle 1).
   */
  verbose?: boolean;
}

/** @internal — exported for test injection only. */
export interface VerifySubmitOpts {
  delayMs?: number;
  maxRetries?: number;
  captureFn?: (target: string, lines: number, host?: string) => Promise<string>;
  sendKeysFn?: (target: string, text: string, host?: string) => Promise<void>;
  sleepFn?: (ms: number) => Promise<void>;
  host?: string;
}

export interface VerifySubmitResult {
  delivered: boolean;
  retriesNeeded: number;
  warning?: string;
}

/**
 * #1907 — verify that the implicit Enter from `tmux send-keys` actually
 * submitted, by peeking the target pane and re-sending Enter if the message
 * text still sits in the input area. Up to 2 Enter retries before giving up.
 *
 * Heuristic: capture last 10 lines, search the last 3 for the first 80 chars
 * of the message. The input line is the bottommost; chat history scrolls up
 * and out of the 3-line tail under normal Claude TUI rendering. False-positive
 * cost is a benign extra Enter (no-op in most TUIs).
 */
export async function verifySubmitDelivered(
  target: string,
  message: string,
  opts: VerifySubmitOpts = {},
): Promise<VerifySubmitResult> {
  const envDelay = parseInt(process.env.MAW_HEY_VERIFY_DELAY_MS ?? "", 10);
  const delayMs = opts.delayMs ?? (Number.isFinite(envDelay) && envDelay > 0 ? envDelay : 800);
  const maxRetries = opts.maxRetries ?? 2;
  const captureFn = opts.captureFn ?? capture;
  const sendKeysFn = opts.sendKeysFn ?? sendKeys;
  const sleepFn = opts.sleepFn ?? ((ms: number) => Bun.sleep(ms));
  const host = opts.host;

  const needle = message.slice(0, 80).trim();
  if (!needle) return { delivered: true, retriesNeeded: 0 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await sleepFn(delayMs);
    let content: string;
    try {
      content = await captureFn(target, 10, host);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      return { delivered: false, retriesNeeded: attempt,
        warning: `submit unverified — capture-pane failed: ${reason}` };
    }
    const tail = content.split("\n").slice(-3).join("\n");
    if (!tail.includes(needle)) {
      return { delivered: true, retriesNeeded: attempt };
    }
    if (attempt < maxRetries) {
      try {
        // "\r" → Enter via ssh.ts SPECIAL_KEYS map; goes through exitModeIfNeeded.
        await sendKeysFn(target, "\r", host);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        return { delivered: false, retriesNeeded: attempt + 1,
          warning: `submit unverified — Enter retry failed: ${reason}` };
      }
    }
  }
  return { delivered: false, retriesNeeded: maxRetries,
    warning: `submit unverified after ${maxRetries} Enter retries` };
}

/**
 * eq3-003 — `maw flush [oracle]`. Drain an oracle's deferred-message queue on
 * the local maw server, which re-checks pane-clean before each inject. Default
 * oracle is self (resolved from CLAUDE_AGENT_NAME / the attached tmux pane).
 *
 * This is what the Claude Code hook (UserPromptSubmit / Stop) calls to deliver
 * queued messages the instant the operator's input line clears — the periodic
 * server sweep is the hook-independent fallback. Idempotent: a clean drained
 * queue is a no-op; a dirty pane delivers nothing and leaves the queue intact.
 */
export async function cmdFlush(oracleArg?: string): Promise<void> {
  const config = loadConfig();
  const oracle = oracleArg?.trim() || resolveMyName(config);
  const bare = oracle.split(":").at(-1)?.replace(/-oracle$/i, "").trim() || oracle;
  const port = config.port || 3456;
  try {
    const res = await fetch(`http://localhost:${port}/api/flush`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oracle: bare }),
    });
    const data = await res.json().catch(() => ({})) as {
      ok?: boolean; delivered?: number; deferred?: number; remaining?: number; error?: string;
    };
    if (!res.ok || !data.ok) {
      console.error(`\x1b[31merror\x1b[0m: flush failed for ${bare}: ${data.error ?? `HTTP ${res.status}`}`);
      process.exit(1);
    }
    console.log(`\x1b[32mflushed\x1b[0m ${bare}: ${data.delivered ?? 0} delivered, ${data.deferred ?? 0} deferred, ${data.remaining ?? 0} remaining`);
  } catch (e) {
    console.error(`\x1b[31merror\x1b[0m: cannot reach maw server on :${port} — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function cmdSend(
  query: string,
  message: string,
  force = false,
  opts: CmdSendOptions = {},
) {
  const config = loadConfig();
  let senderIdentity: SenderIdentity;
  try {
    senderIdentity = resolveSenderIdentity(config, opts);
  } catch (error) {
    rejectSenderIdentity(error);
  }

  // --- Team fan-out routing: maw hey team:<team-name> <msg> (#627) ---
  if (query.startsWith("team:")) {
    const teamName = query.slice("team:".length);
    if (!teamName) {
      console.error("usage: maw hey team:<team-name> <message>");
      process.exit(1);
    }
    const { getOracleMembers, loadOracleRegistry } = await import("../../lib/oracle-members");
    const senderOracle = senderIdentity.senderName;
    const members = getOracleMembers(teamName, senderOracle);
    if (members.length === 0) {
      const registry = loadOracleRegistry(teamName);
      if (registry && registry.members.length > 0) {
        console.error(`\x1b[31m✗\x1b[0m team '${teamName}' has only the sender ('${senderOracle}') as a member`);
        console.error(`\x1b[33mhint\x1b[0m: invite more members or set excludeSelf:false in the registry`);
      } else {
        console.error(`\x1b[31m✗\x1b[0m no oracle members in team '${teamName}'`);
        console.error(`\x1b[33mhint\x1b[0m: add members with: maw team oracle-invite <oracle-name> --team ${teamName}`);
      }
      process.exit(1);
    }
    const totalMembers = (loadOracleRegistry(teamName)?.members.length ?? members.length);
    if (totalMembers > members.length) {
      console.log(`\x1b[36m⚡\x1b[0m fan-out to ${members.length} oracle(s) in team '${teamName}' \x1b[90m(self '${senderOracle}' excluded)\x1b[0m:`);
    } else {
      console.log(`\x1b[36m⚡\x1b[0m fan-out to ${members.length} oracle(s) in team '${teamName}':`);
    }
    let delivered = 0;
    let failed = 0;
    const sessions = await listSessions();

    // Fan-out sends individually. cmdSend calls process.exit on failure,
    // so we override it temporarily to keep iterating (#627 resilient fan-out).
    // The override must still abort the nested cmdSend call; returning from
    // process.exit lets fail paths continue through code that assumes `never`,
    // which can leave subprocess/async work alive under isolated shard load.
    class TeamMemberExitError extends Error {
      readonly code: number;
      constructor(code?: number) {
        super("team member send exited");
        this.name = "TeamMemberExitError";
        this.code = code ?? 0;
      }
    }
    const origExit = process.exit;
    for (const member of members) {
      const routedMember = resolveTeamWorkspaceMemberTarget(teamName, member, sessions) ?? member;
      process.exit = ((code?: number) => {
        throw new TeamMemberExitError(code);
      }) as never;
      try {
        await cmdSend(routedMember, message, force, opts);
        delivered++;
      } catch (e: any) {
        failed++;
        if (!(e instanceof TeamMemberExitError)) {
          console.error(`  \x1b[31m✗\x1b[0m ${routedMember}: ${e?.message || "failed"}`);
        }
      } finally {
        process.exit = origExit;
      }
    }

    console.log(`\x1b[36m⚡\x1b[0m fan-out complete: ${delivered} delivered, ${failed} failed`);
    return;
  }

  // --- Plugin routing: maw hey plugin:<name> <msg> ---
  if (query.startsWith("plugin:")) {
    const name = query.slice("plugin:".length);
    const { discoverPackages, invokePlugin } = await import("../../plugin/registry");
    const plugin = discoverPackages().find(p => p.manifest.name === name);
    if (!plugin) { console.error(`plugin not found: ${name}`); process.exit(1); }
    const pluginFrom = senderIdentity.source === "auto" ? (config.node ?? "local") : senderIdentity.display;
    const result = await invokePlugin(plugin, { source: "peer", args: { message, from: pluginFrom } });
    if (result.ok) { console.log(result.output ?? "(no output)"); return; }
    console.error(`plugin error: ${result.error}`);
    process.exit(1);
  }

  let sessions = await listSessions();
  const currentSession = opts.currentSession?.trim() || await currentTmuxSessionName();
  let bareResolution = await resolveBareLocalTarget(query, config, sessions, currentSession);

  // --- #736 Phase 1.2 + #791: auto-wake fleet-known targets (parity with maw view) ---
  // Mirrors view/impl.ts:107 — if the user's hey target is fleet-known but
  // no live session exists, silently wake it before sending. No y/N prompt:
  // fleet membership is sufficient signal that this isn't a typo.
  //
  // Local scope (no node prefix or matches config.node): wake locally via cmdWake.
  // Cross-node short form (<peer>:<agent>, no third colon): wake remotely via
  // peer's /api/wake (#791 — Option B from the design RFC). Canonical form
  // (<peer>:<session>:<window>) skips wake because the session is explicitly
  // named — wake on a session id would no-op or misroute.
  //
  // #835 — decision routed through shouldAutoWake(); the wake CALL itself
  // (cmdWake, /api/wake POST) is unchanged.
  {
    const parts = query.split(":");
    const targetNode = parts.length >= 2 ? parts[0] : null;
    const bareAgent = parts.length >= 2 ? parts[1] : query;
    const isExplicitRemoteSession = parts.length === 2 && /-oracle$/i.test(bareAgent);
    const isCanonical = parts.length >= 3 || (parts.length === 2 && (isTmuxSessionIdTarget(bareAgent) || isExplicitRemoteSession));
    const isLocalScope = !targetNode || targetNode === config.node || targetNode === "local";
    if (isLocalScope && bareAgent && !isCanonical) {
      const hasLocalSession = sessions.some(s =>
        s.name === bareAgent ||
        s.windows.some(w => w.name === `${bareAgent}-oracle` || w.name === bareAgent)
      );
      // #eq3 P1 (chronic respawn): the naive name-match above misses a LIVE
      // agent sitting in a non-conventional window (worktree `nai-2-…`, numbered
      // `24-nai`) → it read as not-live → auto-wake → respawned a live agent.
      // Fold in the REAL resolver result (`bareResolution.result`, line 622 —
      // the same target used to deliver the message): deliverable ⇒ live ⇒ never
      // wake. The bare resolver returns null for node-prefixed / `local:` queries,
      // so the name-match stays as the signal for those (OR, not replace).
      const isLive = Boolean(bareResolution.result) || hasLocalSession;
      try {
        // Sub-PR 4 of #841: use the unified OracleManifest as the source of
        // truth for `isFleetKnown`. `isLive` is derived above from the resolver
        // (+ name-match fallback) since the manifest loader doesn't touch tmux
        // (see oracle-manifest.ts file-level docs) — enrich the entry locally.
        const { findOracle } = await import("../../lib/oracle-manifest");
        const { shouldAutoWake } = await import("./should-auto-wake");
        const entry = findOracle(bareAgent);
        const enriched = entry ? { ...entry, isLive } : undefined;
        const decision = shouldAutoWake(bareAgent, {
          site: "hey",
          // Fallback for the unknown-oracle (no manifest entry) branch:
          // preserve existing behavior — unknown ⇒ skip wake.
          isLive,
          isFleetKnown: false,
          isCanonicalTarget: false,
          manifest: enriched,
        });
        if (decision.wake) {
          console.log(`\x1b[36m⚡\x1b[0m '${bareAgent}' is fleet-known — auto-wake`);
          const { cmdWake } = await import("./wake-cmd");
          await cmdWake(bareAgent, {});
          // Refresh after wake — resolver needs the new tmux session visible.
          sessions = await listSessions();
          bareResolution = await resolveBareLocalTarget(query, config, sessions, currentSession);
        }
      } catch { /* fleet/wake best-effort — fall through to existing error path */ }
    } else if (targetNode && bareAgent && !isCanonical) {
      // #791: cross-node auto-wake. Sender does a best-effort /api/wake before
      // /api/send (Option B). Wake is idempotent on the receiver — if the
      // session already exists, cmdWake returns quickly.
      //
      // #835 — decision routed through shouldAutoWake(). For cross-node hey
      // we don't know the remote isLive locally; the receiver's /api/wake
      // is idempotent, so we always ask. shouldAutoWake gives us
      // wake=true on hey + !isLive + isFleetKnown=true. We model the
      // cross-node target as fleet-known (peer is configured) and not-live.
      //
      // #1998 — wake failure is NON-FATAL. The original #791 design hard-exited
      // on any wake error to keep failures visible. But that wrongly blocks
      // delivery to targets that are already live yet NOT a wakeable oracle
      // (a window / worktree-pane / non-repo alias, e.g. `mawjs-oss-world`):
      // the remote /api/wake can't resolve the bare name to a repo and returns
      // "missing oracle name", even though `maw peek` on the same target works.
      // Since the send path below (POST /api/send) uses the receiver's lenient
      // capture-by-pane resolution — the same path peek uses — we now warn and
      // fall through. If the target is genuinely unreachable, the send attempt
      // surfaces its own clear "Remote fetch failed" error (#411 contract).
      const peer = (config.namedPeers || []).find(p => p.name === targetNode);
      if (peer) {
        const { shouldAutoWake } = await import("./should-auto-wake");
        const decision = shouldAutoWake(bareAgent, {
          site: "hey",
          isLive: false,
          isFleetKnown: true, // peer-configured target — treat as fleet-known
          isCanonicalTarget: false,
        });
        if (decision.wake) {
          const wakeRes = await curlFetch(`${peer.url}/api/wake`, {
            method: "POST",
            body: JSON.stringify({ target: bareAgent }),
            from: senderIdentity.wireFrom, // #804 Step 4 SIGN — sign cross-node /api/wake
          });
          if (!wakeRes.ok || !wakeRes.data?.ok) {
            const underlying = wakeRes.data?.error || (wakeRes.status ? `HTTP ${wakeRes.status}` : "connection failed");
            // #1998 — warn (keep wake failure visible) but DO NOT exit. The
            // target may be a live window that simply isn't a wakeable oracle;
            // let the send attempt below decide success vs. a real failure.
            console.warn(`\x1b[33mwarn\x1b[0m:  cross-node wake skipped for ${bareAgent} on ${targetNode}: ${underlying} — attempting direct send (target may be live)`);
          }
        }
      }
      // peer not in namedPeers → fall through; resolveTarget will surface the routing error.
    }
  }

  // --- Unified resolution via resolveTarget (#201) ---
  // kobo-431 Option C: the guessing fallback (resolveLocalFallbackForUnknownNode)
  // is gone. eq3-006's case now resolves inside resolveTarget itself via a
  // declared `hostAliases` entry; an undeclared unknown node stays an error
  // and drops to inbox-persist, on purpose (Defect B).
  const result = bareResolution.result ?? (
    isBareLocalHeyTarget(query)
      ? { type: "error" as const, reason: "not_live", detail: `'${query}' found but no active session`, hint: `maw wake ${query}` }
      : resolveTarget(query, config, sessions, currentSession)
  );

  // --- kobo-431 (Defect A) — company-scope gate on local/self-node delivery ---
  //
  // The #842 ACL gate right below only ever fired for `result.type === "peer"`
  // (genuine cross-node) — its own comment says so plainly ("self-node and
  // local results bypass the ACL gate"). So a local/self-node send — the CLI
  // path notify.ts's task-event pings actually use (spawnHeyProcess → real
  // `maw hey` subprocess) — had NO company-scope check at all. Mirrors
  // api/sessions.ts's identical gate exactly (same trust-store bypass) —
  // one card, one fix, two call sites.
  if (result?.type === "local" || result?.type === "self-node") {
    // Dynamic import, not a top-level named import (kobo-449 lesson): this
    // symbol chain (company-scope.ts → company-helpers.ts → sdk's
    // getGhqRoot) is exactly the widely-mocked barrel several isolated
    // comm-send-*.test.ts partially mock.module() — a static import here
    // broke link-time for all of them. Same reasoning as the trust-store
    // dynamic import right below.
    // kobo-474 T3 — a gate that authorizes must be able to say "I don't know
    // who you are" distinctly from "I know, and you're someone else." Fail
    // BEFORE crossCompanyDeliveryRefusal, which only ever produces the
    // latter shape ("X is not in company Y") — collapsing "unresolved" into
    // that message would look like a real, just-wrong-company oracle tried
    // to reach here, when actually nobody could confirm who's sending.
    if (!senderIdentity.identityResolved) {
      console.error(`\x1b[31merror\x1b[0m: could not resolve a real sender identity — no CLAUDE_AGENT_NAME, no tmux session (got node fallback "${senderIdentity.senderName}"). Refusing rather than guessing who is sending.`);
      console.error("\x1b[33mhint\x1b[0m:  use `maw hey --from <node:oracle> <target> <message>` or set `MAW_SENDER=<node:oracle>`");
      process.exit(1);
    }
    // kobo-504 — Tony, 2026-07-28, twice and explicitly ("ถอด company guard เลย",
    // then "ยืนยัน เอาแบบ ก" when offered remove-silently vs remove-but-log):
    // cross-company delivery is no longer consulted at all. Not a downgraded
    // refusal, not a warning — the check is simply not on this path anymore.
    //
    // The sender-identity gate ABOVE stays and is the one that still matters:
    // it refuses when it cannot say who is sending. What it no longer does is
    // care WHICH company that sender belongs to.
    //
    // crossCompanyDeliveryRefusal itself is left in place (still used by
    // nothing on the delivery path) rather than deleted: it encodes kobo-431 /
    // kobo-474's mapping of oracle→company, this direction was reversed twice
    // within one hour today, and re-enabling is a one-line call if it reverses
    // again. Nothing calls it, so nobody is protected by it — do not read its
    // presence as a live guard.
  }

  // --- #842 Sub-C — cross-oracle ACL gate (Phase 2 of #642) ---
  //
  // When the resolved target is on a different oracle/node, consult the
  // scope + trust lists via `evaluateAclFromDisk`. A "queue" verdict means
  // the operator hasn't pre-approved this sender↔target pair and the
  // message is persisted under `<CONFIG_DIR>/pending/` for later
  // `maw inbox approve <id>`. Default-allow when no scopes are defined
  // (loadAllScopes returns []) — otherwise this would silently break every
  // existing setup that hasn't migrated to scopes yet.
  //
  // Bypass paths:
  //   1. `--approve` flag on `maw hey` (operator-explicit opt-in for THIS
  //      message; optionally `--trust` to also persist the pair)
  //   2. `MAW_ACL_BYPASS=1` env (set by `maw inbox approve <id>` when it
  //      re-issues the queued send — the human approval IS the gate)
  //
  // Queue conditions:
  //   - `result.type === "peer"` (genuine cross-node)
  //   - At least one scope defined on disk (default-allow when empty)
  //   - `evaluateAclFromDisk(sender, target) === "queue"`
  //
  // NOTE: self-node and local results bypass the ACL gate. Same-node
  // sends across oracle names are rare (most operators run one oracle
  // per node) and Phase 2's threat model targets cross-NODE delivery —
  // the federation HTTP boundary is where untrusted-by-default applies.
  if (result?.type === "peer" && !opts.approve && process.env.MAW_ACL_BYPASS !== "1") {
    try {
      const { evaluateAclFromDisk, loadAllScopes } = await import("./scope-acl");
      const scopes = loadAllScopes();
      // Default-allow when no scopes are defined — keeps existing
      // pre-#642 setups working unchanged. Operators opt in to the gate
      // by creating their first scope via `maw scope create`.
      if (scopes.length > 0) {
        const senderOracle = aclSenderOracle(config, senderIdentity);
        const targetOracle = result.target; // agent name from `<node>:<agent>`
        const decision = evaluateAclFromDisk(senderOracle, targetOracle);
        if (decision === "queue") {
          const { savePending } = await import("./queue-store");
          const record = savePending({
            sender: senderOracle,
            target: targetOracle,
            message,
            query,
          });
          console.log(
            `\x1b[33mqueued for approval\x1b[0m ${record.id} ${senderOracle} → ${targetOracle}`,
          );
          console.log(
            `\x1b[90m  review: maw inbox show-pending ${record.id}\x1b[0m`,
          );
          console.log(
            `\x1b[90m  approve: maw inbox approve ${record.id}\x1b[0m`,
          );
          return;
        }
      }
    } catch (e: any) {
      // Forgiving: ACL eval errors must not break delivery. Phase 2 is
      // additive — log + fall through to existing behavior.
      console.error(`\x1b[90mwarn: ACL evaluation failed (${e?.message ?? e}); allowing send\x1b[0m`);
    }
  }

  // --- `--approve --trust` side effect (#842 Sub-C) ---
  // Operator explicitly trusts this pair from now on. Append BEFORE
  // delivery so a subsequent same-pair send (even in a parallel process)
  // skips the gate immediately. Idempotent in `cmdAdd`.
  if (opts.approve && opts.trust && result?.type === "peer") {
    try {
      const { cmdAdd } = await import("../../lib/trust-store");
      const senderOracle = aclSenderOracle(config, senderIdentity);
      const targetOracle = result.target;
      cmdAdd(senderOracle, targetOracle);
      console.log(
        `\x1b[36m+\x1b[0m trusted ${senderOracle} ↔ ${targetOracle}`,
      );
    } catch (e: any) {
      // Same forgiving stance — trust persistence failure shouldn't
      // block the send the operator just approved.
      console.error(`\x1b[90mwarn: trust persistence failed (${e?.message ?? e})\x1b[0m`);
    }
  }

  // --- Consent gate (#644 Phase 1, opt-in via MAW_CONSENT=1) ---
  // Local + self-node sends are never gated. Cross-node hey to a peer that
  // hasn't approved (myNode → peerNode : hey) yet returns a request id +
  // PIN; user relays PIN OOB, peer runs `maw consent approve <id> <pin>`,
  // re-runs hey. After first approval, trust.json bypasses the gate.
  if (process.env.MAW_CONSENT === "1") {
    const { maybeGateConsent } = await import("../../core/consent/gate");
    const myNode = config.node ?? "local";
    const decision = await maybeGateConsent({ myNode, resolved: result, query, message });
    if (!decision.allow) {
      if (decision.message) console.error(decision.message);
      process.exit(decision.exitCode ?? 1);
    }
  }

  const senderName = senderIdentity.senderName;
  const outboundMessage = formatSignedMessage(message, { node: senderIdentity.node }, senderName);
  const receiverInboxWriter = opts.receiverInbox === false
    ? null
    : opts.receiverInbox ?? defaultReceiverInboxWriter();
  const writeReceiverInbox = async (target?: string): Promise<ReceiverInboxResult | null> => {
    if (!receiverInboxWriter) return null;
    try {
      return await receiverInboxWriter({
        query,
        target,
        to: query,
        from: senderIdentity.display,
        message: outboundMessage,
        config,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const logQueuedInbox = (inbox: ReceiverInboxResult | null, target: string, reason: string): boolean => {
    if (!inbox?.ok) return false;
    logMessage(senderName, query, outboundMessage, "inbox");
    emitMessageFeed({
      direction: "outbound",
      state: "queued",
      channel: "hey",
      route: "inbox",
      from: senderIdentity.display,
      to: query,
      target,
      text: outboundMessage,
      lastLine: reason,
      signed: true,
    }, config.port || 3456);
    // kobo-368: the inbox filename/path stays in BOTH modes — small, useful
    // diagnostic (where to find it), not an echo of the message itself.
    if (opts.verbose) {
      console.log(`\x1b[33mqueued\x1b[0m → ${inbox.oracle} ψ/inbox/${inbox.filename}: ${outboundMessage}`);
    } else {
      console.log(`\x1b[33mqueued\x1b[0m → ${inbox.oracle} ψ/inbox/${inbox.filename} (${outboundMessage.length} chars)`);
    }
    console.log(`\x1b[90m  ⤷ ${reason}\x1b[0m`);
    return true;
  };
  const notifyQueuedInbox = async (inbox: ReceiverInboxResult | null, target: string, reason: string): Promise<void> => {
    if (!inbox?.ok) return;
    const notify = await notifyLiveInboxReceiver(inbox, senderIdentity.display, {
      listSessions: async () => sessions,
      tmux: new Tmux(),
    });
    if (notify.status !== "sent") {
      const detail = notify.reason || "unknown notify failure";
      console.warn(`\x1b[33mwarn\x1b[0m: inbox pane notify skipped for ${inbox.oracle}: ${detail}`);
      emitMessageFeed({
        direction: "outbound",
        state: "queued",
        channel: "hey",
        route: "inbox-notify",
        from: senderIdentity.display,
        to: query,
        target: notify.target || target,
        text: outboundMessage,
        lastLine: `${reason}; notify skipped: ${detail}`,
        signed: true,
      }, config.port || 3456);
    }
  };

  // Local target (or self-node) → send via tmux.
  // Resolve to a specific pane first: when the oracle window has multiple
  // panes (team-agents spawned beside it), `send-keys -t session:window`
  // would otherwise land in whichever pane is currently active, not the
  // oracle's claude pane. See resolveOraclePane.
  if (result?.type === "local" || result?.type === "self-node") {
    // kobo-36 — pass the target oracle + channel so pane resolution can honor a
    // registered channel→pane mapping (e.g. task-events → coord pane). The oracle
    // key derives from the user's query (bare name; node prefix / -oracle suffix
    // stripped by the registry). No channel → registry consult is a no-op.
    // kobo-596 (option C): capture whether resolution degraded (tmux error,
    // silently fell back to the raw target) — read after the call, threaded
    // through to the receipt print at the bottom of this function.
    const paneResolution: OraclePaneResolution = {};
    const target = await resolveOraclePane(
      result.target, {}, { oracle: query, channel: opts.channel }, paneResolution,
    );
    if (opts.inboxOnly) {
      const inbox = await writeReceiverInbox(target);
      if (logQueuedInbox(inbox, target, "--inbox requested; pane injection skipped")) {
        await notifyQueuedInbox(inbox, target, "--inbox requested; pane injection skipped");
        return;
      }
      const reason = inbox && !inbox.ok && inbox.reason ? `: ${inbox.reason}` : "";
      console.error(`\x1b[31merror\x1b[0m: --inbox requested but receiver inbox is unavailable for ${target}${reason}`);
      process.exit(1);
    }
    // mawjs-3 — presence "away" gate. If the target stepped out (`maw presence away`
    // from /toilet), PARK the message to its inbox and tell the SENDER only. Placed
    // BEFORE the busy guard and deliberately WITHOUT queueForDispatch / receiver
    // notify: away ≠ busy. Auto-delivering on idle (busy path) or injecting a "you
    // have mail" line would overtype a pane that is mid-/clear or /seat (eq3 FLAG 1).
    // The message is durable in the inbox; /seat drains it on return.
    // Lazy import: keeps presence-away out of comm-send's static module graph so the
    // plugin-standalone / cache-busting isolated re-imports don't surface a barrel cycle.
    // Per-pane (kobo-120): one oracle can own several panes (crew coord + workers). Resolve
    // the target to its `%N` pane id so the gate parks only when THAT pane is away — a coord
    // who stepped out parks, while an active worker pane of the same oracle still injects.
    const { isPaneAway } = await import("../../core/worklog/presence-away");
    const targetPaneId = await paneIdOfTarget(target);
    // Pane-aware oracle (handles "patchwork", "13-patchwork:0.2", "m5:patchwork"); strip a
    // trailing -oracle. This is the oracle whose worklog carries the away/back events.
    const awayOracle = extractPaneOracle(query).replace(/-oracle$/i, "");
    if (isPaneAway(awayOracle, targetPaneId)) {
      // kobo-306 — the room nudge opts in (--queue-on-away): an away lead must still
      // learn of a new brainstorm turn, auto-delivered when they /seat back. Queue it
      // on the dispatch bridge (like the busy path) so DispatchEngine delivers on the
      // next busy→ready transition after return — instead of parking to a silent (and,
      // per kobo-305, sometimes failing) inbox. Scoped: only this flag changes the away
      // path; a plain hey to an away oracle still parks (away≠busy, kobo-288 unchanged).
      if (opts.queueOnAway) {
        queueForDispatch({ from: `${config.node ?? "local"}:${senderName}`, to: query, target, message: outboundMessage });
        const inbox = await writeReceiverInbox(target);
        const reason = `'${awayOracle}' is away — queued for auto-delivery on their /seat`;
        if (logQueuedInbox(inbox, target, reason)) {
          await notifyQueuedInbox(inbox, target, reason);
          return;
        }
        // Queue holds it even if the inbox write failed → not a silent drop; report truthfully.
        console.log(`\x1b[33mqueued\x1b[0m '${awayOracle}' is away — will auto-deliver when they /seat back`);
        return;
      }
      const inbox = await writeReceiverInbox(target);
      const reason = `'${awayOracle}' is away (stepped out) — parked to inbox, delivered on their /seat`;
      if (logQueuedInbox(inbox, target, reason)) return; // sender-side notice + feed; NO pane injection
      // kobo-288 — park failed. The away path deliberately does NOT queueForDispatch
      // (away ≠ busy), so a failed park means the message is persisted nowhere and
      // queued nowhere. The old fallthrough still printed "queued to inbox" → a silent
      // drop dressed as success. Surface a truthful delivery error instead (mirrors the
      // --inbox path above); never claim "queued" when nothing was written.
      const detail = inbox && !inbox.ok && inbox.reason ? `: ${inbox.reason}` : "";
      console.error(`\x1b[31merror\x1b[0m: '${awayOracle}' is away but parking to inbox failed for ${target}${detail} — message NOT delivered`);
      process.exit(1);
    }

    // Phase 2 busy guard — queue to inbox + dispatch queue if target is actively working
    const guard = await checkBusyGuard(query);
    if (guard.busy) {
      queueForDispatch({ from: `${config.node ?? "local"}:${senderName}`, to: query, target, message: outboundMessage });
      const inbox = await writeReceiverInbox(target);
      const reason = `target '${guard.oracle}' is busy; queued for auto-delivery`;
      if (logQueuedInbox(inbox, target, reason)) {
        await notifyQueuedInbox(inbox, target, reason);
        return;
      }
      console.log(`\x1b[33mqueued\x1b[0m target '${guard.oracle}' is busy — will auto-deliver when idle`);
      return;
    }

    // eq3-003 — pane-input guard: status may say "ready" while the operator is
    // mid-typing on the prompt line. Injecting now would overtype their input
    // (and a stray Enter could submit a half-typed line). #1860 dropped the old
    // #405 hard block in favor of always-inject; this is its queue-based
    // successor — defer instead of block, then auto-deliver once the pane is
    // clean (DispatchEngine sweep / busy→ready transition / `maw flush`).
    // Capture failure falls through to idle=true (checkPaneIdle), so a flaky
    // pane never blocks delivery permanently. Opt out via inputGuard.enabled=false.
    // Read off the already-loaded config (not a new barrel helper) so the wide
    // set of modules that mock `src/config` inline don't all need a new export.
    if (config.inputGuard?.enabled ?? true) {
      // kobo-508: checkPaneIdle alone was the only real send-gate (detectPermissionMenu
      // used to be notify-only). isSafeToInject combines both so a menu drawn in a
      // shape that fools checkPaneIdle's ghost-strip still defers instead of typing
      // over an open confirm dialog.
      const safe = await isSafeToInject(target);
      if (!safe.safe) {
        queueForDispatch({ from: `${config.node ?? "local"}:${senderName}`, to: query, target, message: outboundMessage });
        const inbox = await writeReceiverInbox(target);
        const reason = safe.reason === "menu"
          ? `a permission/confirm menu is open on '${guard.oracle}'; queued — auto-delivers when it clears`
          : `operator input in progress on '${guard.oracle}'; queued — auto-delivers when the pane clears`;
        if (logQueuedInbox(inbox, target, reason)) {
          await notifyQueuedInbox(inbox, target, reason);
          return;
        }
        const label = safe.reason === "menu" ? "has a permission menu open" : "has operator input mid-edit";
        console.log(`\x1b[33mqueued\x1b[0m '${guard.oracle}' ${label} — will auto-deliver when the pane clears \x1b[90m(📬)\x1b[0m`);
        return;
      }
    }

    // #1967: the receiver inbox is the durable delivery guarantee; pane
    // injection is only the live wake-up. Persist first so a tmux race cannot
    // silently drop the message before it reaches ψ/inbox.
    const inbox = await writeReceiverInbox(target);
    try {
      await sendKeys(target, outboundMessage);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const reason = `tmux delivery failed: ${msg}`;
      if (logQueuedInbox(inbox, target, reason)) {
        await notifyQueuedInbox(inbox, target, reason);
        return;
      }
      console.error(`\x1b[31merror\x1b[0m: tmux delivery failed for ${target}: ${msg}`);
      process.exit(1);
    }
    // #1907 — verify the implicit Enter actually submitted. Default-on
    // for live use; opt out per-call with --no-verify-submit; auto-skip
    // under MAW_TEST_MODE so existing cmdSend mock harnesses (which don't
    // stub capture-pane) don't have to adopt the verify seam.
    if (!opts.noVerifySubmit && process.env.MAW_TEST_MODE !== "1") {
      const verify = await verifySubmitDelivered(target, outboundMessage);
      if (verify.warning) {
        console.log(`  \x1b[33m⚠\x1b[0m ${verify.warning}`);
      } else if (verify.retriesNeeded > 0) {
        console.log(`  \x1b[33m⚠\x1b[0m submit needed ${verify.retriesNeeded} Enter retry — TUI may have been in scroll-mode`);
      }
    }
    await runHook("after_send", { to: query, message: outboundMessage });
    if (!config.node) throw new Error("config.node is required — set 'node' in maw.config.json");
    logMessage(senderName, query, outboundMessage, "local");
    await Bun.sleep(150);
    let lastLine = "";
    try { const content = await capture(target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
    emitMessageFeed({
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: senderIdentity.display,
      to: query,
      target,
      text: outboundMessage,
      lastLine,
      signed: true,
    }, config.port || 3456);
    // kobo-596 (option A) — "delivered" claimed more than this code path can
    // verify: it proves the keystrokes were successfully written into SOME
    // pane's input box (sendKeys didn't throw) — never that the pane belongs
    // to the right, live session, and never that a person read it. "landed"
    // is the word that matches what's actually checked here; it still does
    // NOT imply a human received or read the message, only that text reached
    // a pane. (kobo-596 option C, immediately below) when pane resolution
    // itself degraded — resolveOraclePane hit a tmux error and silently fell
    // back to the raw, unresolved target — that fallback must be visible
    // here, not just internally logged: the text may have landed in the
    // WRONG pane (or a dead one) with nothing about "landed" catching that.
    if (paneResolution.degraded) {
      console.log(`\x1b[33m⚠ sent (pane resolution degraded)\x1b[0m → ${target} \x1b[90m— tmux pane lookup failed (${paneResolution.error}), sent to the raw target as a fallback; verify this reached the right pane\x1b[0m`);
    } else if (opts.verbose) {
      console.log(`\x1b[32mlanded\x1b[0m → ${target}: ${outboundMessage}`);
    } else {
      console.log(`\x1b[32mlanded\x1b[0m → ${target} (${outboundMessage.length} chars)`);
    }
    // kobo-368: the captured tail-line stays in BOTH modes — it's a small, already-
    // truncated (cfgLimit) diagnostic snippet of what the RECEIVER'S pane now shows,
    // not an echo of what was just sent; it was never the flagged token-waste.
    if (lastLine) console.log(`\x1b[90m  ⤷ ${lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
    await runPluginEventHooks("transport:after_send", {
      event: "transport:after_send",
      route: "local",
      target,
      to: query,
      from: senderIdentity.display,
      result: {
        ok: true,
        state: "local",
        route: "local",
      },
      via: "tmux",
      message: outboundMessage,
    });
    // #1980: warn on silent misdelivery to a window that isn't the named oracle.
    const mismatch = detectWindowMismatch(query, result.target, sessions);
    if (mismatch) console.log(`  \x1b[33m⚠\x1b[0m ${mismatch}`);
    return;
  }

  // Remote peer → federation HTTP
  if (result?.type === "peer") {
    // eq3-005 — federation-vs-local guard: explicit node:name routed to a peer,
    // but the bare name is also live locally. Surface it (no auto-redirect).
    try {
      const localIsLive = resolveTarget(result.target, config, sessions)?.type === "local";
      const overrideHint = peerLocalOverrideHint(query, result.target, localIsLive);
      if (overrideHint) console.warn(`\x1b[33mhint\x1b[0m:  ${overrideHint}`);
    } catch { /* hint is best-effort; never block the send */ }
    const res = await curlFetch(`${result.peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text: outboundMessage, ...(opts.inboxOnly ? { inbox: true } : {}) }),
      from: senderIdentity.wireFrom, // #804 Step 4 SIGN — sign cross-node /api/send
    });
    if (res.ok && res.data?.ok) {
      const state = res.data.state === "delivered" ? "delivered" : "queued";
      logMessage(senderName, query, outboundMessage, `peer:${result.node}`);
      emitMessageFeed({
        direction: "outbound",
        state,
        channel: "hey",
        route: "peer",
        from: senderIdentity.display,
        to: `${result.node}:${result.target}`,
        target: res.data.target || result.target,
        peerUrl: result.peerUrl,
        text: outboundMessage,
        lastLine: res.data.lastLine || "",
        signed: true,
      }, config.port || 3456);
      const color = state === "queued" ? "\x1b[33m" : "\x1b[32m";
      if (opts.verbose) {
        console.log(`${color}${state}\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${outboundMessage}`);
      } else {
        console.log(`${color}${state}\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target} (${outboundMessage.length} chars)`);
      }
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      // #1980: surface the receiving node's misdelivery warning, if any.
      if (res.data.warning) console.log(`  \x1b[33m⚠\x1b[0m ${res.data.warning}`);
      await runPluginEventHooks("transport:after_send", {
        event: "transport:after_send",
        route: "peer",
        node: result.node,
        target: result.target,
        peerUrl: result.peerUrl,
        to: query,
        from: senderIdentity.display,
        result: {
          ok: state === "delivered",
          state,
          target: res.data.target || result.target,
          peerUrl: result.peerUrl,
          lastLine: res.data.lastLine,
        },
        via: "http",
        message: outboundMessage,
      });
      await runHook("after_send", { to: query, message: outboundMessage });
      return;
    }
    const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
    emitMessageFeed({
      direction: "outbound",
      state: "failed",
      channel: "hey",
      route: "peer",
      from: senderIdentity.display,
      to: `${result.node}:${result.target}`,
      target: result.target,
      peerUrl: result.peerUrl,
      text: outboundMessage,
      error: underlying,
      signed: true,
    }, config.port || 3456);
    console.error(`\x1b[31merror\x1b[0m: Remote fetch failed for peer ${result.peerUrl} (${result.node}): ${underlying}`);
    console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
    process.exit(1);
  }

  // Fallback: async peer discovery (network scan — slow path).
  // Only reached when resolveTarget found no local session AND no config-mapped peer.
  // Local sessions were already checked above — if we reach here, local genuinely missed.
  const peerUrl = isBareLocalHeyTarget(query) ? null : await findPeerForTarget(query, sessions);
  if (peerUrl) {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: outboundMessage, ...(opts.inboxOnly ? { inbox: true } : {}) }),
      from: senderIdentity.wireFrom, // #804 Step 4 SIGN — sign discovery-fallback /api/send
    });
    if (res.ok && res.data?.ok) {
      const state = res.data.state === "delivered" ? "delivered" : "queued";
      logMessage(senderName, query, outboundMessage, "discovery");
      emitMessageFeed({
        direction: "outbound",
        state,
        channel: "hey",
        route: "discovery",
        from: senderIdentity.display,
        to: query,
        target: res.data.target || query,
        peerUrl,
        text: outboundMessage,
        lastLine: res.data.lastLine || "",
        signed: true,
      }, config.port || 3456);
      const color = state === "queued" ? "\x1b[33m" : "\x1b[32m";
      if (opts.verbose) {
        console.log(`${color}${state}\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query}: ${outboundMessage}`);
      } else {
        console.log(`${color}${state}\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query} (${outboundMessage.length} chars)`);
      }
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runPluginEventHooks("transport:after_send", {
        event: "transport:after_send",
        route: "discovery",
        node: query.split(":")[0] ?? null,
        target: res.data.target || query,
        peerUrl,
        to: query,
        from: senderIdentity.display,
        result: {
          ok: state === "delivered",
          state,
          target: res.data.target || query,
          peerUrl,
          lastLine: res.data.lastLine,
        },
        via: "discovery",
        message: outboundMessage,
      });
      await runHook("after_send", { to: query, message: outboundMessage });
      return;
    }
    // Remote fetch was attempted but failed — surface the remote failure explicitly (#411).
    // Never fall through to "not found in local sessions" when the real problem is network.
    const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
    emitMessageFeed({
      direction: "outbound",
      state: "failed",
      channel: "hey",
      route: "discovery",
      from: senderIdentity.display,
      to: query,
      target: query,
      peerUrl,
      text: outboundMessage,
      error: underlying,
      signed: true,
    }, config.port || 3456);
    console.error(`\x1b[31merror\x1b[0m: Remote fetch failed for peer ${peerUrl}: ${underlying}`);
    console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
    process.exit(1);
  }

  // kobo-119 — OFFLINE (the oracle's repo was located but there is NO active session,
  // i.e. the pane is dead) = HARD REJECT (Tony 2026-07-05, overriding kobo-113's
  // durable-park). Don't write a fresh inbox entry for a pane that isn't there to read
  // it — reject the new send and tell the sender it's offline so they can wake/retry.
  // Rejects only the NEW send; existing inbox contents are untouched. `away` (park) +
  // `online` (inject) are handled earlier and unchanged — only this offline branch flips.
  if (bareResolution.locate?.repoPath) {
    emitMessageFeed({
      direction: "outbound",
      state: "failed",
      channel: "hey",
      route: "reject",
      from: senderIdentity.display,
      to: query,
      target: query,
      text: outboundMessage,
      lastLine: "target offline — not sent (no active session)",
      signed: true,
    }, config.port || 3456);
    logMessage(senderName, query, outboundMessage, "reject");
    console.error(`\x1b[31moffline\x1b[0m: '${query}' found at ${bareResolution.locate.repoPath} but no active session — ส่งไม่ได้ (offline, not sent)`);
    console.error(`\x1b[33mhint\x1b[0m:  wake it first: maw wake ${query}`);
    process.exit(1);
  }

  // No repo located (unknown target) — keep the existing default-inbox fallback so a
  // genuinely-mis-typed / not-yet-resolved name is not silently dropped (eq3-005). This
  // is NOT the "offline" case Tony rejected; it is "couldn't resolve the target at all".
  const reason = `delivered to ${query}'s inbox (not live now) — they'll read it on the next poll`;
  const inbox = await writeReceiverInbox();
  if (logQueuedInbox(inbox, query, reason)) {
    await notifyQueuedInbox(inbox, query, reason);
    return;
  }

  // Local-only miss — no network was attempted (#411). Show resolver's own detail.
  if (result?.type === "error") {
    console.error(`\x1b[31merror\x1b[0m: ${result.detail}`);
    if (result.hint) console.error(`\x1b[33mhint\x1b[0m:  ${result.hint}`);
  } else {
    console.error(`\x1b[31merror\x1b[0m: window not found: ${query}`);
    if (config.agents && Object.keys(config.agents).length > 0) {
      console.error(`\x1b[33mhint\x1b[0m:  known agents: ${Object.keys(config.agents).join(", ")}`);
    }
  }
  process.exit(1);
}
