#!/usr/bin/env bun
/**
 * WebSocket Integration Test
 *
 * Tests real WebSocket connection with maw server
 * Tests context store, lane organization, and broadcasts
 */

const WS_URL = "ws://localhost:3456/ws";

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

function log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
  const colors = {
    info: "\x1b[36m",    // cyan
    success: "\x1b[32m", // green
    error: "\x1b[31m",   // red
    warning: "\x1b[33m",  // yellow
  };
  const reset = "\x1b[0m";
  console.log(`${colors[type]}${message}${reset}`);
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, message: "Success", duration });
    log(`✓ ${name} (${duration}ms)`, "success");
  } catch (error: any) {
    const duration = Date.now() - start;
    results.push({ name, passed: false, message: error.message, duration });
    log(`✗ ${name}: ${error.message} (${duration}ms)`, "error");
  }
}

// ============================================================================
// WEBSOCKET CLIENT
// ============================================================================

class MawWebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Map<string, (data: any) => void> = new Map();
  private messageQueue: any[] = [];

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      log(`Connecting to ${WS_URL}...`, "info");

      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        log("✓ Connected to server", "success");
        resolve();
      };

      this.ws.onerror = (error) => {
        log(`✗ WebSocket error: ${error}`, "error");
        reject(error);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.messageQueue.push(data);

          const handler = this.messageHandlers.get(data.type);
          if (handler) {
            handler(data);
          }
        } catch (e) {
          log(`✗ Failed to parse message: ${e}`, "error");
        }
      };

      this.ws.onclose = () => {
        log("WebSocket connection closed", "warning");
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(new Error("Connection timeout"));
        }
      }, 5000);
    });
  }

  send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      throw new Error("WebSocket not connected");
    }
  }

  on(type: string, handler: (data: any) => void): void {
    this.messageHandlers.set(type, handler);
  }

  waitFor(type: string, timeout: number = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.messageHandlers.delete(type);
        reject(new Error(`Timeout waiting for '${type}'`));
      }, timeout);

      this.messageHandlers.set(type, (data: any) => {
        clearTimeout(timeoutId);
        resolve(data);
      });
    });
  }

  getRecentMessages(type?: string, count: number = 10): any[] {
    if (type) {
      return this.messageQueue.filter(m => m.type === type).slice(-count);
    }
    return this.messageQueue.slice(-count);
  }

  clearQueue(): void {
    this.messageQueue = [];
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  log("🧪 WebSocket Integration Test Suite", "info");
  log("━".repeat(60), "info");

  const client = new MawWebSocketClient();

  // Test 1: Connection
  await test("Connection to server", async () => {
    await client.connect();
    if (!client.isConnected()) {
      throw new Error("Not connected");
    }
  });

  // Test 2: Receive initial data
  await test("Receive initial sessions", async () => {
    client.clearQueue();
    const data = await client.waitFor("sessions", 5000);
    if (!data.sessions || !Array.isArray(data.sessions)) {
      throw new Error("Invalid sessions data");
    }
    log(`  → Received ${data.sessions.length} sessions`, "info");
  });

  // Test 3: Receive feed history
  await test("Receive feed history", async () => {
    client.clearQueue();
    const data = await client.waitFor("feed-history", 3000);
    if (!data.events || !Array.isArray(data.events)) {
      throw new Error("Invalid feed history");
    }
    log(`  → Received ${data.events.length} feed events`, "info");
  });

  // Test 4: Request lane filters
  await test("Request lane filters", async () => {
    client.clearQueue();
    client.send({ type: "lane-filters" });
    const data = await client.waitFor("lane-filters", 3000);
    if (!data.filters || !Array.isArray(data.filters)) {
      throw new Error("Invalid lane filters");
    }
    log(`  → Received ${data.filters.length} lane filters`, "info");
    data.filters.forEach((f: any) => {
      log(`    - ${f.lane}: ${f.enabled ? "ON" : "OFF"} (${f.agentCount} agents)`, "info");
    });
  });

  // Test 5: Toggle lane filter
  await test("Toggle planning lane", async () => {
    client.clearQueue();
    client.send({ type: "lane-filter-toggle", lane: "planning" });
    const data = await client.waitFor("lane-filter-toggle", 3000);
    if (typeof data.enabled !== "boolean") {
      throw new Error("Invalid toggle response");
    }
    log(`  → Planning lane now ${data.enabled ? "enabled" : "disabled"}`, "info");
  });

  // Test 6: Request agent hierarchy
  await test("Request agent hierarchy", async () => {
    client.clearQueue();
    client.send({ type: "agents-hierarchy" });
    const data = await client.waitFor("agents-hierarchy", 3000);
    if (!data.agents || !Array.isArray(data.agents)) {
      throw new Error("Invalid agent hierarchy");
    }
    log(`  → Received ${data.agents.length} agents`, "info");

    // Count by tier
    const byTier: any = {};
    data.agents.forEach((a: any) => {
      byTier[a.tier] = (byTier[a.tier] || 0) + 1;
    });
    log(`  → Tier breakdown: ${JSON.stringify(byTier)}`, "info");
  });

  // Test 7: Request context entries
  await test("Request context entries", async () => {
    client.clearQueue();
    client.send({ type: "context-entries" });
    const data = await client.waitFor("context-entries", 3000);
    if (!data.entries || !Array.isArray(data.entries)) {
      throw new Error("Invalid context entries");
    }
    log(`  → Received ${data.entries.length} context entries`, "info");
  });

  // Test 8: Add context entry
  await test("Add context entry", async () => {
    client.clearQueue();
    client.send({
      type: "context-entry-added",
      entry: {
        agentId: "test-client",
        kind: "finding",
        summary: "Test finding from WebSocket client",
        symbols: ["test", "websocket", "integration"],
        lane: "planning"
      }
    });
    const data = await client.waitFor("context-entry-added", 3000);
    if (!data.entry || !data.entry.id) {
      throw new Error("Invalid context entry response");
    }
    log(`  → Created entry ${data.entry.id}`, "info");
    log(`  → Summary: ${data.entry.summary}`, "info");
  });

  // Test 9: Search context by symbol
  await test("Search context by symbol", async () => {
    client.clearQueue();
    client.send({ type: "context-search", symbol: "test" });
    const data = await client.waitFor("context-search", 3000);
    if (!data.entries || !Array.isArray(data.entries)) {
      throw new Error("Invalid search results");
    }
    log(`  → Found ${data.entries.length} entries with symbol 'test'`, "info");
  });

  // Test 10: Request system stats
  await test("Request system stats", async () => {
    client.clearQueue();
    client.send({ type: "stats" });
    const data = await client.waitFor("stats", 3000);
    if (!data.context || !data.lanes) {
      throw new Error("Invalid stats response");
    }
    log(`  → Context stats: ${data.context.totalEntries} entries`, "info");
    log(`  → Lane stats: ${data.lanes.totalAgents} agents`, "info");
  });

  // Test 11: Broadcast context stats (auto-broadcast)
  await test("Receive context stats broadcast", async () => {
    client.clearQueue();
    log(`  → Waiting for auto-broadcast (max 12s)...`, "info");
    const data = await client.waitFor("context-stats", 12000);
    if (!data.stats) {
      throw new Error("Invalid context stats broadcast");
    }
    log(`  → Received broadcast: ${data.stats.totalEntries} entries`, "info");
  });

  // Test 12: Broadcast lane stats (auto-broadcast)
  await test("Receive lane stats broadcast", async () => {
    client.clearQueue();
    log(`  → Waiting for auto-broadcast (max 12s)...`, "info");
    const data = await client.waitFor("lane-stats", 12000);
    if (!data.stats) {
      throw new Error("Invalid lane stats broadcast");
    }
    log(`  → Received broadcast: ${data.stats.totalAgents} agents`, "info");
  });

  // Test 13: Agent status update
  await test("Update agent status", async () => {
    client.clearQueue();
    client.send({
      type: "agent-status-update",
      agentId: "test-client",
      status: "live",
      current: "Running WebSocket tests"
    });
    const data = await client.waitFor("agent-status-update", 3000);
    if (!data.agent || data.agent.id !== "test-client") {
      throw new Error("Invalid agent status update");
    }
    log(`  → Agent ${data.agent.id} status: ${data.agent.status}`, "info");
  });

  // Test 14: Multiple rapid messages
  await test("Handle multiple rapid messages", async () => {
    client.clearQueue();
    const messages = [
      { type: "lane-filters" },
      { type: "agents-hierarchy" },
      { type: "context-entries" },
      { type: "stats" }
    ];

    for (const msg of messages) {
      client.send(msg);
    }

    // Wait for all responses
    await new Promise(resolve => setTimeout(resolve, 2000));

    const received = client.getRecentMessages();
    const responseTypes = new Set(received.map(m => m.type));

    if (responseTypes.has("lane-filters") &&
        responseTypes.has("agents-hierarchy") &&
        responseTypes.has("context-entries")) {
      log(`  → Received ${responseTypes.size} different response types`, "info");
    } else {
      throw new Error(`Missing responses. Got: ${Array.from(responseTypes).join(", ")}`);
    }
  });

  // Disconnect
  client.disconnect();
  log("", "info");
}

