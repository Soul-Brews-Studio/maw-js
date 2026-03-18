import { useMemo } from "react";
import type { LaneFilter } from "../../types-enhanced";

interface LaneFilterButtonsProps {
  filters: LaneFilter[];
  onToggleLane: (lane: string) => void;
  disabled?: boolean;
}

const LANE_CONFIG = {
  planning: { label: "📋 Planning", color: "#3b82f6" },
  evidence: { label: "🔍 Evidence", color: "#10b981" },
  synthesis: { label: "✍️ Synthesis", color: "#8b5cf6" },
  audit: { label: "🔬 Audit", color: "#ef4444" },
};

export function LaneFilterButtons({ filters, onToggleLane, disabled = false }: LaneFilterButtonsProps) {
  const enabledCount = useMemo(() => filters.filter(f => f.enabled).length, [filters]);

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="text-sm text-gray-400 mr-2">
        Lanes ({enabledCount}/{filters.length})
      </span>
      <div className="flex gap-2">
        {filters.map((filter) => {
          const config = LANE_CONFIG[filter.lane];
          return (
            <button
              key={filter.lane}
              onClick={() => onToggleLane(filter.lane)}
              disabled={disabled}
              className={`
                relative px-3 py-1.5 rounded-lg text-sm font-medium
                transition-all duration-200
                ${disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:scale-105 active:scale-95"
                }
                ${filter.enabled
                  ? "bg-opacity-100 shadow-lg"
                  : "bg-opacity-30 opacity-60"
                }
              `}
              style={{
                backgroundColor: filter.enabled ? config.color : `${config.color}30`,
                color: filter.enabled ? "#fff" : "#aaa",
              }}
              title={`${filter.lane} lane: ${filter.agentCount} agents`}
            >
              {config.label}
              <span className={`
                absolute -top-1 -right-1
                w-5 h-5 rounded-full text-xs
                flex items-center justify-center
                ${filter.enabled ? "bg-white text-gray-800" : "bg-gray-600 text-white"}
              `}>
                {filter.agentCount}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
