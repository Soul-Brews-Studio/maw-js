import { capture } from "../ssh";
import { tmux } from "../tmux";
import type { FeedEvent } from "../lib/feed";
import type { MawWS } from "../types";

interface AgentState {
  hash: string;
  changedAt: number;
  status: string;
  /** Track if agent was previously running (busy/ready) — for crash detection */
  wasRunning: boolean;
}

/** Track agents with recent real feed events (from Claude Code hooks).
 *  StatusDetector skips synthetic events for these — real events are authoritative. */
const realFeedLastSeen = new Map<string, number>();
const REAL_FEED_TTL = 60_000; // 60s — if real feed seen within this, skip synthetic

/** Call this when a real feed event arrives (from POST /api/feed). */
export function markRealFeedEvent(oracleName: string) {
  realFeedLastSeen.set(oracleName, Date.now());
}

export interface CrashedAgent {
  target: string;
  name: string;
  session: string;
}

interface SessionInfo {
  name: string;
  windows: { index: number; name: string; active: boolean }[];
}

/** Strip Claude Code status bar lines before hashing (they change constantly even when idle) */
function stripStatusBar(content: string): string {
  return content.split('\n').filter(line => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (/^[\s─━]+$/.test(plain)) return false;
    if (/📁/.test(plain)) return false;
    if (/📡/.test(plain)) return false;
    if (/⏵/.test(plain)) return false;
    if (/^\s*❯\s*$/.test(plain)) return false;
    if (/current:.*latest:/.test(plain)) return false;
    if (/bypass permissions/.test(plain)) return false;
    if (/auto-accept/.test(plain)) return false;
    if (/^\s*$/.test(plain)) return false;
    return true;
  }).join('\n');
}

/**
 * Hybrid status detection: pane command + screen hash.
 * - Shell running + was previously busy/ready → crashed
 * - Not running claude (and wasn't running before) → idle
 * - Running claude + screen changing → busy
 * - Running claude + stable 15s → ready
 */
export class StatusDetector {
  private state = new Map<string, AgentState>();

  async detect(
    sessions: SessionInfo[],
    clients: Set<MawWS>,
    feedListeners: Set<(event: FeedEvent) => void>,
  ) {
    if (clients.size === 0 || sessions.length === 0) return;

    const agents = sessions.flatMap(s =>
      s.windows.map(w => ({ target: `${s.name}:${w.index}`, name: w.name, session: s.name }))
    );

    const cmds = await tmux.getPaneCommands(agents.map(a => a.target));

    // Only capture agents NOT running Claude (shells, idle panes).
    // Claude agents get status from real hooks — no capture needed.
    const needsCapture = agents.filter(a => {
      const cmd = (cmds[`${a.session}:${a.target.split(":")[1]}`] || cmds[a.target] || "").toLowerCase();
      return !/claude|codex|node/i.test(cmd);
    });
    const captures = await Promise.allSettled(
      needsCapture.map(async a => ({ target: a.target, content: await capture(a.target, 20) }))
    );
    const contentMap = new Map<string, string>();
    for (const r of captures) {
      if (r.status === "fulfilled") contentMap.set(r.value.target, r.value.content);
    }

    const now = Date.now();
    for (const { target, name, session } of agents) {
      const cmd = (cmds[target] || "").toLowerCase();
      const isAgent = /claude|codex|node/i.test(cmd);
      const isShell = /^(zsh|bash|sh|fish)$/.test(cmd.trim());

      // Skip ALL agents running Claude — real hooks handle their status.
      // StatusDetector only needed for: crash detection (was Claude, now shell) + idle shells.
      if (isAgent) {
        const prev = this.state.get(target);
        this.state.set(target, { hash: prev?.hash || "", changedAt: prev?.changedAt || now, status: prev?.status || "ready", wasRunning: true });
        continue;
      }

      const content = contentMap.get(target) || "";
      const hash = Bun.hash(stripStatusBar(content)).toString(36);
      const prev = this.state.get(target);

      let status: string;
      if (!isAgent && isShell && prev?.wasRunning) {
        status = "crashed";
      } else if (!isAgent) {
        status = "idle";
      } else if (!prev || hash !== prev.hash) {
        status = "busy";
      } else if (now - prev.changedAt < 15_000) {
        status = "busy";
      } else {
        status = "ready";
      }

      const changedAt = (!prev || hash !== prev.hash) ? now : prev.changedAt;
      const wasRunning = isAgent ? true : (prev?.wasRunning ?? false);
      this.state.set(target, { hash, changedAt, status, wasRunning });

      if (prev && status !== prev.status) {
        // Skip synthetic events for agents with recent real feed events —
        // real Claude Code hooks are more accurate than screen-hash polling.
        // Still update internal state (for crash detection), just don't emit.
        const oracleName = name.replace(/-oracle$/, "");
        const lastReal = realFeedLastSeen.get(oracleName) || 0;
        const hasRealFeed = now - lastReal < REAL_FEED_TTL;

        if (!hasRealFeed) {
          const event: FeedEvent = {
            timestamp: new Date().toISOString(),
            oracle: oracleName,
            host: "local",
            event: status === "busy" ? "PreToolUse" : status === "ready" ? "Stop" : status === "crashed" ? "Error" : "SessionEnd",
            project: session,
            sessionId: "",
            message: status === "busy" ? "working" : status === "ready" ? "waiting" : status === "crashed" ? "crashed" : "idle",
            ts: now,
          };
          const msg = JSON.stringify({ type: "feed", event });
          for (const ws of clients) ws.send(msg);
          for (const fn of feedListeners) fn(event);
        }
      }
    }

    this.pruneState(sessions);
  }

  /** Get status for a target */
  getStatus(target: string): string | null {
    return this.state.get(target)?.status ?? null;
  }

  /** Return agents currently in "crashed" state. */
  getCrashedAgents(sessions: SessionInfo[]): CrashedAgent[] {
    const result: CrashedAgent[] = [];
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        const state = this.state.get(target);
        if (state?.status === "crashed") {
          result.push({ target, name: w.name, session: s.name });
        }
      }
    }
    return result;
  }

  /** Clear crashed state for a target (after restart). */
  clearCrashed(target: string) {
    const s = this.state.get(target);
    if (s) { s.wasRunning = false; s.status = "idle"; }
  }

  /** Remove entries for targets no longer in active sessions (#145). */
  pruneState(sessions: SessionInfo[]) {
    const activeTargets = new Set<string>();
    const activeOracles = new Set<string>();
    for (const s of sessions) {
      for (const w of s.windows) {
        activeTargets.add(`${s.name}:${w.index}`);
        activeOracles.add(w.name.replace(/-oracle$/, ""));
      }
    }
    for (const key of this.state.keys()) {
      if (!activeTargets.has(key)) this.state.delete(key);
    }
    const now = Date.now();
    for (const [oracle, ts] of realFeedLastSeen) {
      if (!activeOracles.has(oracle) || now - ts > 3_600_000) {
        realFeedLastSeen.delete(oracle);
      }
    }
  }
}
