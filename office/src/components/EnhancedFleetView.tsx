import { useState } from "react";
import { LaneFilterButtons } from "./LaneFilterButtons";
import { ContextPanel } from "./ContextPanel";
import { AgentHierarchyView } from "./AgentHierarchyView";
import { useLanesAndContext } from "../hooks/useLanesAndContext";
import type { AgentState } from "../lib/types";

interface EnhancedFleetViewProps {
  ws: WebSocket | null;
  sessions: any[];
  agents: AgentState[];
  send: (message: any) => void;
  onSelectAgent: (agent: AgentState) => void;
}

export function EnhancedFleetView({ ws, sessions, agents, send, onSelectAgent }: EnhancedFleetViewProps) {
  const [showContext, setShowContext] = useState(true);
  const [showHierarchy, setShowHierarchy] = useState(true);

  const {
    contextEntries,
    contextStats,
    laneFilters,
    laneStats,
    agentsHierarchy,
    toggleLane,
    addContextEntry,
    searchContext,
    connected,
  } = useLanesAndContext(ws);

  // Filter agents based on active lanes
  const filteredAgents = agents.filter(agent => {
    if (!agent.lane) return true; // Show agents without lane
    const activeLanes = laneFilters.filter(f => f.enabled).map(f => f.lane);
    return activeLanes.includes(agent.lane);
  });

  return (
    <div className="flex flex-col h-screen bg-gray-900">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-white">🚀 Enhanced Fleet View</h1>
          <span className={`px-2 py-1 rounded text-xs ${connected ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHierarchy(!showHierarchy)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showHierarchy ? "bg-purple-600 text-white" : "bg-gray-700 text-gray-300"
            }`}
          >
            {showHierarchy ? "📊 Hide" : "📊 Show"} Hierarchy
          </button>
          <button
            onClick={() => setShowContext(!showContext)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              showContext ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-300"
            }`}
          >
            {showContext ? "📝 Hide" : "📝 Show"} Context
          </button>
        </div>
      </div>

      {/* Lane Filters */}
      <div className="bg-gray-800 border-b border-gray-700">
        <LaneFilterButtons
          filters={laneFilters}
          onToggleLane={toggleLane}
          disabled={!connected}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Hierarchy Panel */}
        {showHierarchy && (
          <div className="w-80 flex-shrink-0 border-r border-gray-700">
            <AgentHierarchyView
              agents={agentsHierarchy}
              onSelectAgent={(agentId) => {
                const agent = agents.find(a => a.id === agentId);
                if (agent) onSelectAgent(agent);
              }}
            />
          </div>
        )}

        {/* Center: Agent Grid */}
        <div className="flex-1 p-4 overflow-auto">
          {filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <p className="text-lg mb-2">No agents to display</p>
              <p className="text-sm">Enable lane filters or add agents</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAgents.map((agent) => (
                <div
                  key={agent.id}
                  onClick={() => onSelectAgent(agent)}
                  className="p-4 bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-white">{agent.name}</h3>
                    {agent.sessionActive && (
                      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    )}
                  </div>

                  {/* Lane Badge */}
                  {agent.lane && (
                    <div className="mb-2">
                      <span className="px-2 py-1 bg-blue-900/50 text-blue-300 rounded text-xs">
                        {agent.lane}
                      </span>
                    </div>
                  )}

                  {/* Current Task */}
                  {agent.current && (
                    <div className="text-sm text-gray-400 mb-2">
                      → {agent.current}
                    </div>
                  )}

                  {/* Status */}
                  <div className="text-xs text-gray-500">
                    Status: {agent.status}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Context Panel */}
        {showContext && (
          <div className="w-96 flex-shrink-0 border-l border-gray-700">
            <ContextPanel
              entries={contextEntries}
              onSearchSymbol={searchContext}
              onAddEntry={addContextEntry}
            />
          </div>
        )}
      </div>

      {/* Stats Footer */}
      <div className="px-4 py-2 bg-gray-800 border-t border-gray-700">
        <div className="flex items-center justify-between text-sm text-gray-400">
          <div className="flex gap-4">
            <span>Agents: {filteredAgents.length} / {agents.length}</span>
            <span>Sessions: {sessions.length}</span>
          </div>

          {laneStats && (
            <div className="flex gap-4">
              <span>🟢 Live: {laneStats.byStatus?.live || 0}</span>
              <span>🟡 Review: {laneStats.byStatus?.review || 0}</span>
              <span>🔵 Complete: {laneStats.byStatus?.complete || 0}</span>
            </div>
          )}

          {contextStats && (
            <span>Context Entries: {contextStats.totalEntries || 0}</span>
          )}
        </div>
      </div>
    </div>
  );
}
