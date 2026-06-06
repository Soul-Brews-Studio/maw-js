import { isInfrastructureChannelSessionName, resolveFleetWindowSessionTarget } from "maw-js/sdk";
import { resolvePeer as resolveConfiguredPeer } from "../ls/internal/peer-resolve";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolve a `maw attach <target>` invocation into a tiered match.
 *
 * Phase 1 — Smart Local (#25):
 *   Tier 1 — running:  tmux session matches (incl. slot prefix / stem suffix)
 *                      → attach immediately, no prompt
 *   Tier 2 — sleeping: fleet entry matches but no live tmux session
 *                      → prompt to wake, then attach
 *   null               → nothing matched: caller emits "available oracles" hint
 *
 * Tier 3 (cross-node attach): explicit `maw a <node>:<session>` resolves a
 * configured peer directly (#1876). Bare `maw a <session>` may also opt into a
 * bounded federation precheck after local Tier 1/2 misses and before wake/scan
 * (#1878), then hands the remote-live match to the same attach-ssh strategy.
 *
 * Deps are injected for testability — same shape as the sleep resolver.
 */

export interface SessionLike {
  name: string;
  windows: Array<{ name: string }>;
}

export interface FleetLike {
  name: string;
  windows: Array<{ name: string }>;
}

export interface RemotePeerLike {
  alias: string;
  url: string;
  node: string | null;
  sshAlias?: string;
  sshHost?: string;
  sshUser?: string;
}

export interface RemoteSessionNodeLike extends RemotePeerLike {
  sessions: SessionLike[];
  error?: string;
}

export interface ResolveDeps {
  listSessions: () => Promise<SessionLike[]>;
  loadFleet: () => FleetLike[];
  resolvePeer?: (alias: string) => RemotePeerLike | null | Promise<RemotePeerLike | null>;
  listRemoteSessions?: () => Promise<RemoteSessionNodeLike[]>;
}

export type ResolveResult =
  | {
      tier: 1;
      sessionName: string;
      windowName?: string;
      ambiguousCandidates?: string[];
    }
  | { tier: 2; fleetName: string; ambiguousCandidates?: string[] }
  | { tier: 3; sessionName: string; node: string; peerUrl: string; sshAlias: string; ambiguousCandidates?: string[] }
  | { tier: "error"; error: string; hint?: string }
  | null;

const stripDash = (s: string) => s.replace(/-+$/, "");

function normalizeAttachQuery(target: string): string {
  return target.trim();
}

function parseExplicitPeerAttachTarget(target: string): { node: string; sessionName: string } | { error: string; hint?: string } | null {
  const trimmed = target.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;

  const left = trimmed.slice(0, colon).trim();
  const right = trimmed.slice(colon + 1).trim();

  // Numeric window/pane suffixes (`neo:0`, `neo:1.2`) are local tmux syntax
  // and must remain attached to the session target.
  if (left && right && /^\d+(?:\.\d+)?$/.test(right)) return null;

  if (!left || !right) {
    return {
      error: `invalid remote attach target '${trimmed}'`,
      hint: "use: maw attach <node>:<session>",
    };
  }

  return { node: left, sessionName: right };
}

function withSshUser(target: string, user?: string): string {
  const trimmed = target.trim();
  const sshUser = user?.trim();
  if (!trimmed || !sshUser || trimmed.includes("@")) return trimmed;
  return `${sshUser}@${trimmed}`;
}

function peerUrlHost(peer: RemotePeerLike): { host: string; user: string } {
  try {
    const url = new URL(peer.url);
    return { host: url.hostname || peer.url, user: url.username };
  } catch {
    return {
      host: peer.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""),
      user: "",
    };
  }
}

interface SshConfigBlock {
  aliases: string[];
  hostName?: string;
}

function sshConfigPath(): string {
  return process.env.SSH_CONFIG_FILE || join(process.env.HOME || homedir(), ".ssh", "config");
}

function readSshConfigBlocks(): SshConfigBlock[] {
  const path = sshConfigPath();
  if (!existsSync(path)) return [];

  const blocks: SshConfigBlock[] = [];
  let current: SshConfigBlock | null = null;
  let rawConfig = "";
  try {
    rawConfig = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const rawLine of rawConfig.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "host") {
      current = {
        aliases: value.split(/\s+/).filter(alias => alias && !/[?*]/.test(alias)),
      };
      if (current.aliases.length > 0) blocks.push(current);
      continue;
    }

    if (current && key === "hostname") {
      current.hostName = value;
    }
  }

  return blocks;
}

function firstSshConfigAlias(peer: RemotePeerLike, nodeAlias: string, rawHost: string): string | null {
  const blocks = readSshConfigBlocks();
  const candidates = new Set(
    [nodeAlias, peer.alias, peer.node ?? "", rawHost]
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );

  for (const block of blocks) {
    const aliasMatch = block.aliases.find(alias => candidates.has(alias.toLowerCase()));
    if (aliasMatch) return aliasMatch;
  }

  const rawHostLower = rawHost.trim().toLowerCase();
  if (!rawHostLower) return null;
  for (const block of blocks) {
    if (block.hostName?.trim().toLowerCase() === rawHostLower) {
      return block.aliases[0] ?? null;
    }
  }

  return null;
}

function deriveSshAlias(peer: RemotePeerLike, nodeAlias: string): string {
  const explicitUser = peer.sshUser?.trim() || "";
  const explicitAlias = peer.sshAlias?.trim();
  if (explicitAlias) return withSshUser(explicitAlias, explicitUser);

  const parsedUrl = peerUrlHost(peer);
  const configAlias = firstSshConfigAlias(peer, nodeAlias, parsedUrl.host);
  if (configAlias) return withSshUser(configAlias, explicitUser);

  let host = peer.sshHost?.trim() || "";
  let user = explicitUser;
  if (!host) {
    host = parsedUrl.host;
    user = user || parsedUrl.user;
  }

  if (!user && peer.node && peer.node !== nodeAlias) user = nodeAlias;
  if (!host) return nodeAlias;
  return user ? `${user}@${host}` : host;
}

function stripFleetAndOracle(name: string): string {
  return name.toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/i, "");
}

