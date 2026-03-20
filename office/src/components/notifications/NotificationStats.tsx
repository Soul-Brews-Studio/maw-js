/**
 * NotificationStats - Statistics display
 */

import { NotificationStats as Stats } from './types';

interface NotificationStatsProps {
  stats: Stats;
}

export function NotificationStats({ stats }: NotificationStatsProps) {
  return (
    <div style={{ padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
      {/* Header */}
      <div style={{ marginBottom: '12px', fontSize: '14px', fontWeight: 'bold' }}>
        Notification Statistics
      </div>

      {/* Total & Unread */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'rgba(255,255,255,0.9)' }}>
            {stats.total}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
            Total
          </div>
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#3b82f6' }}>
            {stats.unread}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
            Unread
          </div>
        </div>
      </div>

      {/* By Channel */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '6px' }}>
          By Channel
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <ChannelStat name="MQTT" icon="📡" count={stats.byChannel.mqtt} color="#10b981" />
          <ChannelStat name="Threads" icon="💬" count={stats.byChannel.threads} color="#8b5cf6" />
          <ChannelStat name="Memory" icon="🧠" count={stats.byChannel.memory} color="#f59e0b" />
        </div>
      </div>

      {/* By Type */}
      {Object.keys(stats.byType).length > 0 && (
        <div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '6px' }}>
            By Type
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {Object.entries(stats.byType).map(([type, count]) => (
              <div
                key={type}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  padding: '4px 0',
                }}
              >
                <span style={{ color: 'rgba(255,255,255,0.7)', textTransform: 'capitalize' }}>
                  {type.replace(/_/g, ' ')}
                </span>
                <span style={{ fontWeight: 'bold', color: 'rgba(255,255,255,0.9)' }}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ChannelStatProps {
  name: string;
  icon: string;
  count: number;
  color: string;
}

function ChannelStat({ name, icon, count, color }: ChannelStatProps) {
  const percentage = count > 0 ? ((count / Math.max(1, count)) * 100) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
        <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
          {icon} {name}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'rgba(255,255,255,0.9)' }}>
          {count}
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: '4px',
          backgroundColor: 'rgba(255,255,255,0.1)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            backgroundColor: color,
            width: `${Math.min(100, percentage)}%`,
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}
