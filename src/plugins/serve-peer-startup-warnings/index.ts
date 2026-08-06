import { loadConfig as defaultLoadConfig, type MawConfig } from "../../config";
import { resolveBindHost as defaultResolveBindHost } from "../../core/bind-host";
import { loadPeers as defaultLoadPeers } from "../../lib/peers/store";
import { warnDuplicatesAtBoot as defaultWarnDuplicatesAtBoot } from "../../lib/peers/duplicate-detect";

type ServeLog = { warn?: (...args: unknown[]) => void };

type ServePeerStartupWarningsContext = {
  port?: number;
  log?: ServeLog;
};

type PeerStore = { peers: unknown };

type ServePeerStartupWarningsDeps = {
  loadConfig: () => MawConfig;
  resolveBindHost: typeof defaultResolveBindHost;
  loadPeers: () => PeerStore;
  warnDuplicatesAtBoot: typeof defaultWarnDuplicatesAtBoot;
};

const defaultDeps: ServePeerStartupWarningsDeps = {
  loadConfig: defaultLoadConfig,
  resolveBindHost: defaultResolveBindHost,
  loadPeers: defaultLoadPeers,
  warnDuplicatesAtBoot: defaultWarnDuplicatesAtBoot,
};

const startupPeerWarningsLogged = new Set<string>();

export function resetServePeerStartupWarningStateForTests(): void {
  startupPeerWarningsLogged.clear();
}

export function warnMissingFederationTokenOnce(
  port: number,
  log: ServeLog,
  key = "missing-federation-token",
): boolean {
  if (startupPeerWarningsLogged.has(key)) return false;
  startupPeerWarningsLogged.add(key);
  log.warn?.(`\x1b[31m⚠ WARNING: peers configured but no federationToken set!\x1b[0m`);
  log.warn?.(`\x1b[31m  Port ${port} is exposed to network WITHOUT authentication.\x1b[0m`);
  log.warn?.(`\x1b[31m  Add "federationToken" (min 16 chars) to maw.config.json\x1b[0m`);
  return true;
}

export function warnMissingFederationTokenIfNeeded(
  config: MawConfig,
  port: number,
  log: ServeLog,
  deps: Pick<ServePeerStartupWarningsDeps, "resolveBindHost"> = defaultDeps,
): boolean {
  const heuristic = deps.resolveBindHost(config);
  const hasPeers = heuristic.reason !== null;
  if (!hasPeers || config.federationToken) return false;
  return warnMissingFederationTokenOnce(port, log);
}

export function warnDuplicatePeerIdentityAtBoot(
  config: MawConfig,
  log: ServeLog,
  deps: Pick<ServePeerStartupWarningsDeps, "loadPeers" | "warnDuplicatesAtBoot"> = defaultDeps,
): boolean {
  try {
    const peers = deps.loadPeers().peers;
    const local = config.node ? { oracle: config.oracle ?? "mawjs", node: config.node } : undefined;
    deps.warnDuplicatesAtBoot({ peers, local, log: (message: string) => log.warn?.(message) });
    return true;
  } catch (e: any) {
    // Never fail boot on a dedup-scan glitch — log and move on.
    log.warn?.(`[startup] peer dedup scan skipped: ${e?.message || e}`);
    return false;
  }
}

export function runServePeerStartupWarnings(
  ctx: ServePeerStartupWarningsContext = {},
  deps: Partial<ServePeerStartupWarningsDeps> = {},
): { ok: true; missingTokenWarned: boolean; duplicateScanRan: boolean } {
  const d = { ...defaultDeps, ...deps };
  const log = ctx.log ?? {};
  const config = d.loadConfig();
  const port = ctx.port ?? config.port;
  const missingTokenWarned = warnMissingFederationTokenIfNeeded(config, port, log, d);
  const duplicateScanRan = warnDuplicatePeerIdentityAtBoot(config, log, d);
  return { ok: true, missingTokenWarned, duplicateScanRan };
}

export function serve(
  ctx: ServePeerStartupWarningsContext = {},
  deps?: Partial<ServePeerStartupWarningsDeps>,
): { ok: true; missingTokenWarned: boolean; duplicateScanRan: boolean } {
  return runServePeerStartupWarnings(ctx, deps);
}

export default serve;
