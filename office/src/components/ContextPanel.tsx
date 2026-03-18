import { useState, useMemo } from "react";
import type { ContextEntry } from "../../types-enhanced";

interface ContextPanelProps {
  entries: ContextEntry[];
  onSearchSymbol?: (symbol: string) => void;
  onAddEntry?: (entry: Partial<ContextEntry>) => void;
}

const KIND_CONFIG = {
  finding: { label: "Finding", color: "#3b82f6", icon: "💡" },
  decision: { label: "Decision", color: "#10b981", icon: "✓" },
  blocker: { label: "Blocker", color: "#ef4444", icon: "🚫" },
  work: { label: "Work", color: "#f59e0b", icon: "⚙️" },
};

const LANE_CONFIG = {
  planning: { label: "Planning", color: "#3b82f6" },
  evidence: { label: "Evidence", color: "#10b981" },
  synthesis: { label: "Synthesis", color: "#8b5cf6" },
  audit: { label: "Audit", color: "#ef4444" },
};

export function ContextPanel({ entries, onSearchSymbol, onAddEntry }: ContextPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<string>("all");
  const [selectedLane, setSelectedLane] = useState<string>("all");

  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      const matchesSearch = !searchQuery ||
        entry.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
        entry.symbols.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesKind = selectedKind === "all" || entry.kind === selectedKind;
      const matchesLane = selectedLane === "all" || entry.lane === selectedLane;

      return matchesSearch && matchesKind && matchesLane;
    });
  }, [entries, searchQuery, selectedKind, selectedLane]);

  const stats = useMemo(() => {
    return {
      total: entries.length,
      byKind: {
        finding: entries.filter(e => e.kind === "finding").length,
        decision: entries.filter(e => e.kind === "decision").length,
        blocker: entries.filter(e => e.kind === "blocker").length,
        work: entries.filter(e => e.kind === "work").length,
      },
      byLane: {
        planning: entries.filter(e => e.lane === "planning").length,
        evidence: entries.filter(e => e.lane === "evidence").length,
        synthesis: entries.filter(e => e.lane === "synthesis").length,
        audit: entries.filter(e => e.lane === "audit").length,
      },
    };
  }, [entries]);

  return (
    <div className="flex flex-col h-full bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-white">📝 Context</span>
          <span className="text-sm text-gray-400">({stats.total} entries)</span>
        </div>
        <button
          onClick={() => onAddEntry && onAddEntry({})}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors"
        >
          + Add Entry
        </button>
      </div>

      {/* Filters */}
      <div className="px-4 py-2 bg-gray-850 border-b border-gray-700 space-y-2">
        {/* Search */}
        <input
          type="text"
          placeholder="Search entries or symbols..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-400 focus:outline-none focus:border-blue-500"
        />

        {/* Kind Filter */}
        <div className="flex gap-2">
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
            className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Kinds</option>
            {Object.entries(KIND_CONFIG).map(([kind, config]) => (
              <option key={kind} value={kind}>
                {config.icon} {config.label} ({stats.byKind[kind as keyof typeof stats.byKind]})
              </option>
            ))}
          </select>

          <select
            value={selectedLane}
            onChange={(e) => setSelectedLane(e.target.value)}
            className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Lanes</option>
            {Object.entries(LANE_CONFIG).map(([lane, config]) => (
              <option key={lane} value={lane}>
                {config.label} ({stats.byLane[lane as keyof typeof stats.byLane]})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Entries List */}
      <div className="flex-1 overflow-y-auto">
        {filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <p className="text-lg mb-2">No context entries found</p>
            <p className="text-sm">Try adjusting filters or add a new entry</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-700">
            {filteredEntries.map((entry) => {
              const kindConfig = entry.kind ? KIND_CONFIG[entry.kind] : null;
              const laneConfig = entry.lane ? LANE_CONFIG[entry.lane] : null;

              return (
                <div
                  key={entry.id}
                  className="px-4 py-3 hover:bg-gray-800 transition-colors cursor-pointer"
                >
                  {/* Header */}
                  <div className="flex items-start gap-2 mb-2">
                    <span className="text-xl">{kindConfig?.icon || "📄"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-white">
                          {entry.summary}
                        </span>
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
                      </div>
                      <div className="text-xs text-gray-400">
                        By {entry.agentId} • {new Date(entry.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Symbols */}
                  {entry.symbols.length > 0 && (
                    <div className="flex flex-wrap gap-1 ml-7">
                      {entry.symbols.map((symbol, idx) => (
                        <span
                          key={idx}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSearchSymbol && onSearchSymbol(symbol);
                          }}
                          className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded text-xs cursor-pointer hover:bg-blue-800/50 transition-colors"
                          title="Click to search"
                        >
                          #{symbol}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* References */}
                  {entry.references.length > 0 && (
                    <div className="ml-7 mt-2 text-xs text-gray-500">
                      References: {entry.references.length} entries
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
