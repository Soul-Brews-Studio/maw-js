import type { MawWS, Handler } from "./types";
import { globalStateManager } from "./state-manager";
import {
  globalMasterCoordinator,
  globalTierCoordinator,
  globalAgentOrchestrator
} from "./master-coordinator";

// ============================================================================
// STATE MANAGEMENT HANDLERS (Phase 2)
// ============================================================================

/**
 * Manually save state to file
 *
 * Request: { type: "state-save" }
 * Response: { type: "state-save", success: boolean, message: string }
 */
export const handleStateSave: Handler = async (ws, _data) => {
  try {
    await globalStateManager.save();
    ws.send(JSON.stringify({
      type: "state-save",
      success: true,
      message: "State saved successfully"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-save",
      success: false,
      message: `Save failed: ${e.message}`
    }));
  }
};

/**
 * Load state from file
 *
 * Request: { type: "state-load" }
 * Response: { type: "state-load", success: boolean, message: string, state?: MawState }
 */
export const handleStateLoad: Handler = async (ws, _data) => {
  try {
    await globalStateManager.restore();
    ws.send(JSON.stringify({
      type: "state-load",
      success: true,
      message: "State loaded successfully"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-load",
      success: false,
      message: `Load failed: ${e.message}`
    }));
  }
};

/**
 * Create backup of current state
 *
 * Request: { type: "state-backup" }
 * Response: { type: "state-backup", success: boolean, backupFile?: string, message: string }
 */
export const handleStateBackup: Handler = async (ws, _data) => {
  try {
    const backupFile = await globalStateManager.createBackup();
    ws.send(JSON.stringify({
      type: "state-backup",
      success: true,
      backupFile,
      message: `Backup created: ${backupFile}`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-backup",
      success: false,
      message: `Backup failed: ${e.message}`
    }));
  }
};

/**
 * List all available backups
 *
 * Request: { type: "state-backups" }
 * Response: { type: "state-backups", success: boolean, backups?: string[], message: string }
 */
export const handleStateBackups: Handler = async (ws, _data) => {
  try {
    const backups = await globalStateManager.listBackups();
    ws.send(JSON.stringify({
      type: "state-backups",
      success: true,
      backups,
      message: `Found ${backups.length} backups`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-backups",
      success: false,
      message: `List backups failed: ${e.message}`
    }));
  }
};

/**
 * Restore state from backup
 *
 * Request: { type: "state-restore-backup", backupFile: string }
 * Response: { type: "state-restore-backup", success: boolean, message: string }
 */
export const handleStateRestoreBackup: Handler = async (ws, data) => {
  const { backupFile } = data;

  if (!backupFile) {
    ws.send(JSON.stringify({
      type: "state-restore-backup",
      success: false,
      message: "backupFile is required"
    }));
    return;
  }

  try {
    await globalStateManager.restoreFromBackup(backupFile);
    ws.send(JSON.stringify({
      type: "state-restore-backup",
      success: true,
      message: `Restored from backup: ${backupFile}`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-restore-backup",
      success: false,
      message: `Restore failed: ${e.message}`
    }));
  }
};

/**
 * Get state file information
 *
 * Request: { type: "state-info" }
 * Response: { type: "state-info", success: boolean, info?: StateInfo, message: string }
 */
export const handleStateInfo: Handler = async (ws, _data) => {
  try {
    const info = await globalStateManager.getStateInfo();
    ws.send(JSON.stringify({
      type: "state-info",
      success: true,
      info,
      message: info ? "State file exists" : "No state file found"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "state-info",
      success: false,
      message: `Get state info failed: ${e.message}`
    }));
  }
};

// ============================================================================
// ORCHESTRATION HANDLERS (Phase 3)
// ============================================================================

/**
 * Run complete workflow: Master → Leads → Workers
 *
 * Request: { type: "orchestrate-workflow", objective: string }
 * Response: { type: "orchestrate-workflow", success: boolean, objectiveId: string, status: string, results?: any }
 */
