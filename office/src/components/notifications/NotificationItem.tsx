/**
 * NotificationItem - Individual notification display
 */

import { Notification } from './types';

interface NotificationItemProps {
  notification: Notification;
  onMarkAsRead?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const channelIcons: Record<string, string> = {
  mqtt: '📡',
  threads: '💬',
  memory: '🧠',
};

const typeIcons: Record<string, string> = {
  task_created: '📋',
  consultation_created: '💡',
  urgent_message: '🚨',
  thread_created: '🧵',
  thread_activity: '💬',
  thread_synced: '✅',
  content_synced: '📝',
  sync_status: '🔄',
};

export function NotificationItem({ notification, onMarkAsRead, onDelete }: NotificationItemProps) {
  const { id, channel, type, title, message, timestamp, read } = notification;

  const timeAgo = getTimeAgo(new Date(timestamp));
  const channelIcon = channelIcons[channel] || '📌';
  const typeIcon = typeIcons[type] || '🔔';

  const handleClick = () => {
    if (!read && onMarkAsRead) {
      onMarkAsRead(id);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(id);
    }
  };

  return (
    <div
      className={`notification-item ${read ? 'read' : 'unread'}`}
      onClick={handleClick}
      style={{
        padding: '12px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        cursor: 'pointer',
        backgroundColor: read ? 'transparent' : 'rgba(59, 130, 246, 0.1)',
        transition: 'all 0.2s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        {/* Icon */}
        <div style={{ fontSize: '24px', lineHeight: 1 }}>
          {typeIcon}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            {/* Channel badge */}
            <span
              style={{
                fontSize: '12px',
                padding: '2px 6px',
                borderRadius: '3px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.7)',
              }}
            >
              {channelIcon} {channel}
            </span>

            {/* Title */}
            <span style={{ fontWeight: 'bold', fontSize: '14px' }}>
              {title}
            </span>
          </div>

          {/* Message */}
          <div
            style={{
              fontSize: '13px',
              color: 'rgba(255,255,255,0.8)',
              marginBottom: '4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {message}
          </div>

          {/* Metadata */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
            {/* Time */}
            <span>{timeAgo}</span>

            {/* Metadata badges */}
            {notification.metadata?.task_id && (
              <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                Task: {notification.metadata.task_id.slice(0, 8)}...
              </span>
            )}

            {notification.metadata?.priority === 'urgent' && (
              <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>
                URGENT
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {!read && (
            <button
              onClick={handleClick}
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                borderRadius: '3px',
                color: 'rgba(255,255,255,0.8)',
                cursor: 'pointer',
              }}
            >
            • Mark read
            </button>
          )}

          <button
            onClick={handleDelete}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '3px',
              color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
