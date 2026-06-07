import { basename } from "path";
import { tmux, type TmuxPane } from "../../core/transport/tmux";
import type { PeerTarget } from "./peer-sources";

export type DiscoverLiveSource = "tmux";

export interface TmuxPaneTargetParts {
  session: string;
  window: string;
  pane: string;
}

export interface DiscoverLivePane extends TmuxPaneTargetParts {
  source: DiscoverLiveSource;
  id: string;
  target: string;
  command?: string;
  title?: string;
  pid?: number;
  cwd?: string;
  lastActivity?: number;
  awake: true;
  matches: string[];
}

export interface PeerTargetWithLive extends PeerTarget {
  awake: boolean;
  liveTargets: string[];
  liveSessions: string[];
}

export interface TmuxLiveStateResult {
  source: DiscoverLiveSource;
  live: DiscoverLivePane[];
  warnings: string[];
}

export interface TmuxLiveStateDeps {
  listPanes?: () => Promise<TmuxPane[]>;
}

export function parseTmuxPaneTarget(target: string): TmuxPaneTargetParts | null {
  const colon = target.indexOf(":");
  const dot = target.lastIndexOf(".");
  if (colon <= 0 || dot <= colon + 1 || dot === target.length - 1) return null;
  return {
    session: target.slice(0, colon),
    window: target.slice(colon + 1, dot),
    pane: target.slice(dot + 1),
  };
}

export async function resolveTmuxLiveState(
  peers: PeerTarget[] = [],
  deps: TmuxLiveStateDeps = {},
): Promise<TmuxLiveStateResult> {
  const listPanes = deps.listPanes ?? (() => tmux.listPanes());
  try {
    const panes = await listPanes();
    const live = panes
      .map((pane) => tmuxPaneToLivePane(pane, peers))
      .sort((a, b) => a.target.localeCompare(b.target));
    return { source: "tmux", live, warnings: [] };
  } catch (error) {
    return {
      source: "tmux",
      live: [],
      warnings: [`tmux unavailable (${errorMessage(error)})`],
    };
  }
}

export function markPeerTargetsLive(peers: PeerTarget[], live: DiscoverLivePane[]): PeerTargetWithLive[] {
  return peers.map((peer) => {
    const peerSignals = normalizedPeerSignals(peer);
    const matching = live.filter((pane) =>
      paneSignals(pane).some((signal) => peerSignals.has(signal))
    );
    return {
      ...peer,
      awake: matching.length > 0,
      liveTargets: matching.map((pane) => pane.target),
      liveSessions: [...new Set(matching.map((pane) => pane.session))],
    };
  });
}

export function formatTmuxLiveState(result: TmuxLiveStateResult): string {
  if (result.live.length === 0) {
    return result.warnings.length > 0
      ? `no live tmux sessions/windows found\n${result.warnings.map((w) => `warning: ${w}`).join("\n")}`
      : "no live tmux sessions/windows found";
  }

  const header = ["source", "session", "window", "pane", "command", "cwd", "matches"];
  const rows = result.live.map((pane) => [
    pane.source,
    pane.session,
    pane.window,
    pane.pane,
    pane.command ?? "-",
    pane.cwd ?? "-",
    pane.matches.length > 0 ? pane.matches.join(",") : "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const lines = [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

function tmuxPaneToLivePane(pane: TmuxPane, peers: PeerTarget[]): DiscoverLivePane {
  const parsed = parseTmuxPaneTarget(pane.target) ?? fallbackTargetParts(pane.target);
  const live: DiscoverLivePane = {
    source: "tmux",
    id: pane.id,
    target: pane.target,
    session: parsed.session,
    window: parsed.window,
    pane: parsed.pane,
    command: emptyToUndefined(pane.command),
    title: emptyToUndefined(pane.title),
    pid: pane.pid,
    cwd: emptyToUndefined(pane.cwd),
    lastActivity: pane.lastActivity,
    awake: true,
    matches: [],
  };
  const liveSignals = paneSignals(live);
  live.matches = peers
    .filter((peer) => {
      const peerSignals = normalizedPeerSignals(peer);
      return liveSignals.some((signal) => peerSignals.has(signal));
    })
    .map((peer) => peer.name ?? peer.node ?? peer.oracle ?? peer.url);
  return live;
}

function fallbackTargetParts(target: string): TmuxPaneTargetParts {
  const session = target.split(":")[0] || target;
  return { session, window: "", pane: "" };
}

function paneSignals(pane: DiscoverLivePane): string[] {
  return [
    pane.session,
    pane.window,
    pane.title,
    pane.cwd ? basename(pane.cwd) : undefined,
  ].flatMap(normalizedAliases);
}

function normalizedPeerSignals(peer: PeerTarget): Set<string> {
  return new Set([
    peer.name,
    peer.node,
    peer.oracle,
  ].flatMap(normalizedAliases));
}

function normalizedAliases(value: string | undefined): string[] {
  const normalized = normalizeSignal(value);
  if (!normalized) return [];
  const aliases = new Set([normalized]);
  aliases.add(normalized.replace(/^\d+-/, ""));
  aliases.add(normalized.replace(/-oracle$/, ""));
  aliases.add(normalized.replace(/^\d+-/, "").replace(/-oracle$/, ""));
  return [...aliases].filter(Boolean);
}

function normalizeSignal(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
