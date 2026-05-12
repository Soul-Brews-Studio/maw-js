import { tmux } from "../core/transport/tmux";
import { loadConfig, buildCommand } from "../config";
import type { FeedEvent } from "../lib/feed";
import type { MawWS } from "../core/types";
import type { StatusDetector } from "./status";
import type { SessionInfo } from "./types";

/** Auto-restart crashed agents if config.autoRestart is enabled. */
export async function handleCrashedAgents(
  status: StatusDetector,
  sessions: SessionInfo[],
  clients: Set<MawWS>,
  feedListeners: Set<(event: FeedEvent) => void>,
): Promise<void> {
  const config = loadConfig();
  if (!config.autoRestart) return;

  const crashed = status.getCrashedAgents(sessions);
  for (const agent of crashed) {
    try {
      const cmd = buildCommand(agent.name);
      await tmux.sendText(agent.target, cmd);
      status.clearCrashed(agent.target);
      console.log(`\x1b[33m↻ auto-restart\x1b[0m ${agent.name} in ${agent.session} (was crashed)`);

      const event: FeedEvent = {
        timestamp: new Date().toISOString(),
        oracle: agent.name.replace(/-oracle$/, ""),
        host: "local",
        event: "SubagentStart",
        project: agent.session,
        sessionId: "",
        message: "auto-restarted after crash",
        ts: Date.now(),
      };
      const msg = JSON.stringify({ type: "feed", event });
      for (const ws of clients) ws.send(msg);
      for (const fn of feedListeners) fn(event);
    } catch {
      // Window may have been killed
    }
  }
}
