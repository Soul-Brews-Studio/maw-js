import { useMemo } from "react";
import type { Session, AgentState } from "../lib/types";

interface DashboardViewProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
}

export function DashboardView({ sessions, agents, connected }: DashboardViewProps) {
  // Calculate stats
  const stats = useMemo(() => {
    const busyAgents = agents.filter(a => a.status === "busy").length;
    const idleAgents = agents.filter(a => a.status === "idle").length;
    const readyAgents = agents.filter(a => a.status === "ready").length;
    const totalSessions = sessions.length;

    return {
      totalAgents: agents.length,
      busyAgents,
      idleAgents,
      readyAgents,
      totalSessions,
      activeSessions: sessions.filter(s => s.windows.some(w => {
        const target = `${s.name}:${w.index}`;
        const agent = agents.find(a => a.target === target);
        return agent?.status === "busy" || agent?.status === "ready";
      })).length,
    };
  }, [agents, sessions]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2">Dashboard</h1>
          <p className="text-gray-400 text-sm">Multi-Agent Workflow Orchestra</p>
        </div>
        <div className="flex items-center gap-4">
          <span className={`px-4 py-2 rounded-full text-sm font-medium ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
            {connected ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Agents"
          value={stats.totalAgents}
          icon="🤖"
          color="cyan"
        />
        <StatCard
          title="Active Sessions"
          value={stats.activeSessions}
          total={stats.totalSessions}
          icon="🎯"
          color="purple"
        />
        <StatCard
          title="Busy Now"
          value={stats.busyAgents}
          icon="⚡"
          color="yellow"
        />
        <StatCard
          title="Ready"
          value={stats.readyAgents}
          icon="✓"
          color="green"
        />
      </div>

      {/* Agent Status Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Status Distribution */}
        <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">📊 Status Distribution</h2>
          <div className="space-y-3">
            <StatusBar
              label="Busy"
              count={stats.busyAgents}
              total={stats.totalAgents}
              color="yellow"
              percentage={stats.totalAgents ? (stats.busyAgents / stats.totalAgents * 100).toFixed(1) : "0"}
            />
            <StatusBar
              label="Ready"
              count={stats.readyAgents}
              total={stats.totalAgents}
              color="green"
              percentage={stats.totalAgents ? (stats.readyAgents / stats.totalAgents * 100).toFixed(1) : "0"}
            />
            <StatusBar
              label="Idle"
              count={stats.idleAgents}
              total={stats.totalAgents}
              color="gray"
              percentage={stats.totalAgents ? (stats.idleAgents / stats.totalAgents * 100).toFixed(1) : "0"}
            />
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">⚡ Quick Actions</h2>
          <div className="grid grid-cols-2 gap-3">
            <QuickActionButton
              label="Monitor View"
              href="#monitor"
              icon="🔍"
            />
            <QuickActionButton
              label="Orbital View"
              href="#orbital"
              icon="🌌"
            />
            <QuickActionButton
              label="Fleet Control"
              href="#fleet"
              icon="🚀"
            />
            <QuickActionButton
              label="Mission Control"
              href="#mission"
              icon="🎯"
            />
          </div>
        </div>
      </div>

      {/* Recent Sessions */}
      <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
        <h2 className="text-xl font-bold text-white mb-4">🗂️ Sessions Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map(session => {
            const sessionAgents = agents.filter(a => a.session === session.name);
            const busyCount = sessionAgents.filter(a => a.status === "busy").length;
            const readyCount = sessionAgents.filter(a => a.status === "ready").length;

            return (
              <div
                key={session.name}
                className="bg-gray-800/50 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors"
              >
                <h3 className="text-lg font-semibold text-white mb-2">{session.name}</h3>
                <div className="flex items-center gap-4 text-sm text-gray-400">
                  <span>{sessionAgents.length} agents</span>
                  <span className="text-yellow-400">⚡ {busyCount}</span>
                  <span className="text-green-400">✓ {readyCount}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  total,
  icon,
  color,
}: {
  title: string;
  value: number;
  total?: number;
  icon: string;
  color: string;
}) {
  const colorClasses = {
    cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    purple: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    yellow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    green: "bg-green-500/20 text-green-400 border-green-500/30",
    gray: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  };

  return (
    <div className={`p-4 rounded-lg border ${colorClasses[color as keyof typeof colorClasses]}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xl">{icon}</span>
        {total !== undefined && (
          <span className="text-xs text-gray-400">/ {total}</span>
        )}
      </div>
      <div className="text-3xl font-bold text-white mb-1">{value}</div>
      <div className="text-sm text-gray-400">{title}</div>
    </div>
  );
}

function StatusBar({
  label,
  count,
  total,
  color,
  percentage,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
  percentage: string;
}) {
  const colorClasses = {
    yellow: "bg-yellow-500",
    green: "bg-green-500",
    gray: "bg-gray-500",
  };

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-400">{label}</span>
        <span className="text-white font-medium">{count} / {total} ({percentage}%)</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-2">
        <div
          className={`h-2 rounded-full ${colorClasses[color as keyof typeof colorClasses]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function QuickActionButton({
  label,
  href,
  icon,
}: {
  label: string;
  href: string;
  icon: string;
}) {
  return (
    <a
      href={href}
      className="flex flex-col items-center justify-center p-4 bg-gray-800/50 rounded-lg border border-gray-700 hover:bg-gray-800 hover:border-gray-600 transition-all cursor-pointer"
    >
      <span className="text-2xl mb-2">{icon}</span>
      <span className="text-sm text-gray-300">{label}</span>
    </a>
  );
}
