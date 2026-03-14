import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
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
import { TerminalView } from "./components/TerminalView";
import { OrbitalView } from "./components/OrbitalView";
import { InboxOverlay } from "./components/InboxView";
import { WorktreeView } from "./components/WorktreeView";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { JumpOverlay } from "./components/JumpOverlay";
import { unlockAudio, isAudioUnlocked, setSoundMuted } from "./lib/sounds";
import { useFleetStore } from "./lib/store";
import type { AgentState } from "./lib/types";

function parseHash(raw: string): { view: string; agentName: string | null } {
  const parts = raw.split("/");
  const view = parts[0] || "office";
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
    if (lastView && lastView !== "office") {
      window.location.hash = lastView;
      return lastView;
    }
    return "office";
  });

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1) || "office";
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

/** Shared layout — StatusBar + overlays rendered once for all views */
function Layout({ activeView, connected, agentCount, sessionCount, askCount, muted, onToggleMute, onJump, onInbox, statusBarChildren, terminalModal, showShortcuts, onCloseShortcuts, jumpOverlay, inboxOverlay, fullHeight, children }: {
  activeView: string;
  connected: boolean;
  agentCount: number;
  sessionCount: number;
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
  fullHeight?: boolean;
  children: ReactNode;
}) {
  const wrapperClass = fullHeight
    ? "relative flex flex-col h-screen overflow-hidden"
    : "relative min-h-screen";

  return (
    <div className={wrapperClass} style={{ background: "#020208" }}>
      <div className={`relative z-10${fullHeight ? " flex-shrink-0" : ""}`}>
        <StatusBar connected={connected} agentCount={agentCount} sessionCount={sessionCount} activeView={activeView} onJump={onJump} askCount={askCount} onInbox={onInbox} muted={muted} onToggleMute={onToggleMute}>
          {statusBarChildren}
        </StatusBar>
      </div>
      {children}
      {terminalModal}
      {showShortcuts && <ShortcutOverlay onClose={onCloseShortcuts} />}
      {jumpOverlay}
      {inboxOverlay}
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

  const { sessions, agents, eventLog, addEvent, handleMessage, feedActive, agentFeedLog } = useSessions();

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
  const { connected, send } = useWebSocket(handleMessage);

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
    agentCount: agents.length,
    sessionCount: sessions.length,
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
  };

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
        <FleetGrid sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} eventLog={eventLog} addEvent={addEvent} feedActive={feedActive} agentFeedLog={agentFeedLog} />
      </Layout>
    );
  }

  if (route === "mission") {
    return (
      <Layout activeView="mission" {...layoutProps}>
        <MissionControl sessions={sessions} agents={agents} connected={connected} send={send} onSelectAgent={onSelectAgent} eventLog={eventLog} addEvent={addEvent} />
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
