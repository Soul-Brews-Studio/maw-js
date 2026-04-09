/**
 * MQTT Feed Bridge — publishes maw-js feed events to MQTT topics.
 *
 * Topics:
 *   maw/v1/oracle/{name}/feed    — per-oracle feed events
 *   maw/v1/oracle/{name}/status  — busy/ready/idle (retained)
 *   maw/v1/node/{node}/feed      — all events from this node
 *   maw/v1/node/{node}/sessions  — session list (retained, periodic)
 *
 * Subscribes:
 *   maw/v1/oracle/+/inbox        — incoming messages → route to local agent
 */

import mqtt from "mqtt";
import type { FeedEvent } from "../lib/feed";
import { loadConfig, cfgLimit } from "../config";
import { listSessions, sendKeys } from "../ssh";
import { findWindow } from "../find-window";

const BUSY_EVENTS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SubagentStart"]);
const STOP_EVENTS = new Set(["Stop", "SessionEnd"]);

let client: mqtt.MqttClient | null = null;
let sessionInterval: ReturnType<typeof setInterval> | null = null;

export function startMqttBridge(feedListeners: Set<(event: FeedEvent) => void>, feedBuffer?: FeedEvent[]): void {
  const config = loadConfig();
  const broker = config.mqtt?.broker;
  if (!broker) return;

  const node = config.node ?? "local";

  try {
    client = mqtt.connect(broker, {
      clientId: `maw-bridge-${node}-${Date.now()}`,
      keepalive: 60,
      connectTimeout: 10000,
      username: config.mqtt?.username,
      password: config.mqtt?.password,
    });
  } catch {
    return;
  }

  // --- Publish feed events to MQTT topics ---

  const statusMap = new Map<string, string>(); // oracle → last status

  const feedListener = (event: FeedEvent) => {
    if (!client?.connected) return;

    // Per-oracle feed event
    client.publish(
      `maw/v1/oracle/${event.oracle}/feed`,
      JSON.stringify(event),
      { qos: 0 },
    );

    // Per-node aggregated feed
    client.publish(
      `maw/v1/node/${node}/feed`,
      JSON.stringify(event),
      { qos: 0 },
    );

    // Derive status and publish retained
    let status: string | null = null;
    if (BUSY_EVENTS.has(event.event)) status = "busy";
    else if (STOP_EVENTS.has(event.event)) status = "ready";

    if (status && statusMap.get(event.oracle) !== status) {
      statusMap.set(event.oracle, status);
      client.publish(
        `maw/v1/oracle/${event.oracle}/status`,
        JSON.stringify({ oracle: event.oracle, host: node, status, ts: Date.now() }),
        { qos: 0, retain: true },
      );
    }
  };

  feedListeners.add(feedListener);

  // --- Connect handler: publish buffered events + sessions immediately ---

  client.on("connect", () => {
    console.log(`[mqtt-bridge] connected to ${broker}`);
    client!.subscribe("maw/v1/oracle/+/inbox", { qos: 1 });

    // Publish existing feed buffer so retained status is set on startup
    if (feedBuffer?.length) {
      const mqttBuffer = cfgLimit("mqttBuffer");
      for (const event of feedBuffer.slice(-mqttBuffer)) {
        feedListener(event);
      }
      console.log(`[mqtt-bridge] published ${Math.min(feedBuffer.length, mqttBuffer)} buffered events`);
    }

    // Publish sessions immediately (don't wait for 10s interval)
    listSessions().then(sessions => {
      client!.publish(
        `maw/v1/node/${node}/sessions`,
        JSON.stringify({ node, sessions, ts: Date.now() }),
        { qos: 0, retain: true },
      );
    }).catch(() => {});
  });

  client.on("error", (err) => {
    console.error(`[mqtt-bridge] ${err.message}`);
  });

  // --- Publish session list periodically (retained) ---

  sessionInterval = setInterval(async () => {
    if (!client?.connected) return;
    try {
      const sessions = await listSessions();
      client.publish(
        `maw/v1/node/${node}/sessions`,
        JSON.stringify({ node, sessions, ts: Date.now() }),
        { qos: 0, retain: true },
      );
    } catch {}
  }, 10_000);

  // --- Subscribe to incoming messages ---

  client.on("message", async (topic, payload) => {
    // maw/v1/oracle/{name}/inbox → route to local agent
    const inboxMatch = topic.match(/^maw\/v1\/oracle\/([^/]+)\/inbox$/);
    if (inboxMatch) {
      const targetOracle = inboxMatch[1];
      try {
        const msg = JSON.parse(payload.toString());
        const sessions = await listSessions();
        const resolved = findWindow(sessions, targetOracle) || findWindow(sessions, `${targetOracle}-oracle`);
        if (resolved && msg.body) {
          await sendKeys(resolved, msg.body);
          console.log(`[mqtt-bridge] inbox → ${resolved}: ${msg.body.slice(0, 60)}`);
        }
      } catch {}
    }
  });
}

export function stopMqttBridge(): void {
  if (sessionInterval) clearInterval(sessionInterval);
  client?.end(true);
  client = null;
}
