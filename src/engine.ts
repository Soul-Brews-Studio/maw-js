import { capture } from "./ssh";
import { tmux } from "./tmux";
import { registerBuiltinHandlers } from "./handlers";
import { registerEnhancedHandlers } from "./handlers-enhanced";
import { registerOrchestrationHandlers } from "./handlers-orchestration";
import type { FeedTailer } from "./feed-tail";
import type { MawWS, Handler } from "./types";
import { statSync, readFileSync } from "fs";
import { MAW_LOG_PATH, type LogEntry } from "./maw-log";
import { globalContextStore } from "./context-store";
import { globalLaneOrganization } from "./lane-organization";
import { globalStateManager, initializeStateManager } from "./state-manager";

export class MawEngine {
  private clients = new Set<MawWS>();
  private handlers = new Map<string, Handler>();
  private lastContent = new Map<MawWS, string>();
  private lastPreviews = new Map<MawWS, Map<string, string>>();
  private lastSessionsJson = "";
  private cachedSessions: { name: string; windows: { index: number; name: string; active: boolean }[] }[] = [];
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private sessionInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private feedUnsub: (() => void) | null = null;
  private feedTailer: FeedTailer;
  private mawLogInterval: ReturnType<typeof setInterval> | null = null;
  private mawLogOffset = 0;

  // Phase 1: Context store and lane organization
  private lastContextStatsJson = "";
  private lastLaneStatsJson = "";
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor({ feedTailer }: { feedTailer: FeedTailer }) {
    this.feedTailer = feedTailer;
    registerBuiltinHandlers(this);
    registerEnhancedHandlers(this); // Phase 1: Register enhanced handlers
    registerOrchestrationHandlers(this); // Phase 2 & 3: Register orchestration handlers

    // Phase 2: Initialize state manager with auto-save
    initializeStateManager(globalStateManager);

    // Phase 2: Load state on startup (async, non-blocking)
    this.initializeState();
  }

  // Phase 2: Initialize state from file
  private async initializeState() {
    try {
      await globalStateManager.restore();
      console.log("✓ State loaded from file");
    } catch (e: any) {
      console.log("✗ Failed to load state (fresh install):", e.message);
    }
  }

  /** Register a WebSocket message handler */
  on(type: string, handler: Handler) {
    this.handlers.set(type, handler);
  }

  // --- WebSocket lifecycle ---

