import { useState, useCallback, useMemo, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useSessions } from "./hooks/useSessions";
import { UniverseBg } from "./components/UniverseBg";
import { StatusBar } from "./components/StatusBar";
import { RoomGrid } from "./components/RoomGrid";
import { TerminalModal } from "./components/TerminalModal";
import { MissionControl } from "./components/MissionControl";
import { FleetGrid, FleetControls } from "./components/FleetGrid";
import { OverviewGrid } from "./components/OverviewGrid";
import { VSView } from "./components/VSView";
import { ConfigView } from "./components/ConfigView";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { JumpOverlay } from "./components/JumpOverlay";
import { unlockAudio, isAudioUnlocked, setSoundMuted } from "./lib/sounds";
import { useFleetStore } from "./lib/store";
import type { AgentState } from "./lib/types";
import { EnhancedFleetView } from "./components/EnhancedFleetView";
import { ChatView } from "./components/ChatView";
import { NotificationSidebar } from "./components/notifications";
import { OrbitalView } from "./components/OrbitalView";
import { DashboardView } from "./components/DashboardView";

function useHashRoute() {
  const lastView = useFleetStore((s) => s.lastView);
  const setLastView = useFleetStore((s) => s.setLastView);

  const [hash, setHash] = useState(() => {
    // If URL already has a hash, use it; otherwise restore from server state
    const urlHash = window.location.hash.slice(1);
    if (urlHash) return urlHash;
    if (lastView && lastView !== "dashboard") {
      window.location.hash = lastView;
      return lastView;
    }
    return "dashboard";
  });

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1) || "dashboard";
      setHash(h);
      setLastView(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [setLastView]);

  return hash;
}

/** Unlock audio on first user interaction — small tick to confirm */
function useAudioUnlock() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handler = () => {
      if (!isAudioUnlocked()) {
        unlockAudio();
        setReady(true);
      }
    };
    window.addEventListener("click", handler, { once: true });
    window.addEventListener("keydown", handler, { once: true });
    window.addEventListener("touchstart", handler, { once: true });
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("keydown", handler);
      window.removeEventListener("touchstart", handler);
    };
  }, []);
  return ready;
}