export const handleOrchestrateWorkflow: Handler = async (ws, data) => {
  const { objective } = data;

  if (!objective) {
    ws.send(JSON.stringify({
      type: "orchestrate-workflow",
      success: false,
      message: "objective is required"
    }));
    return;
  }

  try {
    const result = await globalAgentOrchestrator.runWorkflow(objective);
    ws.send(JSON.stringify({
      type: "orchestrate-workflow",
      success: true,
      objectiveId: result.objectiveId,
      status: result.status,
      results: result.results
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "orchestrate-workflow",
      success: false,
      message: `Workflow execution failed: ${e.message}`
    }));
  }
};

/**
 * Get workflow status
 *
 * Request: { type: "workflow-status", objectiveId: string }
 * Response: { type: "workflow-status", success: boolean, status?: WorkflowStatus, message: string }
 */
export const handleWorkflowStatus: Handler = async (ws, data) => {
  const { objectiveId } = data;

  if (!objectiveId) {
    ws.send(JSON.stringify({
      type: "workflow-status",
      success: false,
      message: "objectiveId is required"
    }));
    return;
  }

  try {
    const status = globalAgentOrchestrator.getWorkflowStatus(objectiveId);
    ws.send(JSON.stringify({
      type: "workflow-status",
      success: true,
      status
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "workflow-status",
      success: false,
      message: `Get workflow status failed: ${e.message}`
    }));
  }
};

/**
 * Distribute objective to lead agents
 *
 * Request: { type: "distribute-objective", objective: string }
 * Response: { type: "distribute-objective", success: boolean, assignments?: Map<string, string>, message: string }
 */
export const handleDistributeObjective: Handler = async (ws, data) => {
  const { objective } = data;

  if (!objective) {
    ws.send(JSON.stringify({
      type: "distribute-objective",
      success: false,
      message: "objective is required"
    }));
    return;
  }

  try {
    const assignments = globalMasterCoordinator.distributeObjective(objective);
    ws.send(JSON.stringify({
      type: "distribute-objective",
      success: true,
      assignments: Array.from(assignments.entries()),
      message: `Distributed to ${assignments.size} lead agents`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "distribute-objective",
      success: false,
      message: `Distribution failed: ${e.message}`
    }));
  }
};

/**
 * Collect results from lead agents
 *
 * Request: { type: "collect-results", objectiveId: string }
 * Response: { type: "collect-results", success: boolean, results?: any, message: string }
 */
export const handleCollectResults: Handler = async (ws, data) => {
  const { objectiveId } = data;

  if (!objectiveId) {
    ws.send(JSON.stringify({
      type: "collect-results",
      success: false,
      message: "objectiveId is required"
    }));
    return;
  }

  try {
    const results = await globalMasterCoordinator.collectResults(objectiveId);
    ws.send(JSON.stringify({
      type: "collect-results",
      success: true,
      results,
      message: "Results collected successfully"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "collect-results",
      success: false,
      message: `Collect results failed: ${e.message}`
    }));
  }
};

/**
 * Make final decision based on lead agent inputs
 *
 * Request: { type: "make-decision", objectiveId: string }
 * Response: { type: "make-decision", success: boolean, decision?: string, message: string }
 */
export const handleMakeDecision: Handler = async (ws, data) => {
  const { objectiveId } = data;

  if (!objectiveId) {
    ws.send(JSON.stringify({
      type: "make-decision",
      success: false,
      message: "objectiveId is required"
    }));
    return;
  }

  try {
    const decision = await globalMasterCoordinator.makeFinalDecision(objectiveId);
    ws.send(JSON.stringify({
      type: "make-decision",
      success: true,
      decision,
      message: "Decision made successfully"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "make-decision",
      success: false,
      message: `Make decision failed: ${e.message}`
    }));
  }
};

/**
 * Resolve conflicts between agents
 *
 * Request: { type: "resolve-conflict", conflict: { type, agents, description } }
 * Response: { type: "resolve-conflict", success: boolean, resolution?: string, message: string }
 */
