import type { MawConfig, PeerConfig } from "../../config";
import type {
  DiscoveryError,
  DiscoveryResponse,
  DiscoveryRow,
} from "../../vendor/mpr-plugins/peers/discovered";

export type PeerSourceMode = "config" | "scout" | "both";
export type PeerSourceKind = "config" | "scout";

export interface PeerTarget {
  name?: string;
  url: string;
  source: PeerSourceKind;
  node?: string;
  oracle?: string;
}

export interface PeerSourceResult {
  mode: PeerSourceMode;
  peers: PeerTarget[];
  warnings: string[];
}

export interface PeerSourceDeps {
  fetchDiscoveries?: (opts?: { all?: boolean; limit?: number }) => Promise<DiscoveryResponse | DiscoveryError>;
}

export function parsePeerSourceMode(value: unknown, fallback: PeerSourceMode = "both"): PeerSourceMode | null {
  if (value == null || value === "") return fallback;
  if (value === "config" || value === "scout" || value === "both") return value;
  return null;
}

export function configuredPeerTargets(config: MawConfig): PeerTarget[] {
  const flat = (config.peers ?? []).map((url) => ({ url, source: "config" as const }));
  const named = (config.namedPeers ?? []).map((peer) => ({
    name: peer.name,
    url: peer.url,
    source: "config" as const,
  }));
  return dedupePeerTargets([...flat, ...named]);
}

export async function resolvePeerSources(
  config: MawConfig,
  mode: PeerSourceMode = "both",
  deps: PeerSourceDeps = {},
): Promise<PeerSourceResult> {
  const configPeers = mode === "scout" ? [] : configuredPeerTargets(config);
  const warnings: string[] = [];
  let scoutPeers: PeerTarget[] = [];

  if (mode === "scout" || mode === "both") {
    const fetchDiscoveries = deps.fetchDiscoveries ?? defaultFetchDiscoveries;
    const result = await fetchDiscoveries({ all: true });
    if (result.ok) {
      scoutPeers = result.peers.flatMap((peer) => {
        const target = discoveredPeerTarget(peer);
        return target ? [target] : [];
      });
    } else {
      warnings.push(formatScoutWarning(result));
    }
  }

  return {
    mode,
    peers: dedupePeerTargets(mode === "scout" ? scoutPeers : [...configPeers, ...scoutPeers]),
    warnings,
  };
}

export function peerTargetsToConfigs(peers: PeerTarget[]): PeerConfig[] {
  return peers.map((peer) => ({
    name: peer.name ?? peer.node ?? hostLabel(peer.url),
    url: peer.url,
  }));
}

export function formatPeerSources(result: PeerSourceResult): string {
  if (result.peers.length === 0) {
    return result.warnings.length > 0
      ? `no peers discovered or configured\n${result.warnings.map((w) => `warning: ${w}`).join("\n")}`
      : "no peers discovered or configured";
  }

  const header = ["source", "name", "node", "oracle", "url"];
  const rows = result.peers.map((peer) => [
    peer.source,
    peer.name ?? "-",
    peer.node ?? "-",
    peer.oracle ?? "-",
    peer.url,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function dedupePeerTargets(peers: PeerTarget[]): PeerTarget[] {
  const seen = new Set<string>();
  const merged: PeerTarget[] = [];
  for (const peer of peers) {
    const key = peerKey(peer.url);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(peer);
  }
  return merged;
}

function discoveredPeerTarget(peer: DiscoveryRow): PeerTarget | null {
  const url = peer.locators.find(isHttpUrl);
  if (!url) return null;
  return {
    name: peer.node || peer.host || undefined,
    url,
    source: "scout",
    node: peer.node || undefined,
    oracle: peer.oracle || undefined,
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function peerKey(url: string): string {
  return url.replace(/\/+$/, "");
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function formatScoutWarning(result: DiscoveryError): string {
  return `scout unavailable (${result.error}${result.hint ? `: ${result.hint}` : ""})`;
}

async function defaultFetchDiscoveries(opts?: { all?: boolean; limit?: number }): Promise<DiscoveryResponse | DiscoveryError> {
  const { fetchDiscoveries } = await import("../../vendor/mpr-plugins/peers/discovered");
  return fetchDiscoveries(opts);
}
