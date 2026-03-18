import type { AgentHierarchy, AgentLane, AgentTier } from "./types-enhanced";

// ============================================================================
// LANE DEFINITIONS
// ============================================================================

/**
 * Lane configuration with agent templates
 */
export interface LaneConfig {
  lane: AgentLane;
  label: string;
  emoji: string;
  color: string;
  description: string;
  defaultAgents: Partial<AgentHierarchy>[];
}

/**
 * Default lane configurations
 */
export const LANE_CONFIGS: Record<AgentLane, LaneConfig> = {
  planning: {
    lane: "planning",
    label: "Planning",
    emoji: "📋",
    color: "#3b82f6", // blue
    description: "Task decomposition and dependency mapping",
    defaultAgents: [
      {
        id: "plan-mgr",
        name: "Plan Manager",
        tier: "lead",
        lane: "planning",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "plan-mgr-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "task-breaker",
        name: "Task Breaker",
        tier: "worker",
        lane: "planning",
        parentId: "plan-mgr",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "task-breaker-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
    ],
  },

  evidence: {
    lane: "evidence",
    label: "Evidence",
    emoji: "🔍",
    color: "#10b981", // green
    description: "Source gathering and quality control",
    defaultAgents: [
      {
        id: "evidence-lead",
        name: "Evidence Lead",
        tier: "lead",
        lane: "evidence",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "evidence-lead-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "researcher",
        name: "Researcher",
        tier: "worker",
        lane: "evidence",
        parentId: "evidence-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "researcher-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "data-collector",
        name: "Data Collector",
        tier: "worker",
        lane: "evidence",
        parentId: "evidence-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "data-collector-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
    ],
  },

  synthesis: {
    lane: "synthesis",
    label: "Synthesis",
    emoji: "✍️",
    color: "#8b5cf6", // purple
    description: "Narrative construction and citation building",
    defaultAgents: [
      {
        id: "synthesis-lead",
        name: "Synthesis Lead",
        tier: "lead",
        lane: "synthesis",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "synthesis-lead-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "writer",
        name: "Writer",
        tier: "worker",
        lane: "synthesis",
        parentId: "synthesis-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "writer-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "editor",
        name: "Editor",
        tier: "worker",
        lane: "synthesis",
        parentId: "synthesis-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "editor-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
    ],
  },

  audit: {
    lane: "audit",
    label: "Audit",
    emoji: "🔬",
    color: "#ef4444", // red
    description: "Contradiction detection and validation",
    defaultAgents: [
      {
        id: "audit-lead",
        name: "Audit Lead",
        tier: "lead",
        lane: "audit",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "audit-lead-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "reviewer",
        name: "Reviewer",
        tier: "worker",
        lane: "audit",
        parentId: "audit-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "reviewer-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
      {
        id: "qa-checker",
        name: "QA Checker",
        tier: "worker",
        lane: "audit",
        parentId: "audit-lead",
        status: "queued",
        sessionActive: false,
        runtime: {
          mode: "claude",
          runId: "qa-checker-init",
          source: "lane-config",
          startedAt: Date.now(),
        },
      },
    ],
  },
};

// ============================================================================
// LANE ORGANIZATION MANAGER
// ============================================================================

/**
 * Lane filter state for UI
 */
export interface LaneFilter {
  lane: AgentLane;
  enabled: boolean;
  agentCount: number;
}

/**
 * Lane organization manager
 *
 * Manages agents organized by functional lanes with filtering
 * and statistics.
 */
export class LaneOrganization {
  private agents: Map<string, AgentHierarchy> = new Map();
  private laneFilters: Map<AgentLane, boolean> = new Map();

  constructor() {
    // Initialize all lane filters as enabled
    for (const lane of Object.keys(LANE_CONFIGS) as AgentLane[]) {
      this.laneFilters.set(lane, true);
    }
  }

  // ============================================================================
  // AGENT MANAGEMENT
  // ============================================================================

  /**
   * Add an agent to the organization
   */
  addAgent(agent: AgentHierarchy): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Remove an agent from the organization
   */
  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Remove all children recursively
    for (const [id, a] of this.agents.entries()) {
      if (a.parentId === agentId) {
        this.removeAgent(id);
      }
    }

    this.agents.delete(agentId);
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): AgentHierarchy | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agents
   */
  getAllAgents(): AgentHierarchy[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by tier
   */
  getAgentsByTier(tier: AgentTier): AgentHierarchy[] {
    return Array.from(this.agents.values()).filter((a) => a.tier === tier);
  }

  /**
   * Get agents by lane
   */
  getAgentsByLane(lane: AgentLane): AgentHierarchy[] {
    return Array.from(this.agents.values()).filter((a) => a.lane === lane);
  }

  /**
   * Get child agents of a parent
   */
  getChildAgents(parentId: string): AgentHierarchy[] {
    return Array.from(this.agents.values()).filter((a) => a.parentId === parentId);
  }

  // ============================================================================
  // LANE FILTERING
  // ============================================================================

  /**
   * Set lane filter state
   */
  setLaneFilter(lane: AgentLane, enabled: boolean): void {
    this.laneFilters.set(lane, enabled);
  }

  /**
   * Get lane filter state
   */
  getLaneFilter(lane: AgentLane): boolean {
    return this.laneFilters.get(lane) ?? true;
  }

  /**
   * Toggle lane filter
   */
  toggleLaneFilter(lane: AgentLane): boolean {
    const current = this.getLaneFilter(lane);
    const newState = !current;
    this.setLaneFilter(lane, newState);
    return newState;
  }

  /**
   * Get all lane filters with counts
   */
  getLaneFilters(): LaneFilter[] {
    return Array.from(this.laneFilters.entries()).map(([lane, enabled]) => ({
      lane,
      enabled,
      agentCount: this.getAgentsByLane(lane).length,
    }));
  }

  /**
   * Get filtered agents based on active lane filters
   */
  getFilteredAgents(): AgentHierarchy[] {
    const activeLanes = Array.from(this.laneFilters.entries())
      .filter(([_, enabled]) => enabled)
      .map(([lane]) => lane);

    return Array.from(this.agents.values()).filter(
      (a) => !a.lane || activeLanes.includes(a.lane)
    );
  }

  // ============================================================================
  // HIERARCHY OPERATIONS
  // ============================================================================

  /**
   * Build hierarchical tree from flat agent list
   */
  buildHierarchy(): AgentHierarchy[] {
    const agents = Array.from(this.agents.values());
    const rootAgents: AgentHierarchy[] = [];

    // Find root agents (no parent)
    for (const agent of agents) {
      if (!agent.parentId) {
        rootAgents.push(agent);
      }
    }

    // Recursively build tree
    const buildTree = (parent: AgentHierarchy): AgentHierarchy => {
      const children = this.getChildAgents(parent.id);
      return {
        ...parent,
        children: children.map(buildTree),
      };
    };

    return rootAgents.map(buildTree);
  }

  /**
   * Get agent hierarchy path (from root to agent)
   */
  getAgentPath(agentId: string): AgentHierarchy[] {
    const path: AgentHierarchy[] = [];
    let current = this.agents.get(agentId);

    while (current) {
      path.unshift(current);
      current = current.parentId ? this.agents.get(current.parentId) : undefined;
    }

    return path;
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  /**
   * Get statistics about the organization
   */
  getStats() {
    const agents = Array.from(this.agents.values());

    return {
      totalAgents: agents.length,
      byTier: {
        master: agents.filter((a) => a.tier === "master").length,
        lead: agents.filter((a) => a.tier === "lead").length,
        worker: agents.filter((a) => a.tier === "worker").length,
      },
      byLane: {
        planning: this.getAgentsByLane("planning").length,
        evidence: this.getAgentsByLane("evidence").length,
        synthesis: this.getAgentsByLane("synthesis").length,
        audit: this.getAgentsByLane("audit").length,
      },
      byStatus: {
        queued: agents.filter((a) => a.status === "queued").length,
        live: agents.filter((a) => a.status === "live").length,
        review: agents.filter((a) => a.status === "review").length,
        complete: agents.filter((a) => a.status === "complete").length,
        failed: agents.filter((a) => a.status === "failed").length,
      },
      activeLanes: Array.from(this.laneFilters.entries()).filter(([_, e]) => e).length,
    };
  }

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  /**
   * Clear all agents
   */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Initialize with default lane configuration
   */
  initializeWithDefaults(): void {
    this.clear();

    for (const config of Object.values(LANE_CONFIGS)) {
      for (const agentTemplate of config.defaultAgents) {
        this.addAgent({
          ...agentTemplate,
          status: "queued",
          sessionActive: false,
        } as AgentHierarchy);
      }
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/**
 * Global lane organization instance
 *
 * Shared across all WebSocket connections
 */
export const globalLaneOrganization = new LaneOrganization();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get lane configuration
 */
export function getLaneConfig(lane: AgentLane): LaneConfig {
  return LANE_CONFIGS[lane];
}

/**
 * Get all lane configurations
 */
export function getAllLaneConfigs(): LaneConfig[] {
  return Object.values(LANE_CONFIGS);
}

/**
 * Format lane label with emoji
 */
export function formatLaneLabel(lane: AgentLane): string {
  const config = getLaneConfig(lane);
  return `${config.emoji} ${config.label}`;
}

/**
 * Convert legacy flat agent list to hierarchical structure
 */
export function convertLegacyAgents(legacyAgents: string[]): AgentHierarchy[] {
  return legacyAgents.map((id, index) => {
    // First agent becomes master, rest become leads
    const tier: AgentTier = index === 0 ? "master" : "lead";

    return {
      id,
      name: id,
      tier,
      lane: undefined, // Legacy agents don't have lanes
      status: "queued",
      sessionActive: false,
      runtime: {
        mode: "unknown",
        runId: `legacy-${Date.now()}-${index}`,
        source: "legacy-conversion",
        startedAt: Date.now(),
      },
    };
  });
}
