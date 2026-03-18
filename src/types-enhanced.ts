import type { ServerWebSocket } from "bun";

// ============================================================================
// ORIGINAL TYPES (retained for compatibility)
// ============================================================================

export type WSData = { target: string | null; previewTargets: Set<string>; mode?: "pty" };
export type MawWS = ServerWebSocket<WSData>;
export type Handler = (ws: MawWS, data: any, engine: any) => void | Promise<void>;

// Forward reference — resolved at runtime via engine.ts
import type { MawEngine } from "./engine";

// ============================================================================
// PHASE 1: AGENT HIERARCHY & LANE ORGANIZATION
// ============================================================================

/**
 * Agent tier levels (three-tier hierarchy)
 * - Master: Research conductor, objective manager
 * - Lead: Domain specialists (Planning, Evidence, Synthesis, Audit)
 * - Worker: Specialist agents under leads
 */
export type AgentTier = "master" | "lead" | "worker";

/**
 * Functional lanes for organizing agents by domain
 * - planning: Task decomposition and dependency mapping
 * - evidence: Source gathering and quality control
 * - synthesis: Narrative construction and citation building
 * - audit: Contradiction detection and validation
 */
export type AgentLane = "planning" | "evidence" | "synthesis" | "audit";

/**
 * Agent status throughout lifecycle
 */
export type AgentStatus = "queued" | "live" | "review" | "complete" | "failed";

/**
 * Extended agent metadata with hierarchy and lane information
 */
export interface AgentHierarchy {
  id: string;              // Unique agent identifier
  name: string;            // Display name
  tier: AgentTier;         // Hierarchy level
  lane?: AgentLane;        // Functional domain (for leads/workers)
  parentId?: string;       // Parent agent ID (for leads/workers)

  // Status tracking
  status: AgentStatus;
  sessionActive: boolean;  // Whether tmux session is active

  // Task management
  current?: string;        // Current task description
  next?: string;           // Next queued task
  recent?: string[];       // Recently completed tasks
  completed?: string[];    // All completed tasks

  // Runtime information
  runtime?: {
    pid?: number;          // Process ID (if available)
    mode: string;          // Execution mode (e.g., "claude", "codex")
    runId: string;         // Unique run identifier
    source: string;        // Where agent was launched from
    startedAt: number;     // Start timestamp
  };
}

// ============================================================================
// PHASE 1: SHARED CONTEXT STORE
// ============================================================================

/**
 * Context entry kinds for different types of knowledge
 */
export type ContextKind = "finding" | "decision" | "blocker" | "work";

/**
 * Compact context entry for efficient knowledge sharing
 *
 * Instead of transferring full state between agents, we use compact
 * entries with summary, symbols, and references to other entries.
 */
export interface ContextEntry {
  id: string;              // Unique entry ID
  agentId: string;         // Agent who created this entry
  kind: ContextKind;       // Type of knowledge

  // Compact representation
  summary: string;         // Brief actionable insight (1-2 sentences)
  symbols: string[];       // Keywords/variables for quick lookup
  references: string[];    // IDs of related context entries (dependency graph)

  // Metadata
  createdAt: number;       // Creation timestamp
  lane?: AgentLane;        // Associated lane (optional)
}

/**
 * Context store for managing shared knowledge between agents
 */
export interface ContextStore {
  // Core operations
  addEntry(entry: ContextEntry): void;
  getEntry(id: string): ContextEntry | undefined;
  getEntriesByAgent(agentId: string): ContextEntry[];
  getEntriesByLane(lane: AgentLane): ContextEntry[];
  getEntriesByKind(kind: ContextKind): ContextEntry[];

  // Query operations
  searchBySymbol(symbol: string): ContextEntry[];
  getRelevantContext(agentId: string, maxEntries?: number): ContextEntry[];

  // Dependency traversal
  getDependencyGraph(entryId: string): ContextEntry[];
  getReferencedEntries(entryId: string): ContextEntry[];

  // Bulk operations
  getAllEntries(): ContextEntry[];
  clear(): void;
}

// ============================================================================
// SESSION STATE (for WebSocket communication)
// ============================================================================

/**
 * Session information from tmux
 */
export interface SessionInfo {
  name: string;
  windows: {
    index: number;
    name: string;
    active: boolean;
  }[];
}

/**
 * Agent session with hierarchy information
 */
export interface AgentSession {
  id: string;
  name: string;
  tier: AgentTier;
  lane?: AgentLane;
  status: AgentStatus;
  sessionActive: boolean;
  parentId?: string;
}

/**
 * Lane filter for UI
 */
export interface LaneFilter {
  lane: AgentLane;
  enabled: boolean;
  agentCount: number;
}

/**
 * WebSocket message types with context support
 */
export interface WSMessage {
  type:
    // Original types
    | "sessions"
    | "capture"
    | "previews"
    | "error"
    | "feed"
    | "feed-history"

    // New: Hierarchy types
    | "agents-hierarchy"
    | "agent-status-update"

    // New: Context types
    | "context-entries"
    | "context-entry-added"
    | "context-request"

    // New: Lane filtering
    | "lane-filters"
    | "lane-filter-toggle";

  data?: any;
  sessions?: SessionInfo[];
  agents?: AgentSession[];
  entries?: ContextEntry[];
  filters?: LaneFilter[];
}

// ============================================================================
// MIGRATION HELPERS
// ============================================================================

/**
 * Convert legacy flat agent list to hierarchical structure
 */
export function toHierarchicalAgents(flatAgents: string[]): AgentHierarchy[] {
  return flatAgents.map((id, index) => ({
    id,
    name: id,
    tier: index === 0 ? "master" : "lead",
    status: "queued" as AgentStatus,
    sessionActive: false,
    runtime: {
      mode: "unknown",
      runId: `run-${Date.now()}-${index}`,
      source: "legacy",
      startedAt: Date.now(),
    },
  }));
}

/**
 * Create default context entry for testing
 */
export function createDefaultContextEntry(
  agentId: string,
  summary: string,
  kind: ContextKind = "finding"
): ContextEntry {
  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind,
    summary,
    symbols: summary.split(" ").filter((w) => w.length > 4),
    references: [],
    createdAt: Date.now(),
  };
}
