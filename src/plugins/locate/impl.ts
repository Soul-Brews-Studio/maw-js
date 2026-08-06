/**
 * maw locate — diagnostic "where is this oracle?" command.
 *
 * Inspired by multi-agent-workflow-kit's `maw warp` (kit uses a bash
 * function to cd the parent shell into a worktree). mawjs is a binary,
 * so we can't cd the caller — instead we PRINT location info across
 * the oracle's full information space: ghq repo, ψ/ presence, tmux
 * session, fleet config, federation node.
 *
 * Use `cd $(maw locate mawjs --path)` if you want the kit's warp
 * behavior — the shell eval does the cd.
 */

import { existsSync } from "fs";
import { join } from "path";
import {
  ghqFind,
  listSessions,
  loadConfig,
  loadFleetEntries,
  loadManifestCached,
  resolveSessionTarget,
  UserError,
  type FleetEntry,
  type OracleManifestEntry,
} from "maw-js/sdk";
import { fetchPeerPayload, type PeerSession } from "../ls/internal/peer-call";
import { resolveAllPeers } from "../ls/internal/peer-resolve";

export interface LocateOpts {
  path?: boolean;
  json?: boolean;
}

interface LocateResult {
  name: string;
  repoPath: string | null;
  hasPsi: boolean;
  sessionName: string | null;
  windowCount: number;
  fleetConfigPath: string | null;
  federationNode: string | null;
  inAgentsConfig: boolean;
  federation: LocateFederationHit[];
  manifestEntry: OracleManifestEntry | null;
}

interface LocateFederationHit {
  alias: string;
  node: string | null;
  url: string | null;
  sessionName: string;
  windowCount: number;
}

function normalizedNames(name: string): string[] {
  const raw = name.trim().toLowerCase();
  const unnumbered = raw.replace(/^\d+-/, "");
  return [...new Set([
    raw,
    raw.replace(/-oracle$/, ""),
    unnumbered,
    unnumbered.replace(/-oracle$/, ""),
  ].filter(Boolean))];
}

function peerSessionMatches(session: PeerSession, oracle: string): boolean {
  const wanted = new Set(normalizedNames(oracle));
  const sessionNames = normalizedNames(session.name);
  if (sessionNames.some(name => wanted.has(name))) return true;
  return (session.windows ?? []).some((w) => normalizedNames(w.name).some(name => wanted.has(name)));
}

async function findFederationHits(oracle: string): Promise<LocateFederationHit[]> {
  const peers = resolveAllPeers();
  if (!peers.length) return [];

  const payloads = await Promise.all(peers.map(peer => fetchPeerPayload(peer, 2000)));
  const hits: LocateFederationHit[] = [];
  for (const payload of payloads) {
    if (payload.error) continue;
    for (const session of payload.sessions ?? []) {
      if (!peerSessionMatches(session, oracle)) continue;
      hits.push({
        alias: payload.alias ?? payload.node ?? "peer",
        node: payload.node ?? null,
        url: payload.url ?? null,
        sessionName: session.name,
        windowCount: session.windows?.length ?? 0,
      });
    }
  }
  return hits;
}

function fleetEntryMatches(entry: FleetEntry, names: Set<string>): boolean {
  const fileBase = entry.file.replace(/\.json$/, "");
  const sessionName = entry.session?.name;
  const entryNames = [fileBase, entry.groupName, sessionName].filter(Boolean) as string[];
  return entryNames.some(name => names.has(name));
}

function findFleetConfigPath(oracle: string, sessionName: string | null): string | null {
  const names = new Set([oracle, `${oracle}-oracle`]);
  if (sessionName) names.add(sessionName);

  try {
    for (const entry of loadFleetEntries()) {
      if (fleetEntryMatches(entry, names)) return entry.path ?? null;
    }
  } catch {
    /* fleet configs are diagnostic-only for locate */
  }

  return null;
}

function lookupManifestEntry(oracle: string): OracleManifestEntry | undefined {
  try {
    const manifest = loadManifestCached();
    const stripped = oracle.replace(/-oracle$/, "");
    return (
      manifest.find((entry) => entry.name === oracle) ||
      (stripped !== oracle ? manifest.find((entry) => entry.name === stripped) : undefined)
    );
  } catch {
    return undefined;
  }
}

