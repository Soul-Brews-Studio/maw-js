/**
 * Phase 2 & 3 Orchestration Integration Tests
 *
 * Tests state management and workflow orchestration via WebSocket
 */

import WebSocket from "ws";

const WS_URL = "ws://localhost:3456/ws";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => Promise<void>) {
  return async () => {
    const start = Date.now();
    try {
      await fn();
      const duration = Date.now() - start;
      results.push({ name, passed: true, duration });
      console.log(`✅ ${name} (${duration}ms)`);
    } catch (e: any) {
      const duration = Date.now() - start;
      results.push({ name, passed: false, duration, error: e.message });
      console.log(`❌ ${name} (${duration}ms): ${e.message}`);
    }
  };
}

function waitForMessage(ws: WebSocket, type: string, timeout = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);

    const messageHandler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", messageHandler);
        resolve(msg);
      }
      // Ignore other messages (feed-history, sessions, etc.)
    };

    ws.on("message", messageHandler);
  });
}

async function runTests() {
  console.log("\n🧪 Phase 2 & 3 Orchestration Tests\n");
  console.log("=" .repeat(60));

  // Test 1: Connect to server
  await test("1. Connection to server", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("Connection timeout")), 5000);
    });
    ws.close();
  })();

  // Test 2: Get state info (Phase 2)
  await test("2. Get state info", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "state-info" }));
    const msg = await waitForMessage(ws, "state-info");
    if (!msg.success) throw new Error("state-info failed");
    // Note: info may be null on fresh server (no state file yet)

    if (msg.info) {
      console.log(`   → State file exists: ${msg.info.exists}`);
      console.log(`   → Version: ${msg.info.version}`);
      console.log(`   → Size: ${msg.info.size} bytes`);
    } else {
      console.log(`   → No state file (fresh server)`);
    }

    ws.close();
  })();

  // Test 3: Manual state save (Phase 2)
  await test("3. Manual state save", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "state-save" }));
    const msg = await waitForMessage(ws, "state-save");
    if (!msg.success) throw new Error(msg.message);

    ws.close();
  })();

  // Test 4: Create backup (Phase 2)
  await test("4. Create backup", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "state-backup" }));
    const msg = await waitForMessage(ws, "state-backup");
    if (!msg.success) throw new Error(msg.message);
    if (!msg.backupFile) throw new Error("Expected backupFile");

    ws.close();
  })();

  // Test 5: List backups (Phase 2)
  await test("5. List backups", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "state-backups" }));
    const msg = await waitForMessage(ws, "state-backups");
    if (!msg.success) throw new Error(msg.message);
    if (!Array.isArray(msg.backups)) throw new Error("Expected backups array");

    console.log(`   → Found ${msg.backups.length} backups`);
    ws.close();
  })();

  // Test 6: Initialize lanes with defaults (for orchestration)
  await test("6. Initialize lanes with defaults", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({ type: "lane-init" }));
    const msg = await waitForMessage(ws, "lane-init");
    if (!msg.success) throw new Error("Failed to initialize lanes");
    if (!Array.isArray(msg.agents)) throw new Error("Expected agents array");

    console.log(`   → Initialized with ${msg.agents.length} agents`);
    ws.close();
  })();

  // Test 7: Distribute objective (Phase 3)
  await test("7. Distribute objective to leads", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    const objective = "Test objective: Analyze market data";
    ws.send(JSON.stringify({
      type: "distribute-objective",
      objective
    }));
    const msg = await waitForMessage(ws, "distribute-objective");
    if (!msg.success) throw new Error(msg.message);
    if (!Array.isArray(msg.assignments)) throw new Error("Expected assignments array");

    console.log(`   → Distributed to ${msg.assignments.length} leads`);
    msg.assignments.forEach(([agentId, task]: [string, string]) => {
      console.log(`      - ${agentId}: ${task.substring(0, 50)}...`);
    });

    ws.close();
  })();

  // Test 8: Orchestrate complete workflow (Phase 3)
  await test("8. Orchestrate complete workflow", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    const objective = "Test workflow: Create trading strategy";
    ws.send(JSON.stringify({
      type: "orchestrate-workflow",
      objective
    }));
    const msg = await waitForMessage(ws, "orchestrate-workflow");
    if (!msg.success) throw new Error(msg.message);
    if (!msg.objectiveId) throw new Error("Expected objectiveId");
    if (!msg.status) throw new Error("Expected status");

    console.log(`   → Objective ID: ${msg.objectiveId}`);
    console.log(`   → Status: ${msg.status}`);

    ws.close();
  })();

  // Test 9: Get workflow status (Phase 3)
  await test("9. Get workflow status", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    // First, create a workflow
    ws.send(JSON.stringify({
      type: "orchestrate-workflow",
      objective: "Status test workflow"
    }));
    const createMsg = await waitForMessage(ws, "orchestrate-workflow");

    // Then get its status
    ws.send(JSON.stringify({
      type: "workflow-status",
      objectiveId: createMsg.objectiveId
    }));
    const statusMsg = await waitForMessage(ws, "workflow-status");
    if (!statusMsg.success) throw new Error(statusMsg.message);
    if (!statusMsg.status) throw new Error("Expected status object");

    console.log(`   → Status: ${statusMsg.status.status}`);
    console.log(`   → Progress: ${statusMsg.status.progress.toFixed(1)}%`);
    console.log(`   → Active tier: ${statusMsg.status.tier}`);

    ws.close();
  })();

  // Test 10: Send to leads (Phase 3)
  await test("10. Send message to leads", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({
      type: "send-to-leads",
      messageType: "task",
      content: "Test task for all leads"
    }));
    const msg = await waitForMessage(ws, "send-to-leads");
    if (!msg.success) throw new Error(msg.message);

    console.log(`   → ${msg.message}`);
    ws.close();
  })();

  // Test 11: Send to workers in specific lane (Phase 3)
  await test("11. Send message to workers", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({
      type: "send-to-workers",
      lane: "planning",
      messageType: "task",
      from: "planning-lead",
      content: "Test task for planning workers"
    }));
    const msg = await waitForMessage(ws, "send-to-workers");
    if (!msg.success) throw new Error(msg.message);

    console.log(`   → ${msg.message}`);
    ws.close();
  })();

  // Test 12: Report status up hierarchy (Phase 3)
  await test("12. Report status up hierarchy", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({
      type: "report-up",
      agentId: "planning-lead",
      status: "live",
      data: { progress: 50 }
    }));
    const msg = await waitForMessage(ws, "report-up");
    if (!msg.success) throw new Error(msg.message);

    console.log(`   → ${msg.message}`);
    ws.close();
  })();

  // Test 13: Make decision (Phase 3)
  await test("13. Make final decision", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    // Use a dummy objective ID (since we don't have a real workflow)
    const dummyId = `obj-test-${Date.now()}`;
    ws.send(JSON.stringify({
      type: "make-decision",
      objectiveId: dummyId
    }));
    const msg = await waitForMessage(ws, "make-decision");

    // We expect this to succeed but return PENDING (no real workflow)
    if (!msg.success) throw new Error(msg.message);
    if (!msg.decision) throw new Error("Expected decision");

    console.log(`   → Decision: ${msg.decision}`);
    ws.close();
  })();

  // Test 14: Resolve conflict (Phase 3)
  await test("14. Resolve conflict", async () => {
    const ws = new WebSocket(WS_URL);
    await new Promise((resolve) => ws.once("open", resolve));

    ws.send(JSON.stringify({
      type: "resolve-conflict",
      conflict: {
        type: "resource",
        agents: ["planning-lead", "evidence-lead"],
        description: "Test conflict: Both agents need the same resource"
      }
    }));
    const msg = await waitForMessage(ws, "resolve-conflict");
    if (!msg.success) throw new Error(msg.message);
    if (!msg.resolution) throw new Error("Expected resolution");

    console.log(`   → Resolution: ${msg.resolution}`);
    ws.close();
  })();

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("\n📊 Test Summary\n");

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const passRate = ((passed / total) * 100).toFixed(1);

  console.log(`Total: ${total}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);
  console.log(`Pass Rate: ${passRate}%`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;
  console.log(`Avg Duration: ${avgDuration.toFixed(0)}ms`);

  if (failed > 0) {
    console.log("\n❌ Failed Tests:\n");
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }

  console.log("\n" + "=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
