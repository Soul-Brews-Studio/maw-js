/**
 * Notification System
 *
 * Central notification hub for all channels:
 * - MQTT (tasks, consultations, urgent)
 * - Oracle Threads (new, activity, sync)
 * - Memory Hub (sync status, new content)
 */

import { EventEmitter } from 'events';

export type NotificationChannel = 'mqtt' | 'threads' | 'memory';

export interface Notification {
  id: string;
  channel: NotificationChannel;
  type: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  metadata?: Record<string, any>;
}

export interface NotificationStats {
  total: number;
  unread: number;
  byChannel: {
    mqtt: number;
    threads: number;
    memory: number;
  };
  byType: Record<string, number>;
}

/**
 * Notification System Class
 */
export class NotificationSystem extends EventEmitter {
  private notifications: Map<string, Notification> = new Map();
  private maxNotifications = 1000;

  constructor() {
    super();
  }

  /**
   * Add notification
   */
  add(notification: Omit<Notification, 'id' | 'timestamp' | 'read'>): Notification {
    const id = `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const fullNotification: Notification = {
      id,
      timestamp: new Date().toISOString(),
      read: false,
      ...notification,
    };

    // Store notification
    this.notifications.set(id, fullNotification);

    // Emit event for WebSocket broadcast
    this.emit('notification', fullNotification);

    // Cleanup old notifications
    this.cleanup();

    return fullNotification;
  }

  /**
   * Get all notifications
   */
  getAll(options?: {
    limit?: number;
    channel?: NotificationChannel;
    unreadOnly?: boolean;
  }): Notification[] {
    let notifications = Array.from(this.notifications.values());

    // Filter by channel
    if (options?.channel) {
      notifications = notifications.filter(n => n.channel === options.channel);
    }

    // Filter by read status
    if (options?.unreadOnly) {
      notifications = notifications.filter(n => !n.read);
    }

    // Sort by timestamp (newest first)
    notifications.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Limit results
    if (options?.limit) {
      notifications = notifications.slice(0, options.limit);
    }

    return notifications;
  }

  /**
   * Get notification by ID
   */
  getById(id: string): Notification | undefined {
    return this.notifications.get(id);
  }

  /**
   * Mark as read
   */
  markAsRead(id: string): boolean {
    const notification = this.notifications.get(id);
    if (notification) {
      notification.read = true;
      this.emit('notification-updated', notification);
      return true;
    }
    return false;
  }

  /**
   * Mark all as read
   */
  markAllAsRead(channel?: NotificationChannel): number {
    let count = 0;

    for (const notification of this.notifications.values()) {
      if (!notification.read) {
        if (!channel || notification.channel === channel) {
          notification.read = true;
          count++;
        }
      }
    }

    if (count > 0) {
      this.emit('bulk-updated', { channel, count });
    }

    return count;
  }

  /**
   * Get statistics
   */
  getStats(): NotificationStats {
    const all = this.getAll();

    const stats: NotificationStats = {
      total: all.length,
      unread: all.filter(n => !n.read).length,
      byChannel: {
        mqtt: 0,
        threads: 0,
        memory: 0,
      },
      byType: {},
    };

    for (const notification of all) {
      // Count by channel
      stats.byChannel[notification.channel]++;

      // Count by type
      stats.byType[notification.type] = (stats.byType[notification.type] || 0) + 1;

      // Count unread by channel
      if (!notification.read) {
        stats.byChannel[notification.channel]++;
      }
    }

    return stats;
  }

  /**
   * Delete notification
   */
  delete(id: string): boolean {
    const deleted = this.notifications.delete(id);
    if (deleted) {
      this.emit('notification-deleted', id);
    }
    return deleted;
  }

  /**
   * Clear old notifications
   */
  private cleanup() {
    if (this.notifications.size <= this.maxNotifications) {
      return;
    }

    // Get oldest notifications
    const sorted = Array.from(this.notifications.entries()).sort((a, b) =>
      new Date(a[1].timestamp).getTime() - new Date(b[1].timestamp).getTime()
    );

    // Remove oldest
    const toRemove = sorted.slice(0, sorted.length - this.maxNotifications);
    for (const [id] of toRemove) {
      this.notifications.delete(id);
    }

    if (toRemove.length > 0) {
      console.log(`🧹 Notification System: cleaned up ${toRemove.length} old notifications`);
    }
  }

  /**
   * Clear all notifications
   */
  clearAll() {
    this.notifications.clear();
    this.emit('all-cleared');
  }
}

/**
 * Singleton instance
 */
let notificationSystem: NotificationSystem | null = null;

export function getNotificationSystem(): NotificationSystem {
  if (!notificationSystem) {
    notificationSystem = new NotificationSystem();
  }
  return notificationSystem;
}

export function initNotificationSystem(): NotificationSystem {
  if (!notificationSystem) {
    notificationSystem = new NotificationSystem();
  }
  return notificationSystem;
}
