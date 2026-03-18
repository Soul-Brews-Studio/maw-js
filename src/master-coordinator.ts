import { globalLaneOrganization } from "./lane-organization";
import { globalContextStore, createDecision, createBlocker } from "./context-store";
import type { AgentHierarchy, AgentLane, AgentTier } from "../types-enhanced";

// ============================================================================
// MASTER COORDINATOR
// ============================================================================

/**
 * Master agent responsibilities:
 * 1. Overall objective management
 * 2. Lead agent coordination
 * 3. Final synthesis and decision making
 * 4. Conflict resolution
 */
export class MasterCoordinator {
  /**
   * Distribute objective to lead agents
   */
  distributeObjective(objective: string): Map<string, string> {
    const laneTasks = this.decomposeObjective(objective);
    const assignments = new Map<string, string>();

    const leads = globalLaneOrganization.getAgentsByTier("lead");

    for (const lead of leads) {
      if (lead.lane && laneTasks.has(lead.lane)) {
        const task = laneTasks.get(lead.lane)!;
        assignments.set(lead.id, task);

        // Update agent current task
        if (lead.current !== task) {
          lead.current = task;
          lead.status = "live";
        }
      }
    }

    return assignments;
  }

  /**
   * Decompose objective into lane-specific tasks
   */
  private decomposeObjective(objective: string): Map<AgentLane, string> {
    const tasks = new Map<AgentLane, string>();

    // Planning lane: Analyze objective
    tasks.set("planning", `Analyze objective: ${objective}`);

    // Evidence lane: Gather data
    tasks.set("evidence", `Gather evidence for: ${objective}`);

    // Synthesis lane: Prepare narrative
    tasks.set("synthesis", `Draft content for: ${objective}`);

    // Audit lane: Validate work
    tasks.set("audit", `Review and validate: ${objective}`);

    return tasks;
  }

  /**
   * Collect results from lead agents
   */
  async collectResults(objectiveId: string): Promise<{
    planning: any;
    evidence: any;
    synthesis: any;
    audit: any;
  }> {
    const results: any = {
      planning: null,
      evidence: null,
      synthesis: null,
      audit: null
    };

    // Collect from each lead
    const planningLeads = globalLaneOrganization.getAgentsByLane("planning");
    const evidenceLeads = globalLaneOrganization.getAgentsByLane("evidence");
    const synthesisLeads = globalLaneOrganization.getAgentsByLane("synthesis");
    const auditLeads = globalLaneOrganization.getAgentsByLane("audit");

    // Get context entries from each lane
    results.planning = this.getLaneContext("planning", objectiveId);
    results.evidence = this.getLaneContext("evidence", objectiveId);
    results.synthesis = this.getLaneContext("synthesis", objectiveId);
    results.audit = this.getLaneContext("audit", objectiveId);

    return results;
  }

  /**
   * Get context entries from a specific lane
   */
  private getLaneContext(lane: AgentLane, objectiveId: string): any {
    const entries = globalContextStore.getEntriesByLane(lane);
    const relevant = entries.filter(e => e.summary.includes(objectiveId) || e.references.some(r => r.includes(objectiveId)));

    return {
      lane,
      entryCount: entries.length,
      relevantEntries: relevant.length,
      entries: relevant.slice(0, 10) // Top 10
    };
  }

  /**
   * Make final decision based on lead agent inputs
   */
  async makeFinalDecision(objectiveId: string): Promise<string> {
    const results = await this.collectResults(objectiveId);

    // Analyze audit findings
    const auditPassed = results.audit?.relevantEntries > 0 &&
                       !results.audit.entries.some((e: any) => e.kind === "blocker");

    if (!auditPassed) {
      return "FAILED: Audit found blockers";
    }

    // Check if all leads completed
    const planningDone = results.planning?.relevantEntries > 0;
    const evidenceDone = results.evidence?.relevantEntries > 0;
    const synthesisDone = results.synthesis?.relevantEntries > 0;

    if (!planningDone || !evidenceDone || !synthesisDone) {
      return "PENDING: Waiting for all lanes to complete";
    }

    return `COMPLETED: ${objectiveId}`;
  }

  /**
   * Resolve conflicts between lead agents
   */
  async resolveConflict(conflict: {
    type: "resource" | "decision" | "priority";
    agents: string[];
    description: string;
  }): Promise<string> {
    const blockerEntry = createBlocker(
      "master-coordinator",
      `Conflict: ${conflict.description} between ${conflict.agents.join(", ")}`,
      ["conflict", "blocking"],
      [`conflict-${Date.now()}`]
    );

    globalContextStore.addEntry(blockerEntry);

    // Simple resolution: prioritize by lane order
    const lanePriority = ["planning", "evidence", "synthesis", "audit"];

    for (const lane of lanePriority) {
      const conflictedAgent = conflict.agents.find(agentId => {
        const agent = globalLaneOrganization.getAgent(agentId);
        return agent && agent.lane === lane;
      });

      if (conflictedAgent) {
        const decisionEntry = createDecision(
          "master-coordinator",
          `Resolved conflict in favor of ${lane} lane`,
          ["conflict", "resolution"],
          [blockerEntry.id],
          lane
        );

        globalContextStore.addEntry(decisionEntry);
        return `Resolved in favor of ${conflictedAgent} (${lane})`;
      }
    }

    return "Conflict resolution pending";
  }
}