// ============================================================================
// RESULTS
// ============================================================================

function printResults() {
  log("", "info");
  log("━".repeat(60), "info");
  log("📊 Test Results", "info");
  log("━".repeat(60), "info");

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => r.passed === false).length;
  const total = results.length;
  const passRate = ((passed / total) * 100).toFixed(1);

  log(`Total: ${total} tests`, "info");
  log(`Passed: ${passed}`, "success");
  log(`Failed: ${failed}`, failed > 0 ? "error" : "info");
  log(`Pass Rate: ${passRate}%`, passed === total ? "success" : "warning");

  // Show details
  if (failed > 0) {
    log("", "info");
    log("Failed Tests:", "error");
    results.filter(r => !r.passed).forEach(r => {
      log(`  ✗ ${r.name}: ${r.message}`, "error");
    });
  }

  // Performance
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;
  log("", "info");
  log(`Average Response Time: ${avgDuration.toFixed(0)}ms`, "info");

  log("", "info");
  log("━".repeat(60), "info");

  if (passed === total) {
    log("✅ All tests passed!", "success");
  } else {
    log("❌ Some tests failed", "error");
  }

  log("━".repeat(60), "info");
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    await runTests();
  } catch (error: any) {
    log(`\n✗ Test suite failed: ${error.message}`, "error");
    process.exit(1);
  }

  printResults();

  // Exit with appropriate code
  const failed = results.filter(r => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main();
