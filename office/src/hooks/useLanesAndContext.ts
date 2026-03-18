import { useState, useEffect, useCallback } from "react";
import type { ContextEntry, LaneFilter, AgentHierarchy } from "../../types-enhanced";

interface UseLanesAndContextResult {
  // Context
  contextEntries: ContextEntry[];
  contextStats: any;

  // Lanes
  laneFilters: LaneFilter[];
  laneStats: any;

  // Hierarchy
  agentsHierarchy: AgentHierarchy[];

  // Actions
  toggleLane: (lane: string) => void;
  addContextEntry: (entry: Partial<ContextEntry>) => void;
  searchContext: (symbol: string) => void;
  refreshLanes: () => void;

  // Connection status
  connected: boolean;
}

export function useLanesAndContext(ws: WebSocket | null): UseLanesAndContextResult {
  const [contextEntries, setContextEntries] = useState<ContextEntry[]>([]);
  const [contextStats, setContextStats] = useState<any>(null);
  const [laneFilters, setLaneFilters] = useState<LaneFilter[]>([]);
  const [laneStats, setLaneStats] = useState<any>(null);
  const [agentsHierarchy, setAgentsHierarchy] = useState<AgentHierarchy[]>([]);
  const [connected, setConnected] = useState(false);

  // Request initial data on connect
  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      setConnected(true);

      // Request initial data
      ws.send(JSON.stringify({ type: "lane-filters" }));
      ws.send(JSON.stringify({ type: "agents-hierarchy" }));
      ws.send(JSON.stringify({ type: "context-entries" }));
      ws.send(JSON.stringify({ type: "stats" }));
    }
  }, [ws]);

  // Handle WebSocket messages
  useEffect(() => {
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "lane-filters":
            setLaneFilters(data.filters || []);
            break;

          case "lane-stats":
            setLaneStats(data.stats);
            break;

          case "agents-hierarchy":
            setAgentsHierarchy(data.agents || []);
            break;

          case "context-entries":
            setContextEntries(data.entries || []);
            break;

          case "context-stats":
            setContextStats(data.stats);
            break;

          case "context-entry-added":
            setContextEntries(prev => [...prev, data.entry]);
            break;

          case "agent-status-update":
            setAgentsHierarchy(prev =>
              prev.map(a => a.id === data.agentId ? data.agent : a)
            );
            break;
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.addEventListener("message", handleMessage);
    return () => ws.removeEventListener("message", handleMessage);
  }, [ws]);

  // Actions
  const toggleLane = useCallback((lane: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "lane-filter-toggle",
        lane,
      }));
    }
  }, [ws]);

  const addContextEntry = useCallback((entry: Partial<ContextEntry>) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "context-entry-added",
        entry: {
          agentId: entry.agentId || "unknown",
          kind: entry.kind || "finding",
          summary: entry.summary || "",
          symbols: entry.symbols || [],
          references: entry.references || [],
          lane: entry.lane,
        },
      }));
    }
  }, [ws]);

  const searchContext = useCallback((symbol: string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "context-search",
        symbol,
      }));
    }
  }, [ws]);

  const refreshLanes = useCallback(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "lane-filters" }));
      ws.send(JSON.stringify({ type: "agents-hierarchy" }));
    }
  }, [ws]);

  return {
    contextEntries,
    contextStats,
    laneFilters,
    laneStats,
    agentsHierarchy,
    toggleLane,
    addContextEntry,
    searchContext,
    refreshLanes,
    connected,
  };
}
