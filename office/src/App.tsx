import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useSessions } from "./hooks/useSessions";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UniverseBg } from "./components/UniverseBg";
import { StatusBar } from "./components/StatusBar";
import { RoomGrid } from "./components/RoomGrid";
import { TerminalModal } from "./components/TerminalModal";
import { MissionControl } from "./components/MissionControl";
import { FleetGrid, FleetControls, BroadcastModal } from "./components/FleetGrid";
import { OverviewGrid } from "./components/OverviewGrid";
import { OrbitalView } from "./components/OrbitalView";
import { VSView } from "./components/VSView";
import { ConfigView } from "./components/ConfigView";
import { TeamPanel } from "./components/TeamPanel";
import { TerminalView } from "./components/TerminalView";
import { InboxOverlay } from "./components/InboxView";
import { WorktreeView } from "./components/WorktreeView";
import { ChatView } from "./components/ChatView";
import { DashboardView } from "./components/DashboardView";
import { LoadingSkeleton } from "./components/LoadingSkeleton";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { JumpOverlay } from "./components/JumpOverlay";
import { OracleSearch } from "./components/OracleSearch";
import { unlockAudio, isAudioUnlocked, setSoundMuted, SOUND_PROFILES, getSoundProfile, setSoundProfile, previewSound } from "./lib/sounds";

