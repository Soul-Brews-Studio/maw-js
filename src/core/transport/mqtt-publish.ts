/**
 * Lightweight MQTT publish-only client.
 * Publishes feed events to configurable broker.
 * Browser subscribes via CF Worker bridge.
 *
 * Config: maw.config.json → mqttPublish: { broker: "mqtt://..." }
 */

import mqtt from "mqtt";
import { loadConfig } from "../../config";

let client: mqtt.MqttClient | null = null;

function getClient(): mqtt.MqttClient | null {
  if (client) return client;
  const config = loadConfig() as unknown as Record<string, unknown>;
  const mqttConfig = config.mqttPublish as unknown as Record<string, unknown> | undefined;
  const broker = typeof mqttConfig?.broker === "string" ? mqttConfig.broker : null;
  if (!broker) return null;
  client = mqtt.connect(broker, {
    clientId: `maw-${config.node ?? "local"}-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
  });
  client.on("error", () => {}); // swallow — publish is best-effort
  return client;
}

export function mqttPublish(topic: string, payload: object) {
  const c = getClient();
  if (!c) return;
  c.publish(topic, JSON.stringify(payload), { qos: 0 });
}
