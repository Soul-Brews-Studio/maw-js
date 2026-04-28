/**
 * Tests for src/transports/hub-config.ts — constants and loadWorkspaceConfigs with temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  HEARTBEAT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../../src/transports/hub-config";

describe("hub-config constants", () => {
  it("HEARTBEAT_MS is 30 seconds", () => {
    expect(HEARTBEAT_MS).toBe(30_000);
  });

  it("RECONNECT_BASE_MS is 1 second", () => {
    expect(RECONNECT_BASE_MS).toBe(1_000);
  });

  it("RECONNECT_MAX_MS is 60 seconds", () => {
    expect(RECONNECT_MAX_MS).toBe(60_000);
  });

  it("reconnect max >= reconnect base", () => {
    expect(RECONNECT_MAX_MS).toBeGreaterThanOrEqual(RECONNECT_BASE_MS);
  });
});
