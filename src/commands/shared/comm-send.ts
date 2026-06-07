/**
 * comm-send.ts — cmdSend + resolveOraclePane + resolveMyName.
 */

import {
  listSessions, capture, sendKeys, isAgentCommand, findPeerForTarget, resolveTarget,
  curlFetch, runHook,
} from "../../sdk";
import { Tmux } from "../../core/transport/tmux";
import { AmbiguousMatchError } from "../../core/runtime/find-window";
import { loadConfig, cfgLimit } from "../../config";
import { logMessage, emitFeed } from "./comm-log-feed";
import { buildMessageLifecycleFeedEvent, type MessageLifecycleInput } from "../../lib/message-events";
import {
  defaultReceiverInboxWriter,
  type ReceiverInboxResult,
  type ReceiverInboxWriter,
} from "./receiver-inbox";

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

/** Resolve the current oracle name from CLAUDE_AGENT_NAME or tmux session */
/** @internal */
export function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  // Try tmux session name: "08-mawjs" → "mawjs"
  try {
    const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
    if (tmuxSession) return tmuxSession.replace(/^\d+-/, "");
  } catch {}
  return config.node || "cli";
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
 * Uses capture-pane to inspect the last visible line. If a shell prompt marker
 * ($, %, >, ❯, #) is followed by non-whitespace text, the user is mid-input.
 * Errors and non-shell panes (running agent) conservatively return idle=true.
 * (#405 — idle guard before send-keys)
 */
export async function checkPaneIdle(
  target: string,
  host?: string,
  deps: { captureFn?: typeof capture } = {},
): Promise<{ idle: boolean; lastInput: string }> {
  const capturePane = deps.captureFn ?? capture;
  try {
    const content = await capturePane(target, 5, host);
    const lines = content.split("\n").filter(l => l.trim());
    const lastLine = lines.at(-1) ?? "";
    // Strip ANSI escape codes
    const clean = lastLine.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, "").replace(/\r/g, "");
    // Idle: last line ends with prompt marker + optional whitespace (nothing typed)
    if (/[#$%>❯»]\s*$/.test(clean)) return { idle: true, lastInput: "" };
    // Not idle: prompt marker followed by non-whitespace user content
    const notIdleMatch = clean.match(/[#$%>❯»]\s+(\S.*)$/);
    if (notIdleMatch) return { idle: false, lastInput: notIdleMatch[1] };
    // No prompt visible (command running or agent output) → treat as idle
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
): ReturnType<typeof resolveTarget> | null {
  if (!result) return null;
  if (result.type === "local" || result.type === "self-node") return result;
  // A bare query may discover a remote peer via config.agents/manifest. Do not
  // use that implicit remote route: #1572 makes bare names local-only so
  // operators must spell cross-node delivery with `<node>:`.
  return null;
}

function assertBareLocalTarget(
  query: string,
  config: ReturnType<typeof loadConfig>,
  sessions: Awaited<ReturnType<typeof listSessions>>,
): ReturnType<typeof resolveTarget> | null {
  if (!isBareLocalHeyTarget(query)) return null;

  try {
    const localResult = normalizeBareLocalResult(query, resolveTarget(query, config, sessions));
    if (localResult) return localResult;
  } catch (e) {
    if (e instanceof AmbiguousMatchError) {
      rejectBareAmbiguous(query, e.candidates);
    }
    throw e;
  }

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
 */
export interface CmdSendOptions {
  approve?: boolean;
  trust?: boolean;
  inboxOnly?: boolean;
  receiverInbox?: ReceiverInboxWriter | false;
}

export async function cmdSend(
  query: string,
  message: string,
  force = false,
  opts: CmdSendOptions = {},
) {
  const config = loadConfig();

  // --- Team fan-out routing: maw hey team:<team-name> <msg> (#627) ---
  if (query.startsWith("team:")) {
    const teamName = query.slice("team:".length);
    if (!teamName) {
      console.error("usage: maw hey team:<team-name> <message>");
      process.exit(1);
    }
    const { getOracleMembers, loadOracleRegistry } = await import("../../lib/oracle-members");
    const senderOracle = resolveMyName(config);
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
    const origExit = process.exit;
    for (const member of members) {
      const routedMember = resolveTeamWorkspaceMemberTarget(teamName, member, sessions) ?? member;
      let memberFailed = false;
      process.exit = ((code?: number) => {
        memberFailed = true;
      }) as never;
      try {
        await cmdSend(routedMember, message, force, opts);
        if (!memberFailed) delivered++;
        else failed++;
      } catch (e: any) {
        failed++;
        console.error(`  \x1b[31m✗\x1b[0m ${routedMember}: ${e?.message || "failed"}`);
      }
    }
    process.exit = origExit;

    console.log(`\x1b[36m⚡\x1b[0m fan-out complete: ${delivered} delivered, ${failed} failed`);
    return;
  }

  // --- Plugin routing: maw hey plugin:<name> <msg> ---
  if (query.startsWith("plugin:")) {
    const name = query.slice("plugin:".length);
    const { discoverPackages, invokePlugin } = await import("../../plugin/registry");
    const plugin = discoverPackages().find(p => p.manifest.name === name);
    if (!plugin) { console.error(`plugin not found: ${name}`); process.exit(1); }
    const result = await invokePlugin(plugin, { source: "peer", args: { message, from: config.node ?? "local" } });
    if (result.ok) { console.log(result.output ?? "(no output)"); return; }
    console.error(`plugin error: ${result.error}`);
    process.exit(1);
  }

  let sessions = await listSessions();
  const bareLocalResult = assertBareLocalTarget(query, config, sessions);

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
    const isCanonical = parts.length >= 3 || (parts.length === 2 && isTmuxSessionIdTarget(bareAgent));
    const isLocalScope = !targetNode || targetNode === config.node || targetNode === "local";
    if (isLocalScope && bareAgent && !isCanonical) {
      const hasLocalSession = sessions.some(s =>
        s.name === bareAgent ||
        s.windows.some(w => w.name === `${bareAgent}-oracle` || w.name === bareAgent)
      );
      try {
        // Sub-PR 4 of #841: use the unified OracleManifest as the source of
        // truth for `isFleetKnown`. We still derive `isLive` from the freshly
        // captured `listSessions()` because the manifest's loader doesn't
        // touch tmux (see oracle-manifest.ts file-level docs) — so we enrich
        // the entry's `isLive` field locally before handing it to the helper.
        const { findOracle } = await import("../../lib/oracle-manifest");
        const { shouldAutoWake } = await import("./should-auto-wake");
        const entry = findOracle(bareAgent);
        const enriched = entry ? { ...entry, isLive: hasLocalSession } : undefined;
        const decision = shouldAutoWake(bareAgent, {
          site: "hey",
          // Fallback for the unknown-oracle (no manifest entry) branch:
          // preserve existing behavior — unknown ⇒ skip wake.
          isLive: hasLocalSession,
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
        }
      } catch { /* fleet/wake best-effort — fall through to existing error path */ }
    } else if (targetNode && bareAgent && !isCanonical) {
      // #791: cross-node auto-wake. Sender does explicit /api/wake before
      // /api/send (Option B). Wake is idempotent on the receiver — if the
      // session already exists, cmdWake returns quickly. If wake errors,
      // surface and exit (do NOT silently fall through to send — design
      // call requires wake errors to be visible).
      //
      // #835 — decision routed through shouldAutoWake(). For cross-node hey
      // we don't know the remote isLive locally; the receiver's /api/wake
      // is idempotent, so we always ask. shouldAutoWake gives us
      // wake=true on hey + !isLive + isFleetKnown=true. We model the
      // cross-node target as fleet-known (peer is configured) and not-live.
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
            from: "auto", // #804 Step 4 SIGN — sign cross-node /api/wake
          });
          if (!wakeRes.ok || !wakeRes.data?.ok) {
            const underlying = wakeRes.data?.error || (wakeRes.status ? `HTTP ${wakeRes.status}` : "connection failed");
            // #942 — surface as "Remote fetch failed for peer" so callers see a
            // consistent network-failure shape across wake + send (#411 contract).
            console.error(`\x1b[31merror\x1b[0m: Remote fetch failed for peer ${peer.url} (${targetNode}): cross-node wake failed for ${bareAgent}: ${underlying}`);
            console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
            process.exit(1);
          }
        }
      }
      // peer not in namedPeers → fall through; resolveTarget will surface the routing error.
    }
  }

  // --- Unified resolution via resolveTarget (#201) ---
  const result = bareLocalResult ?? resolveTarget(query, config, sessions);

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
        const senderOracle = config.oracle ?? "mawjs";
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
      const senderOracle = config.oracle ?? "mawjs";
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

  const senderName = resolveMyName(config);
  const outboundMessage = formatSignedMessage(message, config, senderName);
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
        from: `${config.node ?? "local"}:${senderName}`,
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
      from: `${config.node ?? "local"}:${senderName}`,
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

  // Local target (or self-node) → send via tmux.
  // Resolve to a specific pane first: when the oracle window has multiple
  // panes (team-agents spawned beside it), `send-keys -t session:window`
  // would otherwise land in whichever pane is currently active, not the
  // oracle's claude pane. See resolveOraclePane.
  if (result?.type === "local" || result?.type === "self-node") {
    const target = await resolveOraclePane(result.target);
    if (opts.inboxOnly) {
      const inbox = await writeReceiverInbox(target);
      if (logQueuedInbox(inbox, target, "--inbox requested; pane injection skipped")) return;
      const reason = inbox && !inbox.ok && inbox.reason ? `: ${inbox.reason}` : "";
      console.error(`\x1b[31merror\x1b[0m: --inbox requested but receiver inbox is unavailable for ${target}${reason}`);
      process.exit(1);
    }
    await sendKeys(target, outboundMessage);
    await writeReceiverInbox(target);
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
      from: `${config.node}:${senderName}`,
      to: query,
      target,
      text: outboundMessage,
      lastLine,
      signed: true,
    }, config.port || 3456);
    console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${outboundMessage}`);
    if (lastLine) console.log(`\x1b[90m  ⤷ ${lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
    return;
  }

  // Remote peer → federation HTTP
  if (result?.type === "peer") {
    const res = await curlFetch(`${result.peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text: outboundMessage, ...(opts.inboxOnly ? { inbox: true } : {}) }),
      from: "auto", // #804 Step 4 SIGN — sign cross-node /api/send
    });
    if (res.ok && res.data?.ok) {
      const state = res.data.state === "delivered" ? "delivered" : "queued";
      logMessage(senderName, query, outboundMessage, `peer:${result.node}`);
      emitMessageFeed({
        direction: "outbound",
        state,
        channel: "hey",
        route: "peer",
        from: `${config.node!}:${senderName}`,
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
      await runHook("after_send", { to: query, message: outboundMessage });
      return;
    }
    const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
    emitMessageFeed({
      direction: "outbound",
      state: "failed",
      channel: "hey",
      route: "peer",
      from: `${config.node ?? "local"}:${senderName}`,
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
  const peerUrl = await findPeerForTarget(query, sessions);
  if (peerUrl) {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: outboundMessage, ...(opts.inboxOnly ? { inbox: true } : {}) }),
      from: "auto", // #804 Step 4 SIGN — sign discovery-fallback /api/send
    });
    if (res.ok && res.data?.ok) {
      const state = res.data.state === "delivered" ? "delivered" : "queued";
      logMessage(senderName, query, outboundMessage, "discovery");
      emitMessageFeed({
        direction: "outbound",
        state,
        channel: "hey",
        route: "discovery",
        from: `${config.node ?? "local"}:${senderName}`,
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
      from: `${config.node ?? "local"}:${senderName}`,
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
  if (logQueuedInbox(await writeReceiverInbox(), query, "target not live; persisted for receiver inbox polling")) return;

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
