import type {
  ContextEntry,
  ContextStore,
  ContextKind,
  AgentLane,
} from "./types-enhanced";

/**
 * In-memory context store implementation
 *
 * Provides compact knowledge sharing between agents without
 * transferring full state. Uses symbol-based lookup and
 * dependency graph traversal.
 */
export class InMemoryContextStore implements ContextStore {
  private entries: Map<string, ContextEntry> = new Map();
  private agentEntries: Map<string, Set<string>> = new Map(); // agentId -> entry IDs
  private laneEntries: Map<AgentLane, Set<string>> = new Map(); // lane -> entry IDs
  private kindEntries: Map<ContextKind, Set<string>> = new Map(); // kind -> entry IDs
  private symbolIndex: Map<string, Set<string>> = new Map(); // symbol -> entry IDs

  // ============================================================================
  // CORE OPERATIONS
  // ============================================================================

  addEntry(entry: ContextEntry): void {
    // Store entry
    this.entries.set(entry.id, entry);

    // Index by agent
    if (!this.agentEntries.has(entry.agentId)) {
      this.agentEntries.set(entry.agentId, new Set());
    }
    this.agentEntries.get(entry.agentId)!.add(entry.id);

    // Index by lane
    if (entry.lane) {
      if (!this.laneEntries.has(entry.lane)) {
        this.laneEntries.set(entry.lane, new Set());
      }
      this.laneEntries.get(entry.lane)!.add(entry.id);
    }

    // Index by kind
    if (!this.kindEntries.has(entry.kind)) {
      this.kindEntries.set(entry.kind, new Set());
    }
    this.kindEntries.get(entry.kind)!.add(entry.id);

    // Index symbols for quick lookup
    for (const symbol of entry.symbols) {
      const normalizedSymbol = symbol.toLowerCase();
      if (!this.symbolIndex.has(normalizedSymbol)) {
        this.symbolIndex.set(normalizedSymbol, new Set());
      }
      this.symbolIndex.get(normalizedSymbol)!.add(entry.id);
    }
  }

  getEntry(id: string): ContextEntry | undefined {
    return this.entries.get(id);
  }

  getEntriesByAgent(agentId: string): ContextEntry[] {
    const ids = this.agentEntries.get(agentId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined);
  }

  getEntriesByLane(lane: AgentLane): ContextEntry[] {
    const ids = this.laneEntries.get(lane);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined);
  }

  getEntriesByKind(kind: ContextKind): ContextEntry[] {
    const ids = this.kindEntries.get(kind);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined);
  }

  // ============================================================================
  // QUERY OPERATIONS
  // ============================================================================

  searchBySymbol(symbol: string): ContextEntry[] {
    const normalizedSymbol = symbol.toLowerCase();
    const ids = this.symbolIndex.get(normalizedSymbol);
    if (!ids) return [];

    return Array.from(ids)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined);
  }

  /**
   * Get relevant context for an agent
   *
   * Returns entries from:
   * 1. This agent's own entries
   * 2. Recent entries (last 10) from other agents
   * 3. Entries referenced by this agent's entries
   */
  getRelevantContext(agentId: string, maxEntries: number = 20): ContextEntry[] {
    const agentEntries = this.getEntriesByAgent(agentId);
    const referencedIds = new Set<string>();

    // Collect referenced entries
    for (const entry of agentEntries) {
      for (const refId of entry.references) {
        referencedIds.add(refId);
      }
    }

    // Get referenced entries
    const referencedEntries = Array.from(referencedIds)
      .map((id) => this.entries.get(id)!)
      .filter((e) => e !== undefined);

    // Combine and sort by recency
    const allEntries = [...agentEntries, ...referencedEntries];
    allEntries.sort((a, b) => b.createdAt - a.createdAt);

    return allEntries.slice(0, maxEntries);
  }

  // ============================================================================
  // DEPENDENCY TRAVERSAL
  // ============================================================================

  /**
   * Get dependency graph for an entry
   *
   * Returns the entry and all entries it references (recursively)
   */
  getDependencyGraph(entryId: string): ContextEntry[] {
    const visited = new Set<string>();
    const result: ContextEntry[] = [];

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const entry = this.entries.get(id);
      if (!entry) return;

      result.push(entry);

      for (const refId of entry.references) {
        traverse(refId);
      }
    };

    traverse(entryId);
    return result;
  }

  /**
   * Get entries that reference this entry
   */
  getReferencedEntries(entryId: string): ContextEntry[] {
    const result: ContextEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.references.includes(entryId)) {
        result.push(entry);
      }
    }

    return result;
  }

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  getAllEntries(): ContextEntry[] {
    return Array.from(this.entries.values());
  }

  clear(): void {
    this.entries.clear();
    this.agentEntries.clear();
    this.laneEntries.clear();
    this.kindEntries.clear();
    this.symbolIndex.clear();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get statistics about the context store
   */
  getStats() {
    return {
      totalEntries: this.entries.size,
      agentCount: this.agentEntries.size,
      laneCounts: Object.fromEntries(
        Array.from(this.laneEntries.entries()).map(([lane, ids]) => [lane, ids.size])
      ),
      kindCounts: Object.fromEntries(
        Array.from(this.kindEntries.entries()).map(([kind, ids]) => [kind, ids.size])
      ),
      symbolCount: this.symbolIndex.size,
    };
  }

  /**
   * Export all entries as JSON (for persistence)
   */
  exportJSON(): string {
    const data = {
      version: 1,
      exportedAt: Date.now(),
      entries: Array.from(this.entries.values()),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import entries from JSON (for loading persisted state)
   */
  importJSON(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.version === 1 && Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          this.addEntry(entry);
        }
      }
    } catch (error) {
      console.error("Failed to import context entries:", error);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/**
 * Global context store instance
 *
 * This is shared across all WebSocket connections and agents
 */
export const globalContextStore = new InMemoryContextStore();

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a finding context entry
 */
export function createFinding(
  agentId: string,
  summary: string,
  symbols: string[],
  references: string[] = [],
  lane?: AgentLane
): ContextEntry {
  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind: "finding",
    summary,
    symbols,
    references,
    createdAt: Date.now(),
    lane,
  };
}

/**
 * Create a decision context entry
 */
export function createDecision(
  agentId: string,
  summary: string,
  symbols: string[] = [],
  references: string[] = []
): ContextEntry {
  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind: "decision",
    summary,
    symbols,
    references,
    createdAt: Date.now(),
  };
}

/**
 * Create a blocker context entry
 */
export function createBlocker(
  agentId: string,
  summary: string,
  symbols: string[] = [],
  references: string[] = []
): ContextEntry {
  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind: "blocker",
    summary,
    symbols,
    references,
    createdAt: Date.now(),
  };
}

/**
 * Create a work context entry
 */
export function createWork(
  agentId: string,
  summary: string,
  symbols: string[] = [],
  references: string[] = []
): ContextEntry {
  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    agentId,
    kind: "work",
    summary,
    symbols,
    references,
    createdAt: Date.now(),
  };
}
