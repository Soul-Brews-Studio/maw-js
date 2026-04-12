/**
 * Built-in: MQTT publish — broadcast feed events to configurable broker.
 * Extracted from server.ts inline feedListener.
 */
import type { MawHooks } from "../../plugins";
import { loadConfig } from "../../config";

export default function(hooks: MawHooks) {
  const config = loadConfig();
  if (!config.node) return;

  let mqttPublish: (topic: string, payload: unknown) => void;
  try {
    mqttPublish = require("../../mqtt-publish").mqttPublish;
  } catch {
    return; // mqtt not configured — skip silently
  }

  const node = config.node;

  hooks.on("*", (event) => {
    mqttPublish(`maw/v1/oracle/${event.oracle}/feed`, event);
    mqttPublish(`maw/v1/node/${node}/feed`, event);
  });
}
