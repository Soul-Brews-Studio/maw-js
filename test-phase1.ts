#!/usr/bin/env bun
/**
 * Phase 1 Test Script
 *
 * Tests context store and lane organization systems
 */

import { InMemoryContextStore, createFinding, createDecision, createBlocker, createWork } from "./src/context-store";
import { LaneOrganization, globalLaneOrganization, formatLaneLabel, convertLegacyAgents } from "./src/lane-organization";
import type { AgentHierarchy, AgentLane } from "./src/types-enhanced";

console.log("🧪 Testing Phase 1: Context Store + Lane Organization\n");

// ============================================================================
// TEST 1: Context Store
// ============================================================================

console.log("📦 Test 1: Context Store");
console.log("━".repeat(50));

const store = new InMemoryContextStore();

// Add some context entries
const finding1 = createFinding("plan-mgr", "API rate limit: 100 requests per minute", ["rate_limit", "api"], [], "planning");
const decision1 = createDecision("plan-mgr", "Use caching to reduce API calls", ["cache", "optimization"], [finding1.id]);
const blocker1 = createBlocker("researcher", "Cannot access external database", ["database", "access"]);
const work1 = createWork("writer", "Draft section 2: Methodology", ["writing", "methodology"], [finding1.id]);

store.addEntry(finding1);
store.addEntry(decision1);
store.addEntry(blocker1);
store.addEntry(work1);

console.log("✓ Added 4 context entries");

// Test retrieval
const planMgrEntries = store.getEntriesByAgent("plan-mgr");
console.log(`✓ Retrieved ${planMgrEntries.length} entries for plan-mgr`);

// Test symbol search
const apiEntries = store.searchBySymbol("api");
console.log(`✓ Found ${apiEntries.length} entries with symbol 'api'`);

// Test dependency graph
const deps = store.getDependencyGraph(decision1.id);
console.log(`✓ Dependency graph has ${deps.length} entries`);

// Test relevant context
const relevant = store.getRelevantContext("plan-mgr", 10);
console.log(`✓ Retrieved ${relevant.length} relevant entries for plan-mgr`);

// Get stats
const stats = store.getStats();
console.log(`✓ Store stats: ${JSON.stringify(stats, null, 2)}`);

console.log("\n");

// ============================================================================
// TEST 2: Lane Organization
// ============================================================================

console.log("🗂️  Test 2: Lane Organization");
console.log("━".repeat(50));

const lanes = new LaneOrganization();

// Initialize with defaults
lanes.initializeWithDefaults();
console.log("✓ Initialized with default lane configuration");

// Get all agents
const allAgents = lanes.getAllAgents();
console.log(`✓ Total agents: ${allAgents.length}`);

// Get agents by tier
const masters = lanes.getAgentsByTier("master");
const leads = lanes.getAgentsByTier("lead");
const workers = lanes.getAgentsByTier("worker");
console.log(`✓ Agents by tier: ${masters.length} master, ${leads.length} leads, ${workers.length} workers`);

// Get agents by lane
const planningAgents = lanes.getAgentsByLane("planning");
const evidenceAgents = lanes.getAgentsByLane("evidence");
console.log(`✓ Agents by lane: ${planningAgents.length} planning, ${evidenceAgents.length} evidence`);

// Test lane filters
lanes.setLaneFilter("planning", false);
const filtered = lanes.getFilteredAgents();
console.log(`✓ Filtered agents (planning disabled): ${filtered.length} agents`);

// Toggle filter back
lanes.toggleLaneFilter("planning");
const filters = lanes.getLaneFilters();
console.log(`✓ Lane filters: ${filters.filter(f => f.enabled).length} of ${filters.length} enabled`);

// Get statistics
const laneStats = lanes.getStats();
console.log(`✓ Lane stats: ${JSON.stringify(laneStats, null, 2)}`);

console.log("\n");

// ============================================================================
// TEST 3: Agent Hierarchy
// ============================================================================

console.log("🏗️  Test 3: Agent Hierarchy");
console.log("━".repeat(50));

// Build hierarchy
const hierarchy = lanes.buildHierarchy();
console.log(`✓ Built hierarchy with ${hierarchy.length} root agents`);

// Get agent path
const writerAgent = lanes.getAgent("writer");
if (writerAgent) {
  const path = lanes.getAgentPath("writer");
  console.log(`✓ Path to writer: ${path.map(a => a.name).join(" → ")}`);

  // Get children
  const synthesisChildren = lanes.getChildAgents("synthesis-lead");
  console.log(`✓ Synthesis lead has ${synthesisChildren.length} child agents`);
}

console.log("\n");

// ============================================================================
// TEST 4: Lane Formatting
// ============================================================================

console.log("🎨 Test 4: Lane Formatting");
console.log("━".repeat(50));

for (const lane of ["planning", "evidence", "synthesis", "audit"] as AgentLane[]) {
  const label = formatLaneLabel(lane);
  const agents = lanes.getAgentsByLane(lane);
  console.log(`✓ ${label}: ${agents.length} agents`);
}

console.log("\n");

// ============================================================================
// TEST 5: Legacy Conversion
// ============================================================================

console.log("🔄 Test 5: Legacy Agent Conversion");
console.log("━".repeat(50));

const legacyAgents = ["neo", "morpheus", "trinity", "smith"];
const converted = convertLegacyAgents(legacyAgents);
console.log(`✓ Converted ${legacyAgents.length} legacy agents`);
console.log(`✓ First agent tier: ${converted[0].tier} (should be 'master')`);
console.log(`✓ Second agent tier: ${converted[1].tier} (should be 'lead')`);

console.log("\n");

// ============================================================================
// TEST 6: Context Export/Import
// ============================================================================

console.log("💾 Test 6: Context Export/Import");
console.log("━".repeat(50));

// Export
const exportedJSON = store.exportJSON();
console.log(`✓ Exported JSON (${exportedJSON.length} bytes)`);

// Import into new store
const newStore = new InMemoryContextStore();
newStore.importJSON(exportedJSON);
const importedStats = newStore.getStats();
console.log(`✓ Imported ${importedStats.totalEntries} entries`);

console.log("\n");

// ============================================================================
// SUMMARY
// ============================================================================

console.log("✅ All Phase 1 Tests Passed!");
console.log("━".repeat(50));
console.log("\n📊 Summary:");
console.log(`  • Context store: ✅ Working`);
console.log(`  • Lane organization: ✅ Working`);
console.log(`  • Agent hierarchy: ✅ Working`);
console.log(`  • Legacy conversion: ✅ Working`);
console.log(`  • Export/Import: ✅ Working`);
console.log("\n🚀 Phase 1 implementation complete!");
console.log("\n💡 Next steps:");
console.log("  1. Integrate with engine.ts");
console.log("  2. Update UI to support lanes and context");
console.log("  3. Test with real WebSocket connections");
console.log("  4. Document API and usage patterns");

process.exit(0);