// ============================================================================
// TIER COORDINATOR
// ============================================================================

/**
 * Handles communication and coordination between tiers
 */
export class TierCoordinator {
  /**
   * Send message from master to leads
   */
  sendToLeads(message: {
    type: "task" | "query" | "command";
    from: "master";
    content: string;
    objectiveId?: string;
  }): void {
    const leads = globalLaneOrganization.getAgentsByTier("lead");

    leads.forEach(lead => {
      // Send task to lead
      if (lead.current !== message.content) {
        lead.current = message.content;
        lead.status = "live";
      }
    });

    // Log to context
    globalContextStore.addEntry({
      agentId: "master",
      kind: "decision",
      summary: `Sent to all leads: ${message.content}`,
      symbols: ["master", "broadcast"],
      references: []
    });
  }

  /**
   * Send message from lead to workers
   */
  sendToWorkers(lane: AgentLane, message: {
    type: "task" | "query";
    from: string;
    content: string;
  }): void {
    const workers = globalLaneOrganization.getAgentsByLane(lane);
    const workerAgents = workers.filter(w => w.tier === "worker");

    workerAgents.forEach(worker => {
      worker.current = message.content;
      worker.status = "live";
    });

    // Log to context
    globalContextStore.addEntry({
      agentId: message.from,
      kind: "work",
      summary: `Sent to ${lane} workers: ${message.content}`,
      symbols: [lane, "delegation"],
      references: [],
      lane
    });
  }

  /**
   * Report status up the hierarchy
   */
  reportUp(agentId: string, status: string, data: any): void {
    const agent = globalLaneOrganization.getAgent(agentId);
    if (!agent) return;

    // Update agent status
    agent.status = status as any;

    // Log to context
    globalContextStore.addEntry({
      agentId,
      kind: "finding",
      summary: `Status update: ${status}`,
      symbols: ["status", agent.tier, agent.lane || "none"],
      references: [],
      lane: agent.lane
    });

    // If this is a worker, notify the lead
    if (agent.tier === "worker" && agent.parentId) {
      const parentAgent = globalLaneOrganization.getAgent(agent.parentId);
      if (parentAgent) {
        // Update parent's recent/completed
        if (!parentAgent.recent) parentAgent.recent = [];
        if (!parentAgent.completed) parentAgent.completed = [];

        parentAgent.recent.push(`${agentId}: ${status}`);
        if (status === "complete") {
          parentAgent.completed.push(agentId);
        }
      }
    }
  }
}

// ============================================================================
// AGENT ORCHESTRATOR
// ============================================================================

/**
 * Orchestrates multi-tier agent workflows
 */
export class AgentOrchestrator {
  private master = new MasterCoordinator();
  private tierCoordinator = new TierCoordinator();

  /**
   * Run complete workflow: Master → Leads → Workers
   */
  async runWorkflow(objective: string): Promise<{
    objectiveId: string;
    status: string;
    results: any;
  }> {
    const objectiveId = `obj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(`🚀 Starting workflow: ${objective}`);
    console.log(`   Objective ID: ${objectiveId}`);

    // Phase 1: Master distributes to leads
    console.log("\n📋 Phase 1: Distributing to leads...");
    const assignments = this.master.distributeObjective(objective);
    console.log(`   Assigned ${assignments.size} leads`);

    // Phase 2: Leads delegate to workers
    console.log("\n🔧 Phase 2: Leads delegating to workers...");
    const lanes: AgentLane[] = ["planning", "evidence", "synthesis", "audit"];

    for (const lane of lanes) {
      const leadAgents = globalLaneOrganization.getAgentsByLane(lane);
      leadAgents.forEach(lead => {
        if (lead.status === "live" && lead.current) {
          this.tierCoordinator.sendToWorkers(lane, {
            type: "task",
            from: lead.id,
            content: lead.current
          });
        }
      });
    }

    console.log(`   Delegated to workers in ${lanes.length} lanes`);

    // Phase 3: Collect results
    console.log("\n📊 Phase 3: Collecting results...");
    const results = await this.master.collectResults(objectiveId);
    console.log(`   Collected results from 4 lanes`);

    // Phase 4: Final decision
    console.log("\n🎯 Phase 4: Making final decision...");
    const decision = await this.master.makeFinalDecision(objectiveId);
    console.log(`   Final decision: ${decision}`);

    return {
      objectiveId,
      status: decision.includes("COMPLETED") ? "success" : "pending",
      results
    };
  }

  /**
   * Get current workflow status
   */
  getWorkflowStatus(objectiveId: string): {
    status: "running" | "completed" | "failed";
    progress: number;
    tier: "master" | "lead" | "worker";
  } {
    const agents = globalLaneOrganization.getAllAgents();
    const live = agents.filter(a => a.status === "live").length;
    const complete = agents.filter(a => a.status === "complete").length;

    return {
      status: complete === agents.length ? "completed" : "running",
      progress: (complete / agents.length) * 100,
      tier: live > 0 ? "worker" : "lead"
    };
  }
}

// ============================================================================
// SINGLETONS
// ============================================================================

export const globalMasterCoordinator = new MasterCoordinator();
export const globalTierCoordinator = new TierCoordinator();
export const globalAgentOrchestrator = new AgentOrchestrator();
