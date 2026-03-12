import { listSessions, capture } from "./ssh";
import { registerBuiltinHandlers } from "./handlers";
import type { FeedTailer } from "./feed-tail";
import type { MawWS, Handler, RecentAgent } from "./types";

const BUSY_PATTERNS = /[∴✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]|● \w+\(|\b(Read|Edit|Write|Bash|Grep|Glob|Agent)\b/;
const RECENT_TTL = 30 * 60 * 1000; // 30 minutes

export class MawEngine {
  private clients = new Set<MawWS>();
  private handlers = new Map<string, Handler>();
  private lastContent = new Map<MawWS, string>();
  private lastPreviews = new Map<MawWS, Map<string, string>>();
  private recentAgents = new Map<string, RecentAgent>();
  private lastSessionsJson = "";
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private sessionInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private feedUnsub: (() => void) | null = null;
  private feedTailer: FeedTailer;

  constructor({ feedTailer }: { feedTailer: FeedTailer }) {
    this.feedTailer = feedTailer;
    registerBuiltinHandlers(this);
  }

  /** Register a WebSocket message handler */
  on(type: string, handler: Handler) {
    this.handlers.set(type, handler);
  }

  // --- WebSocket lifecycle ---

  handleOpen(ws: MawWS) {
    this.clients.add(ws);
    this.startIntervals();
    listSessions().then(s => {
      ws.send(JSON.stringify({ type: "sessions", sessions: s }));
      ws.send(JSON.stringify({ type: "recent", agents: this.getRecentList() }));
    }).catch(() => {});
    ws.send(JSON.stringify({ type: "feed-history", events: this.feedTailer.getRecent(50) }));
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

  // --- Recent agent tracking ---

  private pruneRecent() {
    const cutoff = Date.now() - RECENT_TTL;
    for (const [k, v] of this.recentAgents) {
      if (v.lastBusy < cutoff) this.recentAgents.delete(k);
    }
  }

  private getRecentList(): RecentAgent[] {
    this.pruneRecent();
    return [...this.recentAgents.values()]
      .sort((a, b) => b.lastBusy - a.lastBusy)
      .slice(0, 6);
  }

  private async updateRecentFromSessions(sessions: { name: string; windows: { index: number; name: string; active: boolean }[] }[]) {
    const now = Date.now();
    const checks: Promise<void>[] = [];

    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        checks.push(
          capture(`${s.name}:${w.name}`, 5).then(content => {
            const lines = content.split("\n").filter(l => l.trim());
            const bottom = lines.slice(-5).join("\n");
            if (BUSY_PATTERNS.test(bottom)) {
              this.recentAgents.set(target, { target, name: w.name, session: s.name, lastBusy: now });
            }
          }).catch(() => {})
        );
      }
    }
    await Promise.allSettled(checks);
  }

  // --- Broadcast ---

  private async broadcastSessions() {
    if (this.clients.size === 0) return;
    try {
      const sessions = await listSessions();
      const json = JSON.stringify(sessions);

      await this.updateRecentFromSessions(sessions);
      const recentMsg = JSON.stringify({ type: "recent", agents: this.getRecentList() });
      for (const ws of this.clients) ws.send(recentMsg);

      if (json === this.lastSessionsJson) return;
      this.lastSessionsJson = json;
      const msg = JSON.stringify({ type: "sessions", sessions });
      for (const ws of this.clients) ws.send(msg);
    } catch {}
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
    this.feedTailer.start();
    this.feedUnsub = this.feedTailer.onEvent((event) => {
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of this.clients) ws.send(msg);
    });
  }

  private stopIntervals() {
    if (this.clients.size > 0) return;
    if (this.captureInterval) { clearInterval(this.captureInterval); this.captureInterval = null; }
    if (this.sessionInterval) { clearInterval(this.sessionInterval); this.sessionInterval = null; }
    if (this.previewInterval) { clearInterval(this.previewInterval); this.previewInterval = null; }
    if (this.feedUnsub) { this.feedUnsub(); this.feedUnsub = null; }
    this.feedTailer.stop();
  }
}
