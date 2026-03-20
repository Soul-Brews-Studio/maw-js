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
import { getNotificationSystem } from './notification-system';
import { createOracleThread, classifyThreadForMemoryHub } from './oracle-threads';

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
 * Handle Task Master command - create task via local API
 */
async function handleTaskMasterCommand(
  client: Client,
  data: { target?: string; text?: string; agent?: string },
  mqttConfig: any,
  taskDescription: string
) {
  // Use local maw.js API endpoint (not external Task Master)
  const config = loadConfig() as MawConfig;
  const taskUrl = `http://localhost:${config.port || 3456}/api/task`;

  try {
    console.log(`📋 Task Master: creating task "${taskDescription.slice(0, 50)}..."`);

    const response = await fetch(taskUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: taskDescription.slice(0, 100),
        description: taskDescription,
        priority: 'medium',
        requested_by: data.agent || 'mqtt-hey',
        source: 'maw-hey',
        metadata: {
          timestamp: new Date().toISOString(),
          original_message: data.text,
          target: data.target,
        }
      }),
    });

    if (!response.ok) {
      throw new Error(`Task API returned ${response.status}`);
    }

    const result = await response.json();
    const taskId = result.task_id;

    console.log(`✅ Task Master: task #${taskId} created`);

    // Add notification
    const notifications = getNotificationSystem();
    notifications.add({
      channel: 'mqtt',
      type: 'task_created',
      title: 'Task Created',
      message: taskDescription.slice(0, 100),
      metadata: {
        task_id: taskId,
        agent: data.agent || 'mqtt-hey',
        target: data.target,
      }
    });

    // Publish acknowledgment with task_id
    client.publish(mqttConfig.topics.ack, JSON.stringify({
      ok: true,
      agent: data.agent || 'mqtt-hey',
      type: 'task_created',
      task_id: taskId,
      text: taskDescription.slice(0, 80),
      ts: new Date().toISOString(),
    }));

    return taskId;
  } catch (e) {
    console.error('❌ Task Master: error:', e);

    // Publish error acknowledgment
    client.publish(mqttConfig.topics.ack, JSON.stringify({
      ok: false,
      agent: data.agent || 'mqtt-hey',
      type: 'task_error',
      error: String(e),
      text: taskDescription.slice(0, 80),
      ts: new Date().toISOString(),
    }));

    throw e;
  }
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
    // Context-aware routing:
    // 1. @task: keywords → Task Master (save for later)
    // 2. "discuss", "consult", "advice" → Oracle Threads (consultation)
    // 3. urgent/immediate keywords → MQTT (direct to agent)
    // 4. Default → MQTT (direct to agent)

    // Task Master routing (save for later)
    const taskPatterns = [
      /^@task:\s*(.+)/i,
      /^(create|add)\\s+task:\\s*(.+)/i,
      /^todo:\\s*(.+)/i,
      /^(create|add)\\s+(a\\s+)?task\\s+(to\\s+)?(.+)/i,
    ];

    for (const pattern of taskPatterns) {
      const match = text.match(pattern);
      if (match) {
        const taskDescription = match[1] || match[4] || text;
        await handleTaskMasterCommand(client, data, mqttConfig, taskDescription.trim());
        console.log(`📋 Routed to Task Master (save for later)`);
        return;
      }
    }

    // Oracle Threads routing (consultation)
    const consultPatterns = [
      /^(discuss|consult|opinion|advice|thoughts|feedback):\s*(.+)/i,
      /^(what do you think|should i|how should i|your opinion)/i,
      /^(help me decide|guidance on|recommend)/i,
    ];

    for (const pattern of consultPatterns) {
      const match = text.match(pattern);
      if (match) {
        const topic = match[2] || text;
        console.log(`💬 Routed to Oracle Threads (consultation): "${topic.slice(0, 50)}..."`);

        try {
          // Create Oracle Thread
          const thread = await createOracleThread(
            `Consultation: ${topic.slice(0, 100)}`,
            text,
            {
              agent: data.agent || 'mqtt-hey',
              target: data.target,
              source: 'mqtt',
            }
          );

          // Classify for Memory Hub routing
          const category = classifyThreadForMemoryHub(thread.title, []);

          console.log(`📊 Thread #${thread.id} classified as: ${category}`);

          // Publish acknowledgment with thread ID
          client.publish(mqttConfig.topics.ack, JSON.stringify({
            ok: true,
            agent: data.agent || 'mqtt-hey',
            type: 'thread_created',
            thread_id: thread.id,
            topic: topic.slice(0, 80),
            memory_category: category,
            message: `Oracle Thread #${thread.id} created`,
            ts: new Date().toISOString(),
          }));

          return;
        } catch (e) {
          console.error('❌ Oracle Threads creation failed:', e);

          // Publish error acknowledgment
          client.publish(mqttConfig.topics.ack, JSON.stringify({
            ok: false,
            agent: data.agent || 'mqtt-hey',
            type: 'thread_error',
            error: String(e),
            topic: topic.slice(0, 80),
            ts: new Date().toISOString(),
          }));

          return;
        }
      }
    }

    // Urgent/immediate routing
    const urgentPatterns = [
      /^(urgent|asap|immediate|emergency|now):\s*(.+)/i,
    ];

    for (const pattern of urgentPatterns) {
      const match = text.match(pattern);
      if (match) {
        const urgentMessage = match[2] || text;
        console.log(`🚨 Urgent message → sending directly to agent`);

        // Add notification
        const notifications = getNotificationSystem();
        notifications.add({
          channel: 'mqtt',
          type: 'urgent_message',
          title: '🚨 Urgent Message',
          message: urgentMessage.slice(0, 100),
          metadata: {
            agent: data.agent || 'mqtt-hey',
            target: data.target,
            priority: 'urgent',
          }
        });
      }
    }

    // Default: send keys to tmux pane
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
