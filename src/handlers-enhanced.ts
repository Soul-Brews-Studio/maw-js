import type { MawWS, Handler } from "./types";
import type { ContextEntry, LaneFilter } from "./types-enhanced";
import { globalContextStore } from "./context-store";
import { globalLaneOrganization } from "./lane-organization";

// ============================================================================
// CONTEXT STORE HANDLERS
// ============================================================================

/**
 * Get all context entries
 *
 * Request: { type: "context-entries" }
 * Response: { type: "context-entries", entries: ContextEntry[] }
 */
export const handleGetContextEntries: Handler = async (ws, _data, engine) => {
  const entries = globalContextStore.getAllEntries();
  ws.send(JSON.stringify({ type: "context-entries", entries }));
};

/**
 * Get relevant context for an agent
 *
 * Request: { type: "context-request", agentId: string, maxEntries?: number }
 * Response: { type: "context-request", agentId: string, entries: ContextEntry[] }
 */
export const handleContextRequest: Handler = async (ws, data) => {
  const { agentId, maxEntries = 20 } = data;
  const entries = globalContextStore.getRelevantContext(agentId, maxEntries);
  ws.send(JSON.stringify({ type: "context-request", agentId, entries }));
};

/**
 * Add a context entry
 *
 * Request: {
 *   type: "context-entry-added",
 *   entry: {
 *     agentId: string,
 *     kind: "finding" | "decision" | "blocker" | "work",
 *     summary: string,
 *     symbols: string[],
 *     references: string[],
 *     lane?: "planning" | "evidence" | "synthesis" | "audit"
 *   }
 * }
 * Response: { type: "context-entry-added", entry: ContextEntry }
 */
export const handleAddContextEntry: Handler = async (ws, data, engine) => {
  const { agentId, kind, summary, symbols = [], references = [], lane } = data;

  const entry: ContextEntry = {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind,
    summary,
    symbols,
    references,
    createdAt: Date.now(),
    lane,
  };

  globalContextStore.addEntry(entry);

  // Broadcast to all clients
  const msg = JSON.stringify({ type: "context-entry-added", entry });
  if (engine && typeof engine.broadcast === 'function') {
    engine.broadcast(msg);
  }

  ws.send(JSON.stringify({ type: "context-entry-added", entry }));
};

/**
 * Search context by symbol
 *
 * Request: { type: "context-search", symbol: string }
 * Response: { type: "context-search", symbol: string, entries: ContextEntry[] }
 */
export const handleContextSearch: Handler = async (ws, data) => {
  const { symbol } = data;
  const entries = globalContextStore.searchBySymbol(symbol);
  ws.send(JSON.stringify({ type: "context-search", symbol, entries }));
};

/**
 * Get context dependency graph
 *
 * Request: { type: "context-dependencies", entryId: string }
 * Response: { type: "context-dependencies", entryId: string, entries: ContextEntry[] }
 */
export const handleContextDependencies: Handler = async (ws, data) => {
  const { entryId } = data;
  const entries = globalContextStore.getDependencyGraph(entryId);
  ws.send(JSON.stringify({ type: "context-dependencies", entryId, entries }));
};

// ============================================================================
// LANE ORGANIZATION HANDLERS
// ============================================================================

/**
 * Get all lane filters with counts
 *
 * Request: { type: "lane-filters" }
 * Response: { type: "lane-filters", filters: LaneFilter[] }
 */
export const handleGetLaneFilters: Handler = async (_ws, _data, engine) => {
  const filters = globalLaneOrganization.getLaneFilters();
  const msg = JSON.stringify({ type: "lane-filters", filters });

  // Broadcast to all clients
  for (const client of (engine as any).clients) {
    client.send(msg);
  }
};

/**
 * Toggle lane filter
 *
 * Request: { type: "lane-filter-toggle", lane: string }
 * Response: { type: "lane-filter-toggle", lane: string, enabled: boolean }
 */
export const handleToggleLaneFilter: Handler = async (ws, data, engine) => {
  const { lane } = data;
  const enabled = globalLaneOrganization.toggleLaneFilter(lane);

  // Broadcast updated filters to all clients
  const filters = globalLaneOrganization.getLaneFilters();
  const msg = JSON.stringify({ type: "lane-filters", filters });

  for (const client of (engine as any).clients) {
    client.send(msg);
  }

  ws.send(JSON.stringify({ type: "lane-filter-toggle", lane, enabled }));
};

/**
 * Get all agents (hierarchical)
 *
 * Request: { type: "agents-hierarchy" }
 * Response: { type: "agents-hierarchy", agents: AgentHierarchy[] }
 */