function legacyDashlessMatch(name: string, target: string): boolean {
  const t = target.toLowerCase();
  if (!t.includes("-")) return false;
  return stripFleetAndOracle(name).replace(/-/g, "") === stripFleetAndOracle(t).replace(/-/g, "");
}

/**
 * Try every reasonable name comparison: exact, slot-suffix
 * (`-${target}`), and dash-trimmed stem. Matches the conventions
 * established by sleep/done resolvers.
 *
 * #1342 — when `fuzzy` is true, also accept a case-insensitive substring
 * match (`n.includes(t)`). This is the second-pass mode used by
 * `cmdAttach` AFTER `maw wake <input>` has succeeded: wake fuzzy-resolved
 * the input (e.g. "wind" → "Somwind-oracle" → session "01-Somwind") but
 * doesn't surface the resolved name structurally, so the original input no
 * longer matches the freshly-created session under strict rules. Wake's
 * success implies a fuzzy match exists; loosening the comparator finds it.
 *
 * Strict mode (default) is preserved for every other caller — fuzzy is
 * opt-in and only enabled on the post-wake re-resolve callsite.
 */
function nameMatches(name: string, target: string, fuzzy: boolean = false): boolean {
  const n = name.toLowerCase();
  const t = target.toLowerCase();
  if (n === t || n.endsWith(`-${t}`) || n === `${t}-oracle` || n.endsWith(`-${t}-oracle`) || stripDash(n) === stripDash(t) || legacyDashlessMatch(n, t)) return true;
  if (fuzzy && t.length > 0 && n.includes(t)) return true;
  return false;
}

function windowMatchesOracle(windowName: string, target: string): boolean {
  const n = windowName.toLowerCase();
  const t = target.toLowerCase();
  return n === t || n === `${t}-oracle` || n.endsWith(`-${t}-oracle`);
}

function exactWindowName(session: SessionLike, target: string): string | undefined {
  const t = target.toLowerCase();
  return session.windows.find(w => w.name.toLowerCase() === t)?.name;
}

