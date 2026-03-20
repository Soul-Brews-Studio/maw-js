/**
 * Universal Notification Client for All Agents
 *
 * Provides a simple HTTP-based API for agents to send notifications
 * without needing to import the full notification system.
 *
 * Usage:
 *   import { notify } from './notification-client';
 *
 *   // Simple notification
 *   await notify({
 *     channel: 'mqtt',
 *     type: 'task_completed',
 *     title: 'Task Completed',
 *     message: 'Analysis finished successfully'
 *   });
 *
 *   // With metadata
 *   await notify({
 *     channel: 'threads',
 *     type: 'consultation_created',
 *     title: '💬 Consultation Request',
 *     message: 'Need advice on trading strategy',
 *     metadata: { agent: 'trade-lead', target: 'scudd' }
 *   });
 */

import { fetch } from 'undici';

const NOTIFICATION_API_URL = process.env.NOTIFICATION_API_URL || 'http://localhost:3456';

interface NotificationInput {
  channel: 'mqtt' | 'threads' | 'memory';
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

interface NotificationResponse {
  ok: boolean;
  notification?: {
    id: string;
    timestamp: string;
    channel: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    metadata?: Record<string, any>;
  };
  error?: string;
}

/**
 * Send a notification to the maw.js notification system
 *
 * @param input Notification data
 * @returns Promise with created notification or error
 */
export async function notify(input: NotificationInput): Promise<NotificationResponse> {
  try {
    const response = await fetch(`${NOTIFICATION_API_URL}/api/notifications/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: input.channel,
        type: input.type,
        title: input.title.slice(0, 200), // Limit title length
        message: input.message.slice(0, 1000), // Limit message length
        metadata: input.metadata || {},
      }),
    });

    if (!response.ok) {
      throw new Error(`Notification API returned ${response.status}`);
    }

    const data = await response.json();
    return {
      ok: true,
      notification: data,
    };
  } catch (e) {
    // Log error but don't throw - notifications are non-critical
    console.error(`❌ Notification error:`, e);
    return {
      ok: false,
      error: String(e),
    };
  }
}

/**
 * Convenience functions for common notification types
 */

export async function notifyTaskCreated(taskId: string, description: string, metadata?: Record<string, any>) {
  return notify({
    channel: 'mqtt',
    type: 'task_created',
    title: '📋 Task Created',
    message: description.slice(0, 100),
    metadata: {
      task_id: taskId,
      ...metadata,
    },
  });
}

export async function notifyTaskCompleted(taskId: string, result?: string) {
  return notify({
    channel: 'mqtt',
    type: 'task_completed',
    title: '✅ Task Completed',
    message: `Task ${taskId} finished${result ? ': ' + result.slice(0, 50) : ''}`,
    metadata: { task_id: taskId },
  });
}

export async function notifyConsultation(topic: string, metadata?: Record<string, any>) {
  return notify({
    channel: 'threads',
    type: 'consultation_created',
    title: '💬 Consultation Request',
    message: topic.slice(0, 100),
    metadata: {
      topic,
      ...metadata,
    },
  });
}

export async function notifyUrgent(message: string, metadata?: Record<string, any>) {
  return notify({
    channel: 'mqtt',
    type: 'urgent_message',
    title: '🚨 Urgent',
    message: message.slice(0, 100),
    metadata: {
      priority: 'urgent',
      ...metadata,
    },
  });
}

export async function notifyError(error: string, context?: string) {
  return notify({
    channel: 'mqtt',
    type: 'error',
    title: '❌ Error',
    message: error.slice(0, 100),
    metadata: { context },
  });
}

export async function notifyMemorySynced(threadId: number, category: string) {
  return notify({
    channel: 'memory',
    type: 'thread_synced',
    title: '🧠 Thread Synced',
    message: `#${threadId} synced to Memory Hub`,
    metadata: { thread_id: threadId, category },
  });
}

/**
 * Batch notifications - send multiple at once
 */
export async function notifyBatch(notifications: NotificationInput[]) {
  const results = await Promise.allSettled(
    notifications.map(n => notify(n))
  );

  const successful = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  console.log(`📊 Batch notifications: ${successful} sent, ${failed} failed`);

  return { successful, failed, results };
}
