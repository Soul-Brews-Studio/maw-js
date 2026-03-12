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
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const { sessions, agents, saiyanTargets, saiyanSources, eventLog, addEvent, handleMessage, feedActive, agentFeedLog } = useSessions();

  // Sync muted state to sound module
  const muted = useFleetStore((s) => s.muted);
  const toggleMuted = useFleetStore((s) => s.toggleMuted);
  useEffect(() => { setSoundMuted(muted); }, [muted]);
  const { connected, send } = useWebSocket(handleMessage);

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
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="overview" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        </div>
        <OverviewGrid
          sessions={sessions}
          agents={agents}
          saiyanTargets={saiyanTargets}
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
          saiyanTargets={saiyanTargets}
          saiyanSources={saiyanSources}
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
          saiyanTargets={saiyanTargets}
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

  return (
    <div className="relative min-h-screen">
      <UniverseBg />
      <div className="relative z-10">
        <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="office" onJump={() => setShowJump(true)} muted={muted} onToggleMute={toggleMuted} />
        <RoomGrid sessions={sessions} agents={agents} saiyanTargets={saiyanTargets} onSelectAgent={onSelectAgent} />
      </div>
      {terminalModal}
      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
      {jumpOverlay}
    </div>
  );
}
