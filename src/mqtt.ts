/**
 * MQTT Client for maw.js
 *
 * Provides native MQTT support for:
 * - Receiving commands (hey, select)
 * - Publishing acknowledgments (ack)
 * - Publishing status (heartbeat)
 *
 * Replaces external mqtt-maw-bridge process
 */

import mqtt, { type Client } from 'mqtt';
import { sendKeys, selectWindow } from './ssh';
import { loadConfig } from './config';
import type { MawConfig } from './config';

// Export the MQTT client type
export type MqttClient = Client;

let mqttClient: Client | null = null;

/**
 * Start MQTT client if enabled in config
 * @returns MQTT client or null if disabled
 */
export function startMqttClient(): Client | null {
  const config = loadConfig() as MawConfig;

  // Check if MQTT is enabled
  if (!config.mqtt?.enabled) {
    console.log('MQTT: disabled in config');
    return null;
  }

  const mqttConfig = config.mqtt;
  const { broker, topics, publishStatus: shouldPublishStatus } = mqttConfig;

  console.log(`MQTT: connecting to ${broker}...`);

  // Connect to MQTT broker
  const client = mqtt.connect(broker);
  mqttClient = client;

  client.on('connect', () => {
    console.log('✅ MQTT: connected to', broker);

    // Subscribe to command topics
    const topicsToSubscribe = [
      topics.hey,
      topics.select,
      // Subscribe to worktree completion notifications (wildcard)
      'oracle/maw/worktree/+/done',
      // ack and status are publish-only (we don't subscribe)
    ];

    client.subscribe(topicsToSubscribe, { qos: 0 }, (err) => {
      if (err) {
        console.error('❌ MQTT: subscribe error:', err);
      } else {
        console.log('✅ MQTT: subscribed to', topicsToSubscribe.join(', '));
      }
    });

    // Publish online status (retained message)
    publishStatus(client, mqttConfig, 'online');
  });

  client.on('message', async (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());

      // Route to appropriate handler
      if (topic === topics.hey) {
        await handleHeyMessage(client, data, mqttConfig);
      } else if (topic === topics.select) {
        await handleSelectMessage(data, mqttConfig);
      } else if (topic.match(/^oracle\/maw\/worktree\/.+\/done$/)) {
        // Worktree completion notification
        handleWorktreeDone(data);
      }

    } catch (e) {
      console.error('❌ MQTT handler error:', e);
    }
  });

  client.on('error', (err) => {
    console.error('❌ MQTT: error:', err);
  });

  client.on('close', () => {
    console.warn('⚠️  MQTT: connection closed');
  });

  // Start heartbeat if enabled
  if (shouldPublishStatus) {
    startHeartbeat(client, mqttConfig);
  }

  return client;
}

/**
 * Handle 'hey' command - send keys to tmux pane
 */
async function handleHeyMessage(
  client: Client,
  data: { target?: string; text?: string; agent?: string },
  mqttConfig: any
) {
  const { target, text } = data;

  if (!target || !text) {
    console.warn('⚠️  MQTT: invalid hey message, missing target or text', data);
    return;
  }

  console.log(`📨 MQTT: hey → ${target}: "${text.slice(0, 50)}..."`);

  try {
    await sendKeys(target, text);

    // Publish acknowledgment
    client.publish(mqttConfig.topics.ack, JSON.stringify({
      ok: true,
      agent: data.agent || target,
      text: text.slice(0, 80), // First 80 chars
      ts: new Date().toISOString(),
    }));

    console.log('✅ MQTT: sent keys, ack published');
  } catch (e) {
    console.error('❌ MQTT: sendKeys error:', e);

    // Publish error acknowledgment
    client.publish(mqttConfig.topics.ack, JSON.stringify({
      ok: false,
      agent: data.agent || target,
      error: String(e),
      ts: new Date().toISOString(),
    }));
  }
}

/**
 * Handle 'select' command - switch tmux pane
 */
