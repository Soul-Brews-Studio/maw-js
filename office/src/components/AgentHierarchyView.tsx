import { useMemo } from "react";
import type { AgentHierarchy } from "../../types-enhanced";

interface AgentHierarchyViewProps {
  agents: AgentHierarchy[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
}

const TIER_CONFIG = {
  master: { label: "Master", color: "#fbbf24", icon: "👑" },
  lead: { label: "Lead", color: "#8b5cf6", icon: "⭐" },
  worker: { label: "Worker", color: "#6b7280", icon: "🔧" },
};

const LANE_CONFIG = {
  planning: { label: "Planning", color: "#3b82f6" },
  evidence: { label: "Evidence", color: "#10b981" },
  synthesis: { label: "Synthesis", color: "#8b5cf6" },
  audit: { label: "Audit", color: "#ef4444" },
};

const STATUS_CONFIG = {
  queued: { label: "Queued", color: "#6b7280" },
  live: { label: "Live", color: "#10b981" },
  review: { label: "Review", color: "#f59e0b" },
  complete: { label: "Complete", color: "#3b82f6" },
  failed: { label: "Failed", color: "#ef4444" },
};

function AgentTreeNode({ agent, level, selectedAgentId, onSelectAgent }: {
  agent: AgentHierarchy;
  level: number;
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
}) {
  const tierConfig = TIER_CONFIG[agent.tier];
  const laneConfig = agent.lane ? LANE_CONFIG[agent.lane] : null;
  const statusConfig = STATUS_CONFIG[agent.status];

  return (
    <div className="ml-4">
      <div
        onClick={() => onSelectAgent && onSelectAgent(agent.id)}
        className={`
          flex items-center gap-2 px-3 py-2 rounded-lg
          transition-all duration-200
          ${selectedAgentId === agent.id
            ? "bg-blue-900/30 border-2 border-blue-500"
            : "bg-gray-800 border-2 border-transparent hover:bg-gray-750"
          }
          ${onSelectAgent ? "cursor-pointer" : ""}
        `}
        style={{ marginLeft: `${level * 16}px` }}
      >
        {/* Tier Icon */}
        <span className="text-lg">{tierConfig.icon}</span>

        {/* Agent Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-white">{agent.name}</span>

            {/* Lane Badge */}
            {laneConfig && (
              <span
                className="px-2 py-0.5 rounded text-xs font-medium"
                style={{
                  backgroundColor: `${laneConfig.color}30`,
                  color: laneConfig.color,
                }}
              >
                {laneConfig.label}
              </span>
            )}

            {/* Status Badge */}
            <span
              className="px-2 py-0.5 rounded text-xs font-medium"
              style={{
                backgroundColor: `${statusConfig.color}30`,
                color: statusConfig.color,
              }}
            >
              {statusConfig.label}
            </span>
          </div>

          {/* Current Task */}
          {agent.current && (
            <div className="text-xs text-gray-400 mt-1 truncate">
              → {agent.current}
            </div>
          )}
        </div>

        {/* Session Active Indicator */}
        {agent.sessionActive && (
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Session Active" />
        )}
      </div>
    </div>
  );
}

export function AgentHierarchyView({ agents, selectedAgentId, onSelectAgent }: AgentHierarchyViewProps) {
  const { hierarchy, stats } = useMemo(() => {
    // Build hierarchy tree
    const rootAgents = agents.filter(a => !a.parentId);

    const buildTree = (parentId?: string): AgentHierarchy[] => {
      return agents
        .filter(a => a.parentId === parentId)
        .map(agent => ({
          ...agent,
          children: buildTree(agent.id),
        }));
    };

    const hierarchy = rootAgents.map(agent => ({
      ...agent,
      children: buildTree(agent.id),
    }));

    // Calculate stats
    const stats = {
      total: agents.length,
      byTier: {
        master: agents.filter(a => a.tier === "master").length,
        lead: agents.filter(a => a.tier === "lead").length,
        worker: agents.filter(a => a.tier === "worker").length,
      },
      byLane: {
        planning: agents.filter(a => a.lane === "planning").length,
        evidence: agents.filter(a => a.lane === "evidence").length,
        synthesis: agents.filter(a => a.lane === "synthesis").length,
        audit: agents.filter(a => a.lane === "audit").length,
      },
      byStatus: {
        queued: agents.filter(a => a.status === "queued").length,
        live: agents.filter(a => a.status === "live").length,
        review: agents.filter(a => a.status === "review").length,
        complete: agents.filter(a => a.status === "complete").length,
        failed: agents.filter(a => a.status === "failed").length,
      },
    };

    return { hierarchy, stats };
  }, [agents]);

  const renderTree = (agent: any, level: number = 0) => {
    return (
      <div key={agent.id}>
        <AgentTreeNode
          agent={agent}
          level={level}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />
        {agent.children && agent.children.map((child: any) =>
          renderTree(child, level + 1)
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-white">🏗️ Hierarchy</span>
            <span className="text-sm text-gray-400">({stats.total} agents)</span>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex gap-2">
            <span className="text-gray-400">Tier:</span>
            <span>👑{stats.byTier.master} ⭐{stats.byTier.lead} 🔧{stats.byTier.worker}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-400">Status:</span>
            <span>
              🟢{stats.byStatus.live} 🟡{stats.byStatus.review} 🔵{stats.byStatus.complete}
            </span>
          </div>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto p-4">
        {hierarchy.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <p className="text-lg mb-2">No agents configured</p>
            <p className="text-sm">Initialize lane organization to get started</p>
          </div>
        ) : (
          <div className="space-y-1">
            {hierarchy.map(agent => renderTree(agent))}
          </div>
        )}
      </div>
    </div>
  );
}
