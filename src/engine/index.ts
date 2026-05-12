import { tmux } from "../core/transport/tmux";
import { registerBuiltinHandlers } from "../core/runtime/handlers";
import { sendBusyAgents } from "./capture";
import { StatusDetector } from "./status";
import { getAggregatedSessions, getPeers } from "../core/transport/peers";
import { cfgLimit } from "../config";
import type { FeedEvent } from "../lib/feed";
import type { MawWS, Handler } from "../core/types";
import type { Session } from "../core/transport/ssh";
import type { TransportRouter } from "../core/transport/transport";
import { startIntervals, stopIntervals, sendInitialSessions, type EngineIntervalState } from "./engine-intervals";
import { handleCrashedAgents } from "./engine-crash";
import type { SessionInfo } from "./types";

export class MawEngine {
  private clients = new Set<MawWS>();
  private handlers = new Map<string, Handler>();
  private lastContent = new Map<MawWS, string>();
  private lastPreviews = new Map<MawWS, Map<string, string>>();
  private sessionCache = { sessions: [] as SessionInfo[], json: "" };
  private status = new StatusDetector();

  private peerSessionsCache: (Session & { source?: string })[] = [];

  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private sessionInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private teamsInterval: ReturnType<typeof setInterval> | null = null;
  private peerInterval: ReturnType<typeof setInterval> | null = null;
  private crashCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastTeamsJson = { value: "" };
  private feedUnsub: (() => void) | null = null;
  private transportRouter: TransportRouter | null = null;

  private feedBuffer: FeedEvent[];
  private feedListeners: Set<(event: FeedEvent) => void>;

  constructor({ feedBuffer, feedListeners }: { feedBuffer: FeedEvent[]; feedListeners: Set<(event: FeedEvent) => void> }) {
    this.feedBuffer = feedBuffer;
    this.feedListeners = feedListeners;
    registerBuiltinHandlers(this);
    this.initSessionCache();
  }

  private async initSessionCache() {
    try {
      this.sessionCache.sessions = await tmux.listAll();
      this.sessionCache.json = JSON.stringify({ type: "sessions", sessions: this.sessionCache.sessions });
      console.log(`[engine] session cache initialized: ${this.sessionCache.sessions.length} sessions`);
    } catch {
      console.warn("[engine] session cache init failed — will retry on first WS connect");
    }
  }

  on(type: string, handler: Handler) { this.handlers.set(type, handler); }

  /** Set transport router — route incoming remote messages to local tmux */
  setTransportRouter(router: TransportRouter) {
    this.transportRouter = router;
    router.onMessage(async (msg) => {
      const { findWindow, sendKeys, listSessions } = await import("../core/transport/ssh");
      const sessions = this.sessionCache.sessions.length > 0
        ? this.sessionCache.sessions
        : await listSessions().catch(() => []);
      const baseName = msg.to.replace(/-oracle$/, "");
      const target = findWindow(sessions, msg.to) || findWindow(sessions, baseName);
      if (target) {
        await sendKeys(target, msg.body);
        console.log(`[transport] ${msg.transport}: ${msg.from} → ${target}`);
      } else {
        console.log(`[transport] no target for "${msg.to}" (${sessions.length} sessions)`);
      }
    });

    this.feedListeners.add((event) => {
      router.publishFeed(event).catch(() => {});
    });
  }

  // --- WebSocket lifecycle ---

  handleOpen(ws: MawWS) {
    this.clients.add(ws);
    this.startIntervals();
    sendInitialSessions(ws, this.getIntervalState()).catch(() => {});
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedBuffer.slice(-cfgLimit("feedHistory")) }));
  }

  handleMessage(ws: MawWS, msg: string | Buffer) {
    try {
      const data = JSON.parse(msg as string);
      const handler = this.handlers.get(data.type);
      if (handler) handler(ws, data, this);
    } catch (err) {
      console.error("[engine] handleMessage error:", err);
    }
  }

  handleClose(ws: MawWS) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
  }

  // --- Public (handlers use these) ---

  async pushCapture(ws: MawWS) {
    const { pushCapture } = await import("./capture");
    return pushCapture(ws, this.lastContent);
  }
  async pushPreviews(ws: MawWS) {
    const { pushPreviews } = await import("./capture");
    return pushPreviews(ws, this.lastPreviews);
  }

  // --- Intervals (delegate to engine-intervals) ---

  private getIntervalState(): EngineIntervalState {
    return {
      clients: this.clients,
      lastContent: this.lastContent,
      lastPreviews: this.lastPreviews,
      sessionCache: this.sessionCache,
      peerSessionsCache: this.peerSessionsCache,
      status: this.status,
      lastTeamsJson: this.lastTeamsJson,
      feedListeners: this.feedListeners,
      feedBuffer: this.feedBuffer,
      transportRouter: this.transportRouter,
      captureInterval: this.captureInterval,
      sessionInterval: this.sessionInterval,
      previewInterval: this.previewInterval,
      statusInterval: this.statusInterval,
      teamsInterval: this.teamsInterval,
      peerInterval: this.peerInterval,
      crashCheckInterval: this.crashCheckInterval,
      feedUnsub: this.feedUnsub,
    };
  }

  private syncIntervalState(state: EngineIntervalState) {
    this.peerSessionsCache = state.peerSessionsCache;
    this.sessionCache = state.sessionCache;
    this.captureInterval = state.captureInterval;
    this.sessionInterval = state.sessionInterval;
    this.previewInterval = state.previewInterval;
    this.statusInterval = state.statusInterval;
    this.teamsInterval = state.teamsInterval;
    this.peerInterval = state.peerInterval;
    this.crashCheckInterval = state.crashCheckInterval;
    this.feedUnsub = state.feedUnsub;
  }

  private startIntervals() {
    const state = this.getIntervalState();
    startIntervals(state, () => this.handleCrashedAgents());
    this.syncIntervalState(state);
  }

  private stopIntervals() {
    const state = this.getIntervalState();
    stopIntervals(state);
    this.syncIntervalState(state);
  }

  /** Auto-restart crashed agents if config.autoRestart is enabled. */
  private async handleCrashedAgents() {
    await handleCrashedAgents(this.status, this.sessionCache.sessions, this.clients, this.feedListeners);
  }
}
