import { pushCapture, pushPreviews, broadcastSessions, sendBusyAgents } from "./capture";
import { broadcastTeams } from "./teams";
import { getAggregatedSessions, getPeers } from "../core/transport/peers";
import { loadConfig, cfgInterval, cfgLimit } from "../config";
import type { FeedEvent } from "../lib/feed";
import type { MawWS } from "../core/types";
import type { Session } from "../core/transport/ssh";
import type { TransportRouter } from "../core/transport/transport";
import type { StatusDetector } from "./status";
import { tmux } from "../core/transport/tmux";
import type { SessionInfo } from "./types";

export interface EngineIntervalState {
  clients: Set<MawWS>;
  lastContent: Map<MawWS, string>;
  lastPreviews: Map<MawWS, Map<string, string>>;
  sessionCache: { sessions: SessionInfo[]; json: string };
  peerSessionsCache: (Session & { source?: string })[];
  status: StatusDetector;
  lastTeamsJson: { value: string };
  feedListeners: Set<(event: FeedEvent) => void>;
  feedBuffer: FeedEvent[];
  transportRouter: TransportRouter | null;
  captureInterval: ReturnType<typeof setInterval> | null;
  sessionInterval: ReturnType<typeof setInterval> | null;
  previewInterval: ReturnType<typeof setInterval> | null;
  statusInterval: ReturnType<typeof setInterval> | null;
  teamsInterval: ReturnType<typeof setInterval> | null;
  peerInterval: ReturnType<typeof setInterval> | null;
  crashCheckInterval: ReturnType<typeof setInterval> | null;
  feedUnsub: (() => void) | null;
}

/** Start all polling intervals on first WS connect. No-op if already running. */
export function startIntervals(
  state: EngineIntervalState,
  onCrash: () => void,
): void {
  if (state.captureInterval) return;

  state.captureInterval = setInterval(() => {
    for (const ws of state.clients) pushCapture(ws, state.lastContent);
  }, cfgInterval("capture"));

  state.sessionInterval = setInterval(async () => {
    state.sessionCache.sessions = await broadcastSessions(state.clients, state.sessionCache, state.peerSessionsCache);
  }, cfgInterval("sessions"));

  state.peerInterval = setInterval(async () => {
    if (getPeers().length === 0) { state.peerSessionsCache = []; return; }
    state.peerSessionsCache = await getAggregatedSessions([]);
  }, cfgInterval("peerFetch"));

  state.previewInterval = setInterval(() => {
    for (const ws of state.clients) pushPreviews(ws, state.lastPreviews);
  }, cfgInterval("preview"));

  state.statusInterval = setInterval(async () => {
    await state.status.detect(state.sessionCache.sessions, state.clients, state.feedListeners);
    if (state.transportRouter) {
      const config = loadConfig();
      const host = config.node ?? "local";
      for (const s of state.sessionCache.sessions) {
        for (const w of s.windows) {
          const target = `${s.name}:${w.index}`;
          const st = state.status.getStatus(target);
          if (st) {
            state.transportRouter.publishPresence({
              oracle: w.name.replace(/-oracle$/, ""),
              host,
              status: st as "busy" | "ready" | "idle" | "crashed" | "offline",
              timestamp: Date.now(),
            }).catch(() => {});
          }
        }
      }
    }
  }, cfgInterval("status"));

  state.teamsInterval = setInterval(() => {
    broadcastTeams(state.clients, state.lastTeamsJson);
  }, cfgInterval("teams"));

  state.crashCheckInterval = setInterval(onCrash, cfgInterval("crashCheck"));

  const listener = (event: FeedEvent) => {
    const msg = JSON.stringify({ type: "feed", event });
    for (const ws of state.clients) ws.send(msg);
  };
  state.feedListeners.add(listener);
  state.feedUnsub = () => state.feedListeners.delete(listener);
}

/** Stop all polling intervals when last WS client disconnects. No-op if clients remain. */
export function stopIntervals(state: EngineIntervalState): void {
  if (state.clients.size > 0) return;
  if (state.captureInterval) { clearInterval(state.captureInterval); state.captureInterval = null; }
  if (state.sessionInterval) { clearInterval(state.sessionInterval); state.sessionInterval = null; }
  if (state.previewInterval) { clearInterval(state.previewInterval); state.previewInterval = null; }
  if (state.statusInterval) { clearInterval(state.statusInterval); state.statusInterval = null; }
  if (state.teamsInterval) { clearInterval(state.teamsInterval); state.teamsInterval = null; }
  if (state.peerInterval) { clearInterval(state.peerInterval); state.peerInterval = null; }
  if (state.crashCheckInterval) { clearInterval(state.crashCheckInterval); state.crashCheckInterval = null; }
  if (state.feedUnsub) { state.feedUnsub(); state.feedUnsub = null; }
}

/** Send local + peer sessions to a newly connected WS client. */
export async function sendInitialSessions(
  ws: MawWS,
  state: EngineIntervalState,
): Promise<void> {
  const local = state.sessionCache.sessions.length > 0
    ? state.sessionCache.sessions
    : await tmux.listAll().catch(() => [] as SessionInfo[]);
  state.sessionCache.sessions = local;
  if (state.peerSessionsCache.length === 0 && getPeers().length > 0) {
    state.peerSessionsCache = await getAggregatedSessions([]).catch(() => []);
  }
  const all = state.peerSessionsCache.length > 0
    ? [...local, ...state.peerSessionsCache]
    : local;
  ws.send(JSON.stringify({ type: "sessions", sessions: all }));
  sendBusyAgents(ws, local);
}