  handleOpen(ws: MawWS) {
    this.clients.add(ws);
    this.startIntervals();
    if (this.cachedSessions.length > 0) {
      ws.send(JSON.stringify({ type: "sessions", sessions: this.cachedSessions }));
      this.sendBusyAgents(ws);
    } else {
      // Cold start: fetch and send directly to this client
      tmux.listAll().then(sessions => {
        this.cachedSessions = sessions;
        ws.send(JSON.stringify({ type: "sessions", sessions }));
        this.sendBusyAgents(ws);
      }).catch(() => {});
    }
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedTailer.getRecent(50) }));

    // Phase 1: Send context and lane data
    this.sendContextStats(ws);
    this.sendLaneStats(ws);
  }

  /** Scan panes for busy agents and send `recent` message to client. */
  private async sendBusyAgents(ws: MawWS) {
    const allTargets = this.cachedSessions.flatMap(s =>
      s.windows.map(w => `${s.name}:${w.index}`)
    );
    const cmds = await tmux.getPaneCommands(allTargets);
    const busy = allTargets
      .filter(t => /claude|codex|node/i.test(cmds[t] || ""))
      .map(t => {
        const [session] = t.split(":");
        const s = this.cachedSessions.find(x => x.name === session);
        const w = s?.windows.find(w => `${s.name}:${w.index}` === t);
        return { target: t, name: w?.name || t, session };
      });
    if (busy.length > 0) {
      ws.send(JSON.stringify({ type: "recent", agents: busy }));
    }
  }

  handleMessage(ws: MawWS, msg: string | Buffer) {
    try {
      const data = JSON.parse(msg as string);
      const handler = this.handlers.get(data.type);
      if (handler) handler(ws, data, this);
    } catch {}
  }

  handleClose(ws: MawWS) {
    this.clients.delete(ws);
    this.lastContent.delete(ws);
    this.lastPreviews.delete(ws);
    this.stopIntervals();
  }

  // --- Push mechanics (public — handlers use these) ---

  async pushCapture(ws: MawWS) {
    if (!ws.data.target) return;
    try {
      const content = await capture(ws.data.target, 80);
      const prev = this.lastContent.get(ws);
      if (content !== prev) {
        this.lastContent.set(ws, content);
        ws.send(JSON.stringify({ type: "capture", target: ws.data.target, content }));
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", error: e.message }));
    }
  }

  async pushPreviews(ws: MawWS) {
    const targets = ws.data.previewTargets;
    if (!targets || targets.size === 0) return;
    const prevMap = this.lastPreviews.get(ws) || new Map<string, string>();
    const changed: Record<string, string> = {};
    let hasChanges = false;

    await Promise.allSettled([...targets].map(async (target) => {
      try {
        const content = await capture(target, 3);
        const prev = prevMap.get(target);
        if (content !== prev) {
          prevMap.set(target, content);
          changed[target] = content;
          hasChanges = true;
        }
      } catch {}
    }));

    this.lastPreviews.set(ws, prevMap);
    if (hasChanges) {
      ws.send(JSON.stringify({ type: "previews", data: changed }));
    }
  }

  // --- Broadcast ---

  private async broadcastSessions() {
    if (this.clients.size === 0) return;
    try {
      const sessions = await tmux.listAll();
      this.cachedSessions = sessions;
      const json = JSON.stringify(sessions);

      if (json === this.lastSessionsJson) return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ type: "sessions", sessions });
      for (const ws of this.clients) ws.send(msg);
    } catch {}
  }

  // Phase 1: Broadcast context stats
  private broadcastContextStats() {
    if (this.clients.size === 0) return;
    try {
      const stats = globalContextStore.getStats();
      const json = JSON.stringify(stats);

      if (json === this.lastContextStatsJson) return;
      this.lastContextStatsJson = json;
      const msg = JSON.stringify({ type: "context-stats", stats });
      for (const ws of this.clients) ws.send(msg);
    } catch {}
  }

  // Phase 1: Broadcast lane stats
  private broadcastLaneStats() {
    if (this.clients.size === 0) return;
    try {
      const stats = globalLaneOrganization.getStats();
      const json = JSON.stringify(stats);

      if (json === this.lastLaneStatsJson) return;
      this.lastLaneStatsJson = json;
      const msg = JSON.stringify({ type: "lane-stats", stats });
      for (const ws of this.clients) ws.send(msg);
    } catch {}
  }

  // Phase 1: Send context stats to specific client
  sendContextStats(ws: MawWS) {
    const stats = globalContextStore.getStats();
    ws.send(JSON.stringify({ type: "context-stats", stats }));
  }

  // Phase 1: Send lane stats to specific client
  sendLaneStats(ws: MawWS) {
    const stats = globalLaneOrganization.getStats();
    ws.send(JSON.stringify({ type: "lane-stats", stats }));
  }

  // --- Interval lifecycle ---

  private startIntervals() {
    if (this.captureInterval) return;
    this.captureInterval = setInterval(() => {
      for (const ws of this.clients) this.pushCapture(ws);
    }, 50);
    this.sessionInterval = setInterval(() => this.broadcastSessions(), 5000);
    this.previewInterval = setInterval(() => {
      for (const ws of this.clients) this.pushPreviews(ws);
    }, 2000);
    // Phase 1: Broadcast stats every 10 seconds
    this.statsInterval = setInterval(() => {
      this.broadcastContextStats();
      this.broadcastLaneStats();
    }, 10000);
    this.feedTailer.start();
    this.feedUnsub = this.feedTailer.onEvent((event) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients) ws.send(msg);
    });

    // Watch maw-log for new entries → broadcast to clients
    try { this.mawLogOffset = statSync(MAW_LOG_PATH).size; } catch { this.mawLogOffset = 0; }
    this.mawLogInterval = setInterval(() => this.checkMawLog(), 2000);
  }

  private checkMawLog() {
    if (this.clients.size === 0) return;
    try {
      const size = statSync(MAW_LOG_PATH).size;
      if (size <= this.mawLogOffset) return;
      // Read new bytes
      const buf = Buffer.alloc(size - this.mawLogOffset);
      const fd = require("fs").openSync(MAW_LOG_PATH, "r");
      require("fs").readSync(fd, buf, 0, buf.length, this.mawLogOffset);
      require("fs").closeSync(fd);
      this.mawLogOffset = size;

      const lines = buf.toString("utf-8").split("\n").filter(Boolean);
      const entries: LogEntry[] = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch {}
      }
      if (entries.length > 0) {
        const msg = JSON.stringify({ type: "maw-log", entries });
        for (const ws of this.clients) ws.send(msg);
      }
    } catch {}
  }

  private stopIntervals() {
    if (this.clients.size > 0) return;
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    if (this.sessionInterval) { clearInterval(this.sessionInterval); this.sessionInterval = null; }
    if (this.previewInterval) { clearInterval(this.previewInterval); this.previewInterval = null; }
    if (this.mawLogInterval) { clearInterval(this.mawLogInterval); this.mawLogInterval = null; }
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
    if (this.feedUnsub) { this.feedUnsub(); this.feedUnsub = null; }
    this.feedTailer.stop();
  }

  // Phase 1: Public getters for context store and lane organization
  getContextStore() {
    return globalContextStore;
  }

  getLaneOrganization() {
    return globalLaneOrganization;
  }

  // Phase 1: Broadcast helper for custom messages
  broadcast(message: object) {
    const msg = JSON.stringify(message);
    for (const ws of this.clients) ws.send(msg);
  }
}
