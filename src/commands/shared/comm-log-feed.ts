/**
 * comm-log-feed.ts — logMessage and emitFeed helpers.
 * Handles message audit log (JSONL) and feed event emission to server plugin pipeline.
 */

import { loadConfig } from "../../config";
import { appendFile, mkdir } from "fs/promises";
import { hostname } from "os";
import { dirname } from "path";
import { buildMessageLifecycleFeedEvent, type MessageLifecycleInput } from "../../lib/message-events";
import { mawMessageLogPath } from "../../core/xdg";

/** Log message to the XDG data-primary maw-log.jsonl with normalized from/to. */
export async function logMessage(from: string, to: string, msg: string, route: string) {
  const config = loadConfig();
  if (!config.node) throw new Error("config.node is required — set 'node' in maw.config.json");
  const normalizedFrom = from.includes(":") ? from : `${config.node}:${from}`;
  const logFile = mawMessageLogPath();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    from: normalizedFrom,
    to,
    msg: msg.slice(0, 500),
    host: hostname(),
    route,
  }) + "\n";
  try { await mkdir(dirname(logFile), { recursive: true }); await appendFile(logFile, line); } catch {}
}

/** Emit feed event to server plugin pipeline (CLI → server bridge) */
export function emitFeed(event: string, oracle: string, node: string, message: string, port: number, data?: unknown) {
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, oracle, host: node, message, ts: Date.now(), ...(data !== undefined ? { data } : {}) }),
  }).catch(() => {});
}

/** Emit typed message lifecycle event to the server plugin pipeline. */
export function emitMessageLifecycle(input: MessageLifecycleInput, port: number) {
  const event = buildMessageLifecycleFeedEvent(input);
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => {});
}