export const handleGetAgentsHierarchy: Handler = async (_ws, _data, engine) => {
  const agents = globalLaneOrganization.getAllAgents();
  const msg = JSON.stringify({ type: "agents-hierarchy", agents });

  // Broadcast to all clients
  for (const client of (engine as any).clients) {
    client.send(msg);
  }
};

/**
 * Get agents by lane
 *
 * Request: { type: "agents-by-lane", lane: string }
 * Response: { type: "agents-by-lane", lane: string, agents: AgentHierarchy[] }
 */
export const handleGetAgentsByLane: Handler = async (ws, data) => {
  const { lane } = data;
  const agents = globalLaneOrganization.getAgentsByLane(lane);
  ws.send(JSON.stringify({ type: "agents-by-lane", lane, agents }));
};

/**
 * Get filtered agents (based on active lane filters)
 *
 * Request: { type: "agents-filtered" }
 * Response: { type: "agents-filtered", agents: AgentHierarchy[] }
 */
export const handleGetFilteredAgents: Handler = async (ws, _data) => {
  const agents = globalLaneOrganization.getFilteredAgents();
  ws.send(JSON.stringify({ type: "agents-filtered", agents }));
};

/**
 * Update agent status
 *
 * Request: {
 *   type: "agent-status-update",
 *   agentId: string,
 *   status: "queued" | "live" | "review" | "complete" | "failed",
 *   current?: string,
 *   next?: string
 * }
 * Response: { type: "agent-status-update", agentId: string, agent: AgentHierarchy }
 */
export const handleAgentStatusUpdate: Handler = async (ws, data, engine) => {
  const { agentId, status, current, next } = data;
  const agent = globalLaneOrganization.getAgent(agentId);

  if (agent) {
    agent.status = status;
    if (current !== undefined) agent.current = current;
    if (next !== undefined) agent.next = next;

    // Broadcast to all clients
    const msg = JSON.stringify({ type: "agent-status-update", agentId, agent });
    for (const client of (engine as any).clients) {
      client.send(msg);
    }

    ws.send(JSON.stringify({ type: "agent-status-update", agentId, agent }));
  }
};

// ============================================================================
// UTILITY HANDLERS
// ============================================================================

/**
 * Get system statistics
 *
 * Request: { type: "stats" }
 * Response: { type: "stats", context: {...}, lanes: {...} }
 */
export const handleGetStats: Handler = async (ws, _data) => {
  const contextStats = globalContextStore.getStats();
  const laneStats = globalLaneOrganization.getStats();

  ws.send(
    JSON.stringify({
      type: "stats",
      context: contextStats,
      lanes: laneStats,
    })
  );
};

/**
 * Clear all context entries (use with caution)
 *
 * Request: { type: "context-clear" }
 * Response: { type: "context-clear", success: boolean }
 */
export const handleClearContext: Handler = async (ws, _data, engine) => {
  globalContextStore.clear();

  // Broadcast to all clients
  const msg = JSON.stringify({ type: "context-clear", success: true });
  for (const client of (engine as any).clients) {
    client.send(msg);
  }

  ws.send(msg);
};

/**
 * Initialize lane organization with defaults
 *
 * Request: { type: "lane-init" }
 * Response: { type: "lane-init", success: boolean, agents: AgentHierarchy[] }
 */
export const handleInitLanes: Handler = async (ws, _data, engine) => {
  globalLaneOrganization.initializeWithDefaults();
  const agents = globalLaneOrganization.getAllAgents();

  // Broadcast to all clients
  const msg = JSON.stringify({ type: "lane-init", success: true, agents });
  for (const client of (engine as any).clients) {
    client.send(msg);
  }

  ws.send(msg);
};

// ============================================================================
// HANDLER REGISTRATION
// ============================================================================

/**
 * Register all enhanced handlers with the engine
 */
export function registerEnhancedHandlers(engine: any): void {
  // Context store handlers
  engine.on("context-entries", handleGetContextEntries);
  engine.on("context-request", handleContextRequest);
  engine.on("context-entry-added", handleAddContextEntry);
  engine.on("context-search", handleContextSearch);
  engine.on("context-dependencies", handleContextDependencies);

  // Lane organization handlers
  engine.on("lane-filters", handleGetLaneFilters);
  engine.on("lane-filter-toggle", handleToggleLaneFilter);
  engine.on("agents-hierarchy", handleGetAgentsHierarchy);
  engine.on("agents-by-lane", handleGetAgentsByLane);
  engine.on("agents-filtered", handleGetFilteredAgents);
  engine.on("agent-status-update", handleAgentStatusUpdate);

  // Utility handlers
  engine.on("stats", handleGetStats);
  engine.on("context-clear", handleClearContext);
  engine.on("lane-init", handleInitLanes);
}