async function gatherInfo(oracle: string, opts: { scanFederation?: boolean } = {}): Promise<LocateResult> {
  // ghq repo path — try `<name>-oracle` suffix first (canonical), then bare name
  const repoPath =
    (await ghqFind(`/${oracle}-oracle`)) ?? (await ghqFind(`/${oracle}`));

  // ψ/ presence
  const hasPsi = repoPath ? existsSync(join(repoPath, "ψ")) : false;

  // tmux session — use the alpha.77 suffix-preferred resolver so bare
  // name resolves to the `NN-name` canonical session, not a `name-view`.
  let sessionName: string | null = null;
  let windowCount = 0;
  try {
    const sessions = await listSessions();
    const r = resolveSessionTarget(oracle, sessions);
    if (r.kind === "exact" || r.kind === "fuzzy") {
      sessionName = r.match.name;
      windowCount = r.match.windows?.length ?? 0;
    }
  } catch {
    /* tmux not running — leave session null */
  }

  // Fleet config — use the migrated fleet loader so XDG state entries
  // shadow legacy entries and report the exact source path.
  const fleetConfigPath = findFleetConfigPath(oracle, sessionName);

  // Manifest fallback — includes oracles.json entries that do not have a
  // local repo, tmux session, or fleet config yet. This keeps `maw locate`
  // aligned with `maw oracle list` for registry-only oracles.
  const manifestEntry = lookupManifestEntry(oracle);

  // Federation — config.agents map + node
  const config = loadConfig();
  const agents = config.agents ?? {};
  const inAgentsConfig = oracle in agents;
  const federationNode = inAgentsConfig
    ? agents[oracle]!
    : sessionName
      ? (config.node ?? "local")
      : (manifestEntry?.node ?? config.node ?? null);

  const federation = opts.scanFederation === false ? [] : await findFederationHits(oracle);

  return {
    name: oracle,
    repoPath: repoPath ?? manifestEntry?.localPath ?? null,
    hasPsi: repoPath ? hasPsi : (manifestEntry?.hasPsi ?? false),
    sessionName,
    windowCount,
    fleetConfigPath,
    federationNode,
    inAgentsConfig,
    federation,
    manifestEntry: manifestEntry ?? null,
  };
}

export async function cmdLocate(oracle: string | undefined, opts: LocateOpts = {}): Promise<void> {
  if (!oracle) {
    console.error("usage: maw locate <oracle> [--path | --json]");
    console.error("  e.g. maw locate mawjs");
    throw new UserError("missing oracle name");
  }

  const info = await gatherInfo(oracle, { scanFederation: !opts.path });

  // Nothing found at all → not-found error (mirrors alpha.75 oracle-about fix)
  if (!info.repoPath && !info.sessionName && !info.fleetConfigPath && info.federation.length === 0 && !info.manifestEntry) {
    throw new UserError(`no oracle named '${oracle}' — try: maw oracle ls`);
  }

  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (opts.path) {
    // --path emits ONE clean line for shell substitution: cd $(maw locate X --path)
    if (!info.repoPath) {
      throw new UserError(
        `no repo path for '${oracle}' (session: ${info.sessionName ?? "none"}, fleet: ${info.fleetConfigPath ? "yes" : "no"})`,
      );
    }
    console.log(info.repoPath);
    return;
  }

  // Default: human-readable multi-line summary. Omit missing fields rather
  // than faking values (per #390.2 — fake-success is worse than missing info).
  console.log(`\n📍 ${oracle}`);
  if (info.repoPath) {
    console.log(`   repo:     ${info.repoPath}`);
    console.log(`   ψ/:       ${info.hasPsi ? "present" : "missing"}`);
  }
  if (info.sessionName) {
    console.log(`   session:  ${info.sessionName} (${info.windowCount} window${info.windowCount === 1 ? "" : "s"})`);
  }
  if (info.fleetConfigPath) {
    console.log(`   fleet:    ${info.fleetConfigPath}`);
  }
  if (info.manifestEntry) {
    console.log(`   source:   ${info.manifestEntry.sources.join(", ")}`);
    if (info.manifestEntry.repo && !info.repoPath) {
      console.log(`   repo:     ${info.manifestEntry.repo}`);
    }
    if (info.manifestEntry.hasFleetConfig && !info.fleetConfigPath) {
      console.log("   fleet:    known (manifest)");
    }
  }
  if (info.federationNode) {
    const suffix = info.inAgentsConfig
      ? " (from config.agents)"
      : info.sessionName
        ? " (this node)"
        : info.manifestEntry?.node
          ? " (from manifest)"
          : " (this node)";
    console.log(`   node:     ${info.federationNode}${suffix}`);
  }
  for (const hit of info.federation) {
    const label = hit.node ?? hit.alias;
    const location = hit.url ? ` (${hit.url})` : "";
    console.log(`   remote:   ${label}:${hit.sessionName}${location} (${hit.windowCount} window${hit.windowCount === 1 ? "" : "s"})`);
  }
  console.log();
}