export function App() {
  useAudioUnlock();
  const route = useHashRoute();
  const [selectedAgent, setSelectedAgent] = useState<AgentState | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  // "?" key opens shortcut overlay, "j" or Ctrl+K opens jump overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "?" ) {
        setShowShortcuts(true);
        return;
      }
      const isCtrlB = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b";
      const isCtrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const isSlash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      const isJ = e.key.toLowerCase() === "j" && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (isCtrlB || isCtrlK || isSlash || isJ) {
        e.preventDefault();
        e.stopPropagation();
        setShowJump(true);
      }
      if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShowNotifications(prev => !prev);
      }
      if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.location.hash = "vs";
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const { sessions, agents, eventLog, addEvent, handleMessage, feedActive, agentFeedLog } = useSessions();

  // Sync muted state to sound module
  const muted = useFleetStore((s) => s.muted);
  const toggleMuted = useFleetStore((s) => s.toggleMuted);
  useEffect(() => { setSoundMuted(muted); }, [muted]);
  const { connected, send, ws } = useWebSocket(handleMessage);

  const onSelectAgent = useCallback((agent: AgentState) => {
    setSelectedAgent(agent);
    send({ type: "select", target: agent.target });
  }, [send]);

  // Agents in the same session as the selected agent
  const siblings = useMemo(() => {
    if (!selectedAgent) return [];
    return agents.filter(a => a.session === selectedAgent.session);
  }, [agents, selectedAgent]);

  const onNavigate = useCallback((dir: -1 | 1) => {
    if (!selectedAgent || siblings.length <= 1) return;
    const idx = siblings.findIndex(a => a.target === selectedAgent.target);
    const next = siblings[(idx + dir + siblings.length) % siblings.length];
    setSelectedAgent(next);
    send({ type: "select", target: next.target });
  }, [selectedAgent, siblings, send]);

  const jumpOverlay = showJump && (
    <JumpOverlay
      agents={agents}
      onSelect={onSelectAgent}
      onClose={() => setShowJump(false)}
    />
  );

  const terminalModal = selectedAgent && (
    <TerminalModal
      agent={selectedAgent}
      send={send}
      onClose={() => setSelectedAgent(null)}
      onNavigate={onNavigate}
      onSelectSibling={onSelectAgent}
      siblings={siblings}
    />
  );

  if (route === "overview") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        {showNotifications && (
          <div className="absolute z-50" style={{ right: 0, top: 0, height: '100vh' }}>
            <NotificationSidebar
              wsUrl={`ws://${window.location.hostname}:3456/ws`}
              onClose={() => setShowNotifications(false)}
            />
          </div>
        )}
        <div className="relative z-10">
          <StatusBar
            connected={connected}
            agentCount={agents.length}
            sessionCount={sessions.length}
            activeView="overview"
            onJump={() => setShowJump(true)}
            muted={muted}
            onToggleMute={toggleMuted}
            onNotifications={() => setShowNotifications(true)}
          />
        </div>
        <OverviewGrid
          sessions={sessions}
          agents={agents}
          connected={connected}
          send={send}
          onSelectAgent={onSelectAgent}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}

      </div>
    );
  }

  if (route === "fleet") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="fleet" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted}>
            <FleetControls agents={agents} send={send} />
          </StatusBar>
        </div>
        <FleetGrid
          sessions={sessions}
          agents={agents}
          connected={connected}
          send={send}
          onSelectAgent={onSelectAgent}
          eventLog={eventLog}
          addEvent={addEvent}
          feedActive={feedActive}
          agentFeedLog={agentFeedLog}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}

      </div>
    );
  }

  if (route === "mission") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="mission" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <MissionControl
          sessions={sessions}
          agents={agents}
          connected={connected}
          send={send}
          onSelectAgent={onSelectAgent}
          eventLog={eventLog}
          addEvent={addEvent}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}

      </div>
    );
  }

  if (route === "vs") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="vs" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <VSView agents={agents} send={send} />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "config") {
    return (
      <div className="relative flex flex-col h-screen overflow-hidden" style={{ background: "#020208" }}>
        <div className="relative z-10 flex-shrink-0">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="config" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <ConfigView />
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "chat") {
    return (
      <div className="relative h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="chat" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <ChatView agents={agents} send={send} connected={connected} />
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "enhanced") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="enhanced" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <EnhancedFleetView
          ws={ws.current}
          sessions={sessions}
          agents={agents}
          send={send}
          onSelectAgent={onSelectAgent}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "monitor") {
    // Inline MonitorView to ensure it's included in bundle
    function InlineMonitorView({
      agents,
      sessions,
      connected,
      send,
    }: {
      agents: AgentState[];
      sessions: any[];
      connected: boolean;
      send: (msg: any) => void;
    }) {
      console.log('[InlineMonitorView] Rendering with', agents.length, 'agents');

      const [healthData, setHealthData] = useState<any[]>([]);
      const [messages, setMessages] = useState<any[]>([]);
      const [metrics, setMetrics] = useState({
        websocketLatency: 0,
        messageThroughput: 0,
        rateLimitTokens: 10,
        rateLimitBurst: 10,
        callsPerMinute: 0,
        errorRate: 0,
      });
      const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
      const [autoScroll, setAutoScroll] = useState(true);

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
              subtitle="Target: &lt;100ms"
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
                  const health = healthData.find(h => h.agent.includes(agent.name));
                  const statusColor = health?.status === 'healthy' ? 'green' : health?.status === 'degraded' ? 'yellow' : 'red';
                  return (
                    <div key={agent.target} className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full bg-${statusColor}-500`} />
                        <span className="text-white font-medium">{agent.name}</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-gray-400">
                        <span>💬 {health?.inboxCount || 0}</span>
                        <span>⏱️ {health ? 'Active' : 'N/A'}</span>
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

    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="monitor" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <InlineMonitorView
          agents={agents}
          sessions={sessions}
          connected={connected}
          send={send}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "dashboard") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="dashboard" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <DashboardView
          sessions={sessions}
          agents={agents}
          connected={connected}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  if (route === "orbital") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="orbital" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <OrbitalView
          sessions={sessions}
          agents={agents}
          connected={connected}
          onSelectAgent={onSelectAgent}
        />
        {terminalModal}
        {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
        {jumpOverlay}
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <UniverseBg />
      <div className="relative z-10">
        <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="office" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        <RoomGrid sessions={sessions} agents={agents} onSelectAgent={onSelectAgent} />
      </div>
      {terminalModal}
      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
      {jumpOverlay}
    </div>
  );
}