async function handleSelectMessage(data: { target?: string }, mqttConfig: any) {
  const { target } = data;

  if (!target) {
    console.warn('⚠️  MQTT: invalid select message, missing target', data);
    return;
  }

  console.log(`🎯 MQTT: select → ${target}`);

  try {
    await selectWindow(target);
    console.log('✅ MQTT: window selected');
  } catch (e) {
    console.error('❌ MQTT: select error:', e);
  }
}

/**
 * Handle worktree completion notification
 */
function handleWorktreeDone(data: {
  worktree?: string;
  status?: string;
  duration?: number;
  agent?: string;
  ts?: string;
}) {
  const { worktree, status, duration, agent } = data;

  if (!worktree || !status) {
    console.warn('⚠️  MQTT: invalid worktree notification, missing fields', data);
    return;
  }

  // Format duration as minutes:seconds if > 60 seconds
  const durationSec = duration || 0;
  const durationText = durationSec >= 60
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : `${durationSec}s`;

  // Display notification with appropriate emoji
  const emoji = status === 'done' ? '✅' : status === 'error' ? '❌' : '⚠️';
  console.log(`${emoji} MQTT: Worktree ${worktree} ${status} (${durationText})`);

  // TODO: Could trigger desktop notification, sound, or UI alert here
}

/**
 * Publish status to MQTT topic
 */
function publishStatus(
  client: Client,
  mqttConfig: any,
  status: 'online' | 'offline'
) {
  const statusPayload = {
    status,
    host: mqttConfig.host || 'localhost',
    port: mqttConfig.port || 3456,
    ts: new Date().toISOString(),
  };

  client.publish(mqttConfig.topics.status, JSON.stringify(statusPayload), {
    retain: true, // Last Will Testament
    qos: 0,
  });

  console.log(`📊 MQTT: status → ${status}`);
}

/**
 * Start heartbeat to publish periodic status updates
 */
function startHeartbeat(client: Client, mqttConfig: any) {
  const intervalMs = 60_000; // 60 seconds

  setInterval(async () => {
    try {
      // Import listSessions lazily to avoid circular dependencies
      const { listSessions } = await import('./ssh');

      const sessions = await listSessions();

      client.publish(mqttConfig.topics.status, JSON.stringify({
        status: 'online',
        sessions: sessions.length,
        uptime: process.uptime(),
        ts: new Date().toISOString(),
      }), { retain: true });

      console.log(`💓 MQTT: heartbeat (${sessions.length} sessions)`);
    } catch (e) {
      console.error('❌ MQTT: heartbeat error:', e);
    }
  }, intervalMs);

  console.log(`💓 MQTT: heartbeat every ${(intervalMs / 1000)}s`);
}

/**
 * Publish worktree completion notification (for Part 2)
 * @param worktree Name of the worktree
 * @param status Completion status (done, error, etc.)
 * @param duration Duration in seconds
 * @param agent Agent name
 */
export function publishWorktreeDone(
  worktree: string,
  status: 'done' | 'error' | 'cancelled',
  duration: number,
  agent?: string
) {
  if (!mqttClient) {
    console.warn('⚠️  MQTT: client not available, skipping worktree notification');
    return;
  }

  const topic = `oracle/maw/worktree/${worktree}/done`;
  const payload = {
    worktree,
    status,
    duration,
    agent: agent || worktree,
    ts: new Date().toISOString(),
  };

  mqttClient.publish(topic, JSON.stringify(payload), { qos: 0 });
  console.log(`✅ MQTT: worktree ${worktree} ${status} (${duration}s)`);
}

/**
 * Stop MQTT client gracefully
 */
export function stopMqttClient() {
  if (mqttClient) {
    // Publish offline status before disconnecting
    const config = loadConfig() as MawConfig;
    if (config.mqtt?.enabled) {
      publishStatus(mqttClient, config.mqtt, 'offline');
    }

    mqttClient.end();
    mqttClient = null;
    console.log('👋 MQTT: client stopped');
  }
}

/**
 * Get current MQTT client instance
 */
export function getMqttClient(): Client | null {
  return mqttClient;
}