function runningMatchFor(
  session: SessionLike,
  target: string,
  fuzzy: boolean,
  preferOracleWindow: boolean = false,
): { session: SessionLike; windowName?: string } | null {
  // #1911 — when preferOracleWindow is set, look up the oracle-named window
  // in this session so callers can build a `session:window` attach target
  // that doesn't depend on which tmux window happened to be last-active.
  // Default (false) preserves the legacy behavior for non-attach callers
  // (capture, follow) whose tests assert on the bare `{ tier:1, sessionName }` shape.
  const oracleWindow = preferOracleWindow
    ? session.windows.find(w => windowMatchesOracle(w.name, target))
    : undefined;

  if (nameMatches(session.name, target, fuzzy)) {
    return oracleWindow ? { session, windowName: oracleWindow.name } : { session };
  }
  const windowName = exactWindowName(session, target);
  if (windowName) return { session, windowName };
  if (oracleWindow) return { session, windowName: oracleWindow.name };
  if (session.windows.some(w => windowMatchesOracle(w.name, target))) return { session };
  return null;
}

function isNumberedFleetStyleSessionName(name: string): boolean {
  return /^\d+-/.test(name);
}

function isFleetRegisteredSession(session: SessionLike, fleet: FleetLike[]): boolean {
  const sessionName = session.name.toLowerCase();
  return fleet.some(entry => entry.name.toLowerCase() === sessionName);
}

function preferredTrustedRunningMatch(
  matches: Array<{ session: SessionLike; windowName?: string }>,
  fleet: FleetLike[],
): { session: SessionLike; windowName?: string } | null {
  const fleetRegistered = matches.filter(match => isFleetRegisteredSession(match.session, fleet));
  if (fleetRegistered.length === 1) return fleetRegistered[0];

  // Fleet-created sessions use a numeric slot prefix (`77-mawjs`). If one live
  // numbered match is competing only with orphan/ad-hoc suffix matches
  // (`cnx-mawjs`), trust the fleet-style session instead of surfacing a false
  // ambiguity (#1895). Multiple numbered matches stay ambiguous.
  const numbered = matches.filter(match => isNumberedFleetStyleSessionName(match.session.name));
  if (numbered.length === 1) return numbered[0];

  return null;
}

async function listFederatedRemoteSessions(): Promise<RemoteSessionNodeLike[]> {
  const [{ resolveAllPeers }, { fetchPeerPayload }] = await Promise.all([
    import("../ls/internal/peer-resolve"),
    import("../ls/internal/peer-call"),
  ]);
  const peers = resolveAllPeers();
  return await Promise.all(peers.map(async (peer) => {
    const payload = await fetchPeerPayload(peer, 2000);
    return {
      ...peer,
      // Keep the configured peer alias for attach routing/ssh derivation even
      // when the remote /api/ls payload identifies itself by a different node.
      alias: peer.alias,
      node: payload.node ?? peer.node,
      url: peer.url,
      sessions: payload.error ? [] : (payload.sessions ?? []),
      ...(payload.error ? { error: payload.error } : {}),
    };
  }));
}

function tier3Result(node: RemoteSessionNodeLike, sessionName: string, ambiguousCandidates?: string[]): Extract<ResolveResult, { tier: 3 }> {
  const alias = node.alias;
  return {
    tier: 3,
    node: alias,
    sessionName,
    peerUrl: node.url,
    sshAlias: deriveSshAlias(node, alias),
    ...(ambiguousCandidates && ambiguousCandidates.length > 1 ? { ambiguousCandidates } : {}),
  };
}

