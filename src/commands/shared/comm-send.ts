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
 */
/** @internal */
export async function resolveOraclePane(
  target: string,
  deps: {
    tmuxRun?: (...args: string[]) => Promise<string>;
    isAgentCommandFn?: typeof isAgentCommand;
  } = {},
): Promise<string> {
  // Already pane-specific — honor caller's choice.
  if (/\.[0-9]+$/.test(target)) return target;

  try {
    const run = deps.tmuxRun ?? ((...args: string[]) => new Tmux().run(...args));
    const isAgent = deps.isAgentCommandFn ?? isAgentCommand;
    const raw = await run("list-panes", "-t", target, "-F", "#{pane_index} #{pane_current_command}");
    const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return target; // single-pane window: active pane is the only pane

    const agentIndexes: number[] = [];
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const idx = parseInt(line.slice(0, spaceIdx), 10);
      const cmd = line.slice(spaceIdx + 1);
      if (Number.isFinite(idx) && isAgent(cmd)) {
        agentIndexes.push(idx);
      }
    }
    if (agentIndexes.length === 0) return target;
    return `${target}.${Math.min(...agentIndexes)}`;
  } catch {
    return target;
  }
}

/** Resolve the current oracle name from CLAUDE_AGENT_NAME or the attached tmux pane. */
/** @internal */
export function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  // Only trust tmux when this process is actually running inside a tmux pane.
  // Outside tmux, `tmux display-message` can still succeed by reporting the
  // server's current/last-active session, which misattributes sender envelopes.
  if (process.env.TMUX) {
    try {
      const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
      if (tmuxSession) return tmuxSession.replace(/^\d+-/, "");
    } catch {}
  }
  return config.node || "cli";
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
    return { ...parsed, source: explicit ? "flag" : "env" };
  }

  if (hasSshRelayEnv(env)) {
    throw new Error("refusing to stamp SSH-relayed maw hey as the local oracle; set --from <node:oracle> or MAW_SENDER=<node:oracle>");
  }

  const senderName = resolveMyName(config);
  const node = config.node || "local";
  return {
    node,
    oracle: senderName,
    display: `${node}:${senderName}`,
    wireFrom: "auto",
    senderName,
    source: "auto",
  };
}

function rejectSenderIdentity(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31merror\x1b[0m: ${message}`);
  console.error("\x1b[33mhint\x1b[0m:  use `maw hey --from alpha:volt-oracle <target> <message>` or set `MAW_SENDER=alpha:volt-oracle`");
  process.exit(1);
}

function aclSenderOracle(config: ReturnType<typeof loadConfig>, senderIdentity: SenderIdentity): string {
  return senderIdentity.source === "auto"
    ? (config.oracle ?? "mawjs")
    : senderIdentity.senderName;
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
export async function checkPaneIdle(
  target: string,
  host?: string,
  deps: { captureFn?: typeof capture } = {},
): Promise<{ idle: boolean; lastInput: string }> {
  const capturePane = deps.captureFn ?? capture;
  try {
    // Capture enough rows to see the TUI input box above its divider+footer.
    const content = await capturePane(target, 12, host);
    const lines = content
      .split("\n")
      // Strip OSC sequences (e.g. OSC 8 hyperlinks the Claude Code footer wraps
      // PR links in: ESC ] 8 ; … ST) BEFORE CSI — a CSI-only strip leaves the
      // URL as literal noise. ST terminator is `ESC \`, BEL is the legacy form.
      .map(l => l
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
  const result = bareResolution.result ?? (
    isBareLocalHeyTarget(query)
      ? { type: "error" as const, reason: "not_live", detail: `'${query}' found but no active session`, hint: `maw wake ${query}` }
      : resolveTarget(query, config, sessions, currentSession)
  );

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
    console.log(`\x1b[33mqueued\x1b[0m → ${inbox.oracle} ψ/inbox/${inbox.filename}: ${outboundMessage}`);
    console.log(`\x1b[90m  ⤷ ${reason}\x1b[0m`);
    return true;
  };
  const warnOfflineInboxOnly = (): void => {
    console.warn(`\x1b[33m⚠ target node offline — message written to inbox only, will not be seen until node wakes\x1b[0m`);
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
    const target = await resolveOraclePane(result.target);
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
      const pane = await checkPaneIdle(target);
      if (!pane.idle) {
        queueForDispatch({ from: `${config.node ?? "local"}:${senderName}`, to: query, target, message: outboundMessage });
        const inbox = await writeReceiverInbox(target);
        const reason = `operator input in progress on '${guard.oracle}'; queued — auto-delivers when the pane clears`;
        if (logQueuedInbox(inbox, target, reason)) {
          await notifyQueuedInbox(inbox, target, reason);
          return;
        }
        console.log(`\x1b[33mqueued\x1b[0m '${guard.oracle}' has operator input mid-edit — will auto-deliver when the pane clears \x1b[90m(📬)\x1b[0m`);
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
    console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${outboundMessage}`);
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
      console.log(`${color}${state}\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${outboundMessage}`);
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
      console.log(`${color}${state}\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query}: ${outboundMessage}`);
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

  // Try receiver inbox queue before surfacing a local-only resolver miss.
  if (bareResolution.locate?.repoPath) {
    const reason = `${query} found at ${bareResolution.locate.repoPath} but no active session — written to inbox only`;
    const inbox = await writeReceiverInbox(bareResolution.locate.repoPath);
    if (logQueuedInbox(inbox, query, reason)) {
      await notifyQueuedInbox(inbox, query, reason);
      warnOfflineInboxOnly();
      return;
    }
    console.warn(`\x1b[33mwarn\x1b[0m: ${reason}`);
  } else {
    const reason = "target not live; persisted for receiver inbox polling";
    const inbox = await writeReceiverInbox();
    if (logQueuedInbox(inbox, query, reason)) {
      await notifyQueuedInbox(inbox, query, reason);
      return;
    }
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