export const handleResolveConflict: Handler = async (ws, data) => {
  const { conflict } = data;

  if (!conflict) {
    ws.send(JSON.stringify({
      type: "resolve-conflict",
      success: false,
      message: "conflict object is required"
    }));
    return;
  }

  try {
    const resolution = await globalMasterCoordinator.resolveConflict(conflict);
    ws.send(JSON.stringify({
      type: "resolve-conflict",
      success: true,
      resolution,
      message: "Conflict resolved successfully"
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "resolve-conflict",
      success: false,
      message: `Resolve conflict failed: ${e.message}`
    }));
  }
};

/**
 * Send message to all lead agents
 *
 * Request: { type: "send-to-leads", messageType: "task" | "query" | "command", content: string, objectiveId?: string }
 * Response: { type: "send-to-leads", success: boolean, message: string }
 */
export const handleSendToLeads: Handler = async (ws, data) => {
  const { messageType, content, objectiveId } = data;

  if (!messageType || !content) {
    ws.send(JSON.stringify({
      type: "send-to-leads",
      success: false,
      message: "messageType and content are required"
    }));
    return;
  }

  try {
    globalTierCoordinator.sendToLeads({
      type: messageType,
      from: "master",
      content,
      objectiveId
    });
    ws.send(JSON.stringify({
      type: "send-to-leads",
      success: true,
      message: `Sent ${messageType} to all leads`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "send-to-leads",
      success: false,
      message: `Send to leads failed: ${e.message}`
    }));
  }
};

/**
 * Send message to workers in a specific lane
 *
 * Request: { type: "send-to-workers", lane: string, messageType: "task" | "query", from: string, content: string }
 * Response: { type: "send-to-workers", success: boolean, message: string }
 */
export const handleSendToWorkers: Handler = async (ws, data) => {
  const { lane, messageType, from, content } = data;

  if (!lane || !messageType || !from || !content) {
    ws.send(JSON.stringify({
      type: "send-to-workers",
      success: false,
      message: "lane, messageType, from, and content are required"
    }));
    return;
  }

  try {
    globalTierCoordinator.sendToWorkers(lane, {
      type: messageType,
      from,
      content
    });
    ws.send(JSON.stringify({
      type: "send-to-workers",
      success: true,
      message: `Sent ${messageType} to ${lane} workers`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "send-to-workers",
      success: false,
      message: `Send to workers failed: ${e.message}`
    }));
  }
};

/**
 * Report status up the hierarchy
 *
 * Request: { type: "report-up", agentId: string, status: string, data?: any }
 * Response: { type: "report-up", success: boolean, message: string }
 */
export const handleReportUp: Handler = async (ws, data) => {
  const { agentId, status, data: agentData } = data;

  if (!agentId || !status) {
    ws.send(JSON.stringify({
      type: "report-up",
      success: false,
      message: "agentId and status are required"
    }));
    return;
  }

  try {
    globalTierCoordinator.reportUp(agentId, status, agentData || {});
    ws.send(JSON.stringify({
      type: "report-up",
      success: true,
      message: `Status reported for ${agentId}`
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({
      type: "report-up",
      success: false,
      message: `Report up failed: ${e.message}`
    }));
  }
};

// ============================================================================
// HANDLER REGISTRATION
// ============================================================================

/**
 * Register all orchestration handlers with the engine
 */
export function registerOrchestrationHandlers(engine: any): void {
  // State management handlers (Phase 2)
  engine.on("state-save", handleStateSave);
  engine.on("state-load", handleStateLoad);
  engine.on("state-backup", handleStateBackup);
  engine.on("state-backups", handleStateBackups);
  engine.on("state-restore-backup", handleStateRestoreBackup);
  engine.on("state-info", handleStateInfo);

  // Orchestration handlers (Phase 3)
  engine.on("orchestrate-workflow", handleOrchestrateWorkflow);
  engine.on("workflow-status", handleWorkflowStatus);
  engine.on("distribute-objective", handleDistributeObjective);
  engine.on("collect-results", handleCollectResults);
  engine.on("make-decision", handleMakeDecision);
  engine.on("resolve-conflict", handleResolveConflict);
  engine.on("send-to-leads", handleSendToLeads);
  engine.on("send-to-workers", handleSendToWorkers);
  engine.on("report-up", handleReportUp);
}
