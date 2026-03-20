/**
 * NotificationSidebar - Main notification center sidebar
 */

import { useState, useEffect } from 'react';
import { Notification, NotificationStats, NotificationFilters } from './types';
import { NotificationItem } from './NotificationItem';
import { NotificationStats as NotificationStatsDisplay } from './NotificationStats';

interface NotificationSidebarProps {
  wsUrl?: string;
  onClose?: () => void;
}

export function NotificationSidebar({ wsUrl = 'ws://localhost:3456/ws', onClose }: NotificationSidebarProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [filters, setFilters] = useState<NotificationFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch notifications on mount
  useEffect(() => {
    fetchNotifications();
    fetchStats();

    // Set up polling for updates
    const interval = setInterval(() => {
      fetchStats();
    }, 10000); // Update stats every 10s

    return () => clearInterval(interval);
  }, []);

  // WebSocket connection for real-time updates
  useEffect(() => {
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'notification') {
          // New notification received
          setNotifications(prev => [data.notification, ...prev]);
          fetchStats();
        } else if (data.type === 'notification-updated') {
          // Notification marked as read
          setNotifications(prev =>
            prev.map(n => (n.id === data.notification.id ? data.notification : n))
          );
          fetchStats();
        } else if (data.type === 'notifications-bulk-updated') {
          // Bulk update
          if (data.data.channel === 'all' || !data.data.channel) {
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
          } else {
            setNotifications(prev =>
              prev.map(n => (n.channel === data.data.channel ? { ...n, read: true } : n))
            );
          }
          fetchStats();
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setError('Connection error');
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const fetchNotifications = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (filters.channel && filters.channel !== 'all') {
        params.append('channel', filters.channel);
      }
      if (filters.unreadOnly) {
        params.append('unreadOnly', 'true');
      }

      const response = await fetch(`http://localhost:3456/api/notifications?${params}`);
      if (!response.ok) throw new Error('Failed to fetch notifications');

      const data = await response.json();
      setNotifications(data);
    } catch (e: any) {
      console.error('Failed to fetch notifications:', e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch('http://localhost:3456/api/notifications/stats');
      if (!response.ok) throw new Error('Failed to fetch stats');

      const data = await response.json();
      setStats(data);
    } catch (e: any) {
      console.error('Failed to fetch stats:', e);
    }
  };

  const handleMarkAsRead = async (id: string) => {
    try {
      const response = await fetch(`http://localhost:3456/api/notifications/${id}/read`, {
        method: 'POST',
      });

      if (!response.ok) throw new Error('Failed to mark as read');

      // Update local state
      setNotifications(prev =>
        prev.map(n => (n.id === id ? { ...n, read: true } : n))
      );
    } catch (e: any) {
      console.error('Failed to mark as read:', e);
      setError(e.message);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.channel && filters.channel !== 'all') {
        params.append('channel', filters.channel);
      }

      const response = await fetch(`http://localhost:3456/api/notifications/read-all?${params}`, {
        method: 'POST',
      });

      if (!response.ok) throw new Error('Failed to mark all as read');

      // Update local state
      setNotifications(prev =>
        prev.map(n => {
          if (filters.channel === 'all' || !filters.channel) {
            return { ...n, read: true };
          }
          return n.channel === filters.channel ? { ...n, read: true } : n;
        })
      );

      await fetchStats();
    } catch (e: any) {
      console.error('Failed to mark all as read:', e);
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(`http://localhost:3456/api/notifications/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete notification');

      // Update local state
      setNotifications(prev => prev.filter(n => n.id !== id));
      await fetchStats();
    } catch (e: any) {
      console.error('Failed to delete notification:', e);
      setError(e.message);
    }
  };

  const filteredNotifications = notifications.filter(n => {
    if (filters.search) {
      const search = filters.search.toLowerCase();
      return (
        n.title.toLowerCase().includes(search) ||
        n.message.toLowerCase().includes(search)
      );
    }
    return true;
  });

  return (
    <div
      style={{
        width: '360px',
        height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 'bold' }}>
          Notifications
          {stats && stats.unread > 0 && (
            <span
              style={{
                marginLeft: '8px',
                padding: '2px 8px',
                backgroundColor: '#3b82f6',
                borderRadius: '10px',
                fontSize: '12px',
                fontWeight: 'bold',
              }}
            >
              {stats.unread}
            </span>
          )}
        </h2>

        {onClose && (
          <button
            onClick={onClose}
            style={{
              padding: '4px 8px',
              backgroundColor: 'transparent',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Filters */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <FilterButton
            active={filters.channel === 'all' || !filters.channel}
            onClick={() => setFilters({ ...filters, channel: 'all' })}
          >
            All
          </FilterButton>
          <FilterButton
            active={filters.channel === 'mqtt'}
            onClick={() => setFilters({ ...filters, channel: 'mqtt' })}
          >
            📡 MQTT
          </FilterButton>
          <FilterButton
            active={filters.channel === 'threads'}
            onClick={() => setFilters({ ...filters, channel: 'threads' })}
          >
            💬 Threads
          </FilterButton>
          <FilterButton
            active={filters.channel === 'memory'}
            onClick={() => setFilters({ ...filters, channel: 'memory' })}
          >
            🧠 Memory
          </FilterButton>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <FilterButton
            active={filters.unreadOnly}
            onClick={() => setFilters({ ...filters, unreadOnly: !filters.unreadOnly })}
          >
            {filters.unreadOnly ? '🔵 Unread' : '📖 All'}
          </FilterButton>

          <button
            onClick={() => setFilters({ ...filters, search: '' })}
            style={{
              padding: '6px 12px',
              backgroundColor: filters.search ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: '4px',
              color: 'white',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search notifications..."
          value={filters.search || ''}
          onChange={e => setFilters({ ...filters, search: e.target.value })}
          style={{
            width: '100%',
            padding: '8px',
            marginTop: '8px',
            backgroundColor: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '4px',
            color: 'white',
            fontSize: '13px',
          }}
        />
      </div>

      {/* Stats */}
      {stats && <NotificationStatsDisplay stats={stats} />}

      {/* Mark all as read */}
      {!filters.unreadOnly && stats && stats.unread > 0 && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <button
            onClick={handleMarkAllAsRead}
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: 'rgba(59, 130, 246, 0.2)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              borderRadius: '6px',
              color: 'white',
              fontSize: '14px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            Mark All as Read ({stats.unread})
          </button>
        </div>
      )}

      {/* Notifications list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.5)' }}>
            Loading...
          </div>
        ) : error ? (
          <div style={{ padding: '20px', color: '#ef4444' }}>
            Error: {error}
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.5)' }}>
            {filters.search ? 'No notifications match your search' : 'No notifications yet'}
          </div>
        ) : (
          filteredNotifications.map(notification => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onMarkAsRead={handleMarkAsRead}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface FilterButtonProps {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function FilterButton({ active, onClick, children }: FilterButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px',
        backgroundColor: active ? 'rgba(59, 130, 246, 0.3)' : 'transparent',
        border: active ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid rgba(255,255,255,0.2)',
        borderRadius: '4px',
        color: active ? 'white' : 'rgba(255,255,255,0.7)',
        fontSize: '12px',
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
    >
      {children}
    </button>
  );
}