async function remoteMatchFor(target: string, deps: ResolveDeps): Promise<Extract<ResolveResult, { tier: 3 }> | null> {
  const nodes = await (deps.listRemoteSessions ?? listFederatedRemoteSessions)();
  const matches: Array<{ node: RemoteSessionNodeLike; session: SessionLike }> = [];

  for (const node of nodes) {
    if (node.error) continue;
    for (const session of node.sessions || []) {
      if (isInfrastructureChannelSessionName(session.name, target)) continue;
      if (runningMatchFor(session, target, true)) matches.push({ node, session });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return tier3Result(matches[0].node, matches[0].session.name);

  const exactSessionMatches = matches.filter(
    match => match.session.name.toLowerCase() === target.toLowerCase(),
  );
  if (exactSessionMatches.length === 1) {
    return tier3Result(exactSessionMatches[0].node, exactSessionMatches[0].session.name);
  }

  const candidates = matches.map(match => `${match.node.alias}:${match.session.name}`);
  return tier3Result(matches[0].node, matches[0].session.name, candidates);
}

export async function resolveAttachTarget(
  target: string,
  deps: ResolveDeps,
  opts: { fuzzy?: boolean; federation?: boolean; preferOracleWindow?: boolean } = {},
): Promise<ResolveResult> {
  const explicitPeerTarget = parseExplicitPeerAttachTarget(target);
  if (explicitPeerTarget && "error" in explicitPeerTarget) {
    return { tier: "error", error: explicitPeerTarget.error, hint: explicitPeerTarget.hint };
  }
  if (explicitPeerTarget) {
    const peer = await (deps.resolvePeer ?? resolveConfiguredPeer)(explicitPeerTarget.node);
    if (!peer) {
      return {
        tier: "error",
        error: `peer '${explicitPeerTarget.node}' not found — check maw peers list`,
      };
    }
    return {
      tier: 3,
      node: explicitPeerTarget.node,
      sessionName: explicitPeerTarget.sessionName,
      peerUrl: peer.url,
      sshAlias: deriveSshAlias(peer, explicitPeerTarget.node),
    };
  }

  target = normalizeAttachQuery(target);
  const fuzzy = Boolean(opts.fuzzy);
  const preferOracleWindow = Boolean(opts.preferOracleWindow);
  const sessions = (await deps.listSessions())
    .filter(s => !isInfrastructureChannelSessionName(s.name, target));

  // Tier 1 — live tmux session/window matches.
  const runningMatches = sessions
    .map(s => runningMatchFor(s, target, fuzzy, preferOracleWindow))
    .filter((s): s is { session: SessionLike; windowName?: string } => Boolean(s));
  if (runningMatches.length === 1) {
    const match = runningMatches[0];
    return {
      tier: 1,
      sessionName: match.session.name,
      ...(match.windowName ? { windowName: match.windowName } : {}),
    };
  }
  if (runningMatches.length > 1) {
    const exactSessionMatches = runningMatches.filter(
      match => match.session.name.toLowerCase() === target.toLowerCase(),
    );
    if (exactSessionMatches.length === 1) {
      const match = exactSessionMatches[0];
      return {
        tier: 1,
        sessionName: match.session.name,
        ...(match.windowName ? { windowName: match.windowName } : {}),
      };
    }
    const trustedMatch = preferredTrustedRunningMatch(runningMatches, deps.loadFleet());
    if (trustedMatch) {
      return {
        tier: 1,
        sessionName: trustedMatch.session.name,
        ...(trustedMatch.windowName ? { windowName: trustedMatch.windowName } : {}),
      };
    }
    return {
      tier: 1,
      sessionName: runningMatches[0].session.name,
      ambiguousCandidates: runningMatches.map(s => s.session.name),
    };
  }

  // Tier 1b — fleet window/repo aliases can still resolve custom sessions
  // when the visible tmux window name is generic but metadata carries the
  // oracle repo (#1807/#1812). Keep this after normal matching so a canonical
  // session plus an alias session is surfaced as ambiguity, not silently
  // narrowed to the alias.
  const windowAlias = resolveFleetWindowSessionTarget(target, sessions);
  if (windowAlias.kind === "fuzzy" || windowAlias.kind === "exact") {
    return { tier: 1, sessionName: windowAlias.match.name };
  }
  if (windowAlias.kind === "ambiguous") {
    return {
      tier: 1,
      sessionName: windowAlias.candidates[0].name,
      ambiguousCandidates: windowAlias.candidates.map(s => s.name),
    };
  }

  // Tier 2 — fleet-registered, sleeping.
  const fleet = deps.loadFleet();
  const fleetMatches = fleet.filter(f => nameMatches(f.name, target, fuzzy));
  if (fleetMatches.length === 1) {
    return { tier: 2, fleetName: fleetMatches[0].name };
  }
  if (fleetMatches.length > 1) {
    return {
      tier: 2,
      fleetName: fleetMatches[0].name,
      ambiguousCandidates: fleetMatches.map(f => f.name),
    };
  }

  // Tier 3 — optional federation precheck before the caller falls through to
  // `maw wake`, whose final fallback can run slow GitHub/org scans (#1878).
  // Other resolver consumers (capture/follow) stay local-only unless they opt in.
  if (opts.federation) {
    const remote = await remoteMatchFor(target, deps);
    if (remote) return remote;
  }

  return null;
}