function FloatingButtons() {
  const [showSounds, setShowSounds] = useState(false);
  const [current, setCurrent] = useState(getSoundProfile());
  const [multiView, setMultiView] = useState(() => localStorage.getItem("office-multiview") !== "0");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSounds) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShowSounds(false); };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [showSounds]);

  return (
    <div ref={ref} className="fixed top-20 right-6 flex flex-col gap-3 z-30">
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("search-open"))}
        className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl backdrop-blur-xl active:scale-90 cursor-pointer transition-all shadow-lg"
        style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.25)", color: "#22d3ee" }}
        title="Oracle Search (⌘K)"
      >🔍</button>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("broadcast-open"))}
        className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl backdrop-blur-xl active:scale-90 cursor-pointer transition-all shadow-lg"
        style={{ background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.25)", color: "#fbbf24" }}
        title="Broadcast to all agents"
      >📢</button>
      <button
        onClick={() => setShowSounds(!showSounds)}
        className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl backdrop-blur-xl active:scale-90 cursor-pointer transition-all shadow-lg"
        style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.25)", color: "#a855f7" }}
        title="Change notification sound"
      >{SOUND_PROFILES.find(p => p.id === current)?.emoji || "🔔"}</button>

      <button
        onClick={() => {
          const next = !multiView;
          setMultiView(next);
          localStorage.setItem("office-multiview", next ? "1" : "0");
          window.dispatchEvent(new CustomEvent("multiview-change", { detail: next }));
        }}
        className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl backdrop-blur-xl active:scale-90 cursor-pointer transition-all shadow-lg"
        style={{ background: multiView ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.06)", border: `1px solid ${multiView ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.1)"}`, color: multiView ? "#22c55e" : "#666" }}
        title={multiView ? "Multi-card view (click for single)" : "Single card view (click for multi)"}
      >{multiView ? "📺" : "1️⃣"}</button>

      {showSounds && (
        <div className="absolute right-16 top-[8.5rem] rounded-2xl overflow-hidden" style={{ background: "rgba(13,13,24,0.95)", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(12px)", minWidth: 200 }}>
          {SOUND_PROFILES.map(p => (
            <button key={p.id} onClick={() => { setSoundProfile(p.id); setCurrent(p.id); previewSound(p.id); }}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.06]"
              style={{ background: current === p.id ? "rgba(168,85,247,0.12)" : "transparent" }}>
              <span className="text-2xl">{p.emoji}</span>
              <span className="text-sm font-mono" style={{ color: current === p.id ? "#a855f7" : "rgba(255,255,255,0.5)" }}>{p.label}</span>
              {current === p.id && <span className="ml-auto text-sm text-purple-400">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
import { useFleetStore } from "./lib/store";
import type { AgentState } from "./lib/types";

function parseHash(raw: string): { view: string; agentName: string | null } {
  const parts = raw.split("/");
  const view = parts[0] || "mission";
  const agentName = parts[1] || null;
  return { view, agentName };
}

function useHashRoute() {
  const lastView = useFleetStore((s) => s.lastView);
  const setLastView = useFleetStore((s) => s.setLastView);

  const [hash, setHash] = useState(() => {
    // If URL already has a hash, use it; otherwise restore from server state
    const urlHash = window.location.hash.slice(1);
    if (urlHash) return urlHash;
    if (lastView) {
      window.location.hash = lastView;
      return lastView;
    }
    return "mission";
  });

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1) || "mission";
      setHash(h);
      // Persist just the view part (not the agent)
      setLastView(parseHash(h).view);
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
    // Use capture phase so it doesn't interfere with click handlers
    window.addEventListener("pointerdown", handler, { once: true, capture: true });
    window.addEventListener("keydown", handler, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", handler, { capture: true });
      window.removeEventListener("keydown", handler, { capture: true });
    };
  }, []);
  return ready;
}

/** Shared layout — StatusBar + overlays rendered once for all views */
function Layout({ activeView, connected, reconnecting, agentCount, sessionCount, tabCount, askCount, muted, onToggleMute, onJump, onInbox, statusBarChildren, terminalModal, showShortcuts, onCloseShortcuts, jumpOverlay, inboxOverlay, broadcastModal, fullHeight, children }: {
  activeView: string;
  connected: boolean;
  reconnecting?: boolean;
  agentCount: number;
  sessionCount: number;
  tabCount?: number;
  askCount: number;
  muted: boolean;
  onToggleMute: () => void;
  onJump: () => void;
  onInbox: () => void;
  statusBarChildren?: ReactNode;
  terminalModal: ReactNode;
  showShortcuts: boolean;
  onCloseShortcuts: () => void;
  jumpOverlay: ReactNode;
  inboxOverlay: ReactNode;
  broadcastModal?: ReactNode;
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const wrapperClass = fullHeight
    ? "relative flex flex-col h-screen overflow-hidden"
    : "relative min-h-screen";

  return (
    <div className={wrapperClass} style={{ background: "#020208" }}>
      <div className={`relative z-10${fullHeight ? " flex-shrink-0" : ""}`}>
        <StatusBar connected={connected} agentCount={agentCount} sessionCount={sessionCount} tabCount={tabCount} activeView={activeView} onJump={onJump} askCount={askCount} onInbox={onInbox} muted={muted} onToggleMute={onToggleMute}>
          {statusBarChildren}
        </StatusBar>
      </div>
      {children}
      {terminalModal}
      {showShortcuts && <ShortcutOverlay onClose={onCloseShortcuts} />}
      {jumpOverlay}
      {inboxOverlay}
      {broadcastModal}

      {/* Floating action buttons — top right */}
      <FloatingButtons />

      {/* Connection lost overlay */}
      {reconnecting && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto text-center px-8 py-6 rounded-2xl backdrop-blur-xl" style={{ background: "rgba(0,0,0,0.85)", border: "1px solid rgba(239,68,68,0.3)" }}>
            <div className="text-3xl mb-3 animate-pulse">📡</div>
            <p className="font-mono text-sm" style={{ color: "#ef4444" }}>Connection lost</p>
            <p className="font-mono text-xs mt-1" style={{ color: "rgba(255,255,255,0.4)" }}>Reconnecting...</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  useAudioUnlock();
  const rawRoute = useHashRoute();
  const { view: route, agentName: hashAgent } = parseHash(rawRoute);
  const [selectedAgent, setSelectedAgent] = useState<AgentState | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showOracleSearch, setShowOracleSearch] = useState(false);

  // Listen for floating button events
  useEffect(() => {
    const onBroadcast = () => setShowBroadcast(true);
    const onSearch = () => setShowOracleSearch(true);
    window.addEventListener("broadcast-open", onBroadcast);
    window.addEventListener("search-open", onSearch);
    return () => { window.removeEventListener("broadcast-open", onBroadcast); window.removeEventListener("search-open", onSearch); };
  }, []);

  // Track current route for keyboard handler (avoid stale closure)
  const routeRef = useRef(route);
  useEffect(() => { routeRef.current = route; }, [route]);

  // "?" key opens shortcut overlay, "j" or Ctrl+K opens jump overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Terminal view captures all keystrokes — don't fire global shortcuts
      if (routeRef.current === "terminal") return;
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
      if (e.key.toLowerCase() === "v" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.location.hash = "vs";
      }
      if (e.key.toLowerCase() === "i" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setShowInbox(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const { sessions, agents, eventLog, addEvent, handleMessage, feedEvents, feedActive, agentFeedLog, teams } = useSessions();

  // Resolve hash agent name → AgentState once agents are loaded
  const pendingHashAgent = useRef(hashAgent);
  useEffect(() => { pendingHashAgent.current = hashAgent; }, [hashAgent]);
  const resolvedFromHash = useRef(false);
  useEffect(() => {
    if (resolvedFromHash.current || !pendingHashAgent.current || agents.length === 0) return;
    const name = pendingHashAgent.current.toLowerCase();
    const match = agents.find(a => a.name.toLowerCase() === name);
    if (match) {
      setSelectedAgent(match);
      resolvedFromHash.current = true;
    }
  }, [agents]);

  // Close terminal when hash loses the agent part (e.g. browser back)
  useEffect(() => {
    if (!hashAgent && selectedAgent) {
      setSelectedAgent(null);
    }
  }, [hashAgent, selectedAgent]);

  // Ask count for inbox badge
  const askCount = useFleetStore((s) => s.asks.filter((a) => !a.dismissed).length);

  // Sync muted state to sound module
  const muted = useFleetStore((s) => s.muted);
  const toggleMuted = useFleetStore((s) => s.toggleMuted);
  useEffect(() => { setSoundMuted(muted); }, [muted]);
  const { connected, reconnecting, send } = useWebSocket(handleMessage);

  const onSelectAgent = useCallback((agent: AgentState) => {
    setSelectedAgent(agent);
    send({ type: "select", target: agent.target });
    // Push agent name into URL hash for deep-linking
    const currentView = parseHash(window.location.hash.slice(1)).view;
    window.location.hash = `${currentView}/${agent.name}`;
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
    const currentView = parseHash(window.location.hash.slice(1)).view;
    window.location.hash = `${currentView}/${next.name}`;
  }, [selectedAgent, siblings, send]);

  const onCloseTerminal = useCallback(() => {
    setSelectedAgent(null);
    // Remove agent name from hash, keep just the view
    const currentView = parseHash(window.location.hash.slice(1)).view;
    window.location.hash = currentView;
  }, []);

  // Shared props for Layout
  const layoutProps = {
    connected,
    reconnecting,
    agentCount: agents.length,
    sessionCount: sessions.length,
    tabCount: sessions.reduce((sum, s) => sum + s.windows.length, 0),
    askCount,
    muted,
    onToggleMute: toggleMuted,
    onJump: () => setShowJump(true),
    onInbox: () => setShowInbox(true),
    terminalModal: selectedAgent ? (
      <TerminalModal agent={selectedAgent} send={send} onClose={onCloseTerminal} onNavigate={onNavigate} onSelectSibling={onSelectAgent} siblings={siblings} />
    ) : null,
    showShortcuts,
    onCloseShortcuts: () => setShowShortcuts(false),
    jumpOverlay: showJump ? <JumpOverlay agents={agents} onSelect={onSelectAgent} onClose={() => setShowJump(false)} /> : null,
    inboxOverlay: showInbox ? <InboxOverlay send={send} onClose={() => setShowInbox(false)} /> : null,
    broadcastModal: (<>
      {showBroadcast && <BroadcastModal agents={agents} send={send} onClose={() => setShowBroadcast(false)} />}
      {showOracleSearch && <OracleSearch onClose={() => setShowOracleSearch(false)} />}
    </>),
  };

  // Show loading skeleton while WebSocket is connecting (before first sessions message)
  const loading = !connected && agents.length === 0;

  if (loading) {
    return (
      <Layout activeView={route} {...layoutProps}>
        <LoadingSkeleton />
      </Layout>
    );
  }

  if (route === "office") {
    return (
      <Layout activeView="office" {...layoutProps}>
        <UniverseBg />
        <div className="relative z-10">
          <RoomGrid sessions={sessions} agents={agents} onSelectAgent={onSelectAgent} />
        </div>
      </Layout>
    );
  }

  if (route === "fleet") {
    return (
      <Layout activeView="fleet" {...layoutProps} statusBarChildren={<FleetControls agents={agents} send={send} />}>
        <FleetGrid sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} eventLog={eventLog} addEvent={addEvent} feedActive={feedActive} agentFeedLog={agentFeedLog} teams={teams} />
      </Layout>
    );
  }

  if (route === "mission") {
    return (
      <Layout activeView="mission" {...layoutProps}>
        <MissionControl sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} eventLog={eventLog} addEvent={addEvent} teams={teams} />
      </Layout>
    );
  }

  if (route === "vs") {
    return (
      <Layout activeView="vs" {...layoutProps}>
        <VSView agents={agents} send={send} />
      </Layout>
    );
  }

  if (route === "overview") {
    return (
      <Layout activeView="overview" {...layoutProps}>
        <OverviewGrid sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} />
      </Layout>
    );
  }

  if (route === "worktrees") {
    return (
      <Layout activeView="worktrees" {...layoutProps}>
        <WorktreeView />
      </Layout>
    );
  }

  if (route === "teams") {
    return (
      <Layout activeView="teams" {...layoutProps}>
        <TeamPanel teams={teams} />
      </Layout>
    );
  }

  if (route === "config") {
    return (
      <Layout activeView="config" {...layoutProps} fullHeight>
        <ConfigView />
      </Layout>
    );
  }

  if (route === "terminal") {
    return (
      <Layout activeView="terminal" {...layoutProps} fullHeight>
        <TerminalView sessions={sessions} agents={agents} connected={connected} onSelectAgent={onSelectAgent} />
      </Layout>
    );
  }

  if (route === "orbital") {
    return (
      <Layout activeView="orbital" {...layoutProps}>
        <OrbitalView sessions={sessions} agents={agents} connected={connected} onSelectAgent={onSelectAgent} />
      </Layout>
    );
  }

  if (route === "dashboard") {
    return (
      <Layout activeView="dashboard" {...layoutProps}>
        <DashboardView sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} eventLog={eventLog} feedEvents={feedEvents} feedActive={feedActive} agentFeedLog={agentFeedLog} />
      </Layout>
    );
  }

  if (route === "chat") {
    return (
      <Layout activeView="chat" {...layoutProps}>
        <ChatView />
      </Layout>
    );
  }

  // Fallback → office
  return (
    <Layout activeView="office" {...layoutProps}>
      <UniverseBg />
      <div className="relative z-10">
        <RoomGrid sessions={sessions} agents={agents} onSelectAgent={onSelectAgent} />
      </div>
    </Layout>
  );
}
