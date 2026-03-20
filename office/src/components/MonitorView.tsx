import { useState, useEffect, useRef } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import type { AgentState } from "../lib/types";

interface HealthData {
  agent: string;
  status: "healthy" | "degraded" | "down";
  lastActive: number;
  heartbeat: number;
  inboxCount: number;
  cpu?: number;
  memory?: number;
}

interface Message {
  timestamp: number;
  from: string;
  to?: string;
  type: string;
  content?: string;
}

interface MetricsData {
  websocketLatency: number;
  messageThroughput: number;
  rateLimitTokens: number;
  rateLimitBurst: number;
  callsPerMinute: number;
  errorRate: number;
}

export function MonitorView({
  agents,
  sessions,
  connected,
  send,
}: {
  agents: AgentState[];
  sessions: string[];
  connected: boolean;
  send: (msg: any) => void;
}) {
  const [healthData, setHealthData] = useState<HealthData[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [metrics, setMetrics] = useState<MetricsData>({
    websocketLatency: 0,
    messageThroughput: 0,
    rateLimitTokens: 10,
    rateLimitBurst: 10,
    callsPerMinute: 0,
    errorRate: 0,
  });
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Fetch health data every 5 seconds
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch(`http://${window.location.hostname}:3456/api/health`);
        const data = await res.json();
        setHealthData(data.agents || []);
      } catch (err) {
        console.error("Failed to fetch health:", err);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch metrics every 2 seconds
  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch(`http://${window.location.hostname}:3456/api/stats`);
        const data = await res.json();
        setMetrics({
          websocketLatency: data.latency || 0,
          messageThroughput: data.throughput || 0,
          rateLimitTokens: data.tokens || 10,
          rateLimitBurst: data.burst || 10,
          callsPerMinute: data.callsPerMinute || 0,
          errorRate: data.errorRate || 0,
        });
      } catch (err) {
        console.error("Failed to fetch metrics:", err);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, []);

  // Fetch rate limiter status
  useEffect(() => {
    const fetchRateLimiter = async () => {
      try {
        const res = await fetch(`http://${window.location.hostname}:3456/api/tokens`);
        const data = await res.json();
        setMetrics(prev => ({
          ...prev,
          rateLimitTokens: data.available || 10,
          rateLimitBurst: data.burst || 10,
        }));
      } catch (err) {
        console.error("Failed to fetch rate limiter:", err);
      }
    };

    fetchRateLimiter();
    const interval = setInterval(fetchRateLimiter, 3000);
    return () => clearInterval(interval);
  }, []);

  const ws = useWebSocket((msg) => {
    // Capture messages for live log
    if (msg.type === "message" || msg.type === "notification" || msg.type === "status") {
      setMessages(prev => {
        const newMsg: Message = {
          timestamp: Date.now(),
          from: msg.from || "system",
          to: msg.to,
          type: msg.type,
          content: msg.content || JSON.stringify(msg),
        };
        const updated = [...prev, newMsg];
        // Keep only last 100 messages
        if (updated.length > 100) updated.shift();
        return updated;
      });
    }
  });

  // Auto-scroll message log
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, autoScroll]);

  const filteredMessages = selectedAgent
    ? messages.filter(m => m.from === selectedAgent || m.to === selectedAgent)
    : messages;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-white">🔍 System Monitor</h1>
        <div className="flex items-center gap-4">
          <span className={`px-3 py-1 rounded-full text-sm ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
            {connected ? '🟢 Connected' : '🔴 Disconnected'}
          </span>
          <span className="text-gray-400 text-sm">
            {agents.length} Agents • {sessions.length} Sessions
          </span>
        </div>
      </div>

      {/* Metrics Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          title="WebSocket Latency"
          value={`${metrics.websocketLatency}ms`}
          subtitle="Target: <100ms"
          status={metrics.websocketLatency < 100 ? 'good' : metrics.websocketLatency < 200 ? 'warning' : 'bad'}
        />
        <MetricCard
          title="Message Throughput"
          value={`${metrics.messageThroughput}/min`}
          subtitle="Real-time messages"
          status="good"
        />
        <MetricCard
          title="Rate Limiter"
          value={`${metrics.rateLimitTokens}/${metrics.rateLimitBurst}`}
          subtitle={`${metrics.callsPerMinute} calls/min`}
          status={metrics.rateLimitTokens > 3 ? 'good' : metrics.rateLimitTokens > 1 ? 'warning' : 'bad'}
        />
        <MetricCard
          title="Error Rate"
          value={`${(metrics.errorRate * 100).toFixed(2)}%`}
          subtitle="Last 5 minutes"
          status={metrics.errorRate < 0.01 ? 'good' : metrics.errorRate < 0.05 ? 'warning' : 'bad'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Agent Health Dashboard */}
        <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">🏥 Agent Health</h2>
          <div className="space-y-3">
            {agents.map(agent => {
              const health = healthData.find(h => h.agent === agent.name);
              const statusColor = health?.status === 'healthy' ? 'green' : health?.status === 'degraded' ? 'yellow' : 'red';
              return (
                <div key={agent.target} className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full bg-${statusColor}-500`} />
                    <span className="text-white font-medium">{agent.name}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-gray-400">
                    <span>💬 {health?.inboxCount || 0}</span>
                    <span>⏱️ {health ? `${Math.floor((Date.now() - health.lastActive) / 1000)}s` : 'N/A'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Rate Limiter Monitor */}
        <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">📈 Rate Limiter</h2>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-sm text-gray-400 mb-2">
                <span>Token Bucket</span>
                <span>{metrics.rateLimitTokens}/{metrics.rateLimitBurst}</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-3">
                <div
                  className="h-3 rounded-full bg-gradient-to-r from-green-500 to-blue-500 transition-all"
                  style={{ width: `${(metrics.rateLimitTokens / metrics.rateLimitBurst) * 100}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-gray-800/50 p-3 rounded-lg">
                <div className="text-gray-400">Calls/Min</div>
                <div className="text-2xl font-bold text-white">{metrics.callsPerMinute}</div>
              </div>
              <div className="bg-gray-800/50 p-3 rounded-lg">
                <div className="text-gray-400">Errors</div>
                <div className="text-2xl font-bold text-white">{(metrics.errorRate * 100).toFixed(2)}%</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live Message Log */}
      <div className="bg-gray-900/50 rounded-lg p-6 border border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">💬 Live Messages</h2>
          <div className="flex items-center gap-4">
            <select
              value={selectedAgent || ""}
              onChange={(e) => setSelectedAgent(e.target.value || null)}
              className="bg-gray-800 text-white px-3 py-1 rounded border border-gray-700"
            >
              <option value="">All Agents</option>
              {agents.map(agent => (
                <option key={agent.target} value={agent.name}>{agent.name}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-gray-400">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              Auto-scroll
            </label>
          </div>
        </div>
        <div className="bg-gray-950 rounded-lg p-4 h-96 overflow-y-auto font-mono text-sm">
          {filteredMessages.map((msg, idx) => (
            <div key={idx} className="mb-2 text-gray-300">
              <span className="text-gray-500">
                [{new Date(msg.timestamp).toLocaleTimeString()}]
              </span>
              <span className="text-blue-400">{msg.from}</span>
              {msg.to && <span className="text-gray-500"> → </span>}
              {msg.to && <span className="text-green-400">{msg.to}</span>}
              <span className="text-yellow-400"> [{msg.type}]</span>
              {msg.content && <span className="text-gray-300">: {msg.content}</span>}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  status,
}: {
  title: string;
  value: string;
  subtitle: string;
  status: "good" | "warning" | "bad";
}) {
  const statusColors = {
    good: "bg-green-500/20 text-green-400 border-green-500/30",
    warning: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    bad: "bg-red-500/20 text-red-400 border-red-500/30",
  };

  return (
    <div className={`p-4 rounded-lg border ${statusColors[status]}`}>
      <div className="text-sm text-gray-400">{title}</div>
      <div className="text-2xl font-bold text-white mt-1">{value}</div>
      <div className="text-xs text-gray-500 mt-1">{subtitle}</div>
    </div>
  );
}
