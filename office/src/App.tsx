import { useState, useCallback, useMemo, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useSessions } from "./hooks/useSessions";
import { useSessionsWasm } from "./hooks/useSessionsWasm";
import { UniverseBg } from "./components/UniverseBg";
import { StatusBar } from "./components/StatusBar";
import { RoomGrid } from "./components/RoomGrid";
import { TerminalModal } from "./components/TerminalModal";
import { MissionControl } from "./components/MissionControl";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { unlockAudio, isAudioUnlocked } from "./lib/sounds";
import type { AgentState } from "./lib/types";

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash.slice(1) || "office");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash.slice(1) || "office");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
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

  // "?" key opens shortcut overlay (only when no input is focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement)) {
        setShowShortcuts(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ?vm=1 enables WASM engine for state management
  const useWasm = new URLSearchParams(window.location.search).has("vm");
  const sessionsHook = useWasm ? useSessionsWasm() : useSessions();
  const { sessions, agents, saiyanTargets, eventLog, addEvent, handleMessage } = sessionsHook;
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

  if (route === "mission") {
    return (
      <div className="relative min-h-screen" style={{ background: "#020208" }}>
        <div className="relative z-10">
          <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="mission" />
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
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <UniverseBg />
      <div className="relative z-10">
        <StatusBar connected={connected} agentCount={agents.length} sessionCount={sessions.length} activeView="office" />
        <RoomGrid sessions={sessions} agents={agents} saiyanTargets={saiyanTargets} onSelectAgent={onSelectAgent} />
      </div>
      {terminalModal}
      {showShortcuts && <ShortcutOverlay onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
