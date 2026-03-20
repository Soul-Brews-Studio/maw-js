/**
 * Notification Types
 */

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

export interface NotificationFilters {
  channel?: NotificationChannel | 'all';
  unreadOnly?: boolean;
  search?: string;
}
