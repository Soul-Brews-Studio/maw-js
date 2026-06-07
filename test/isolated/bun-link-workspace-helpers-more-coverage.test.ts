import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectBunLinkedCheckout } from "../../src/vendor/mpr-plugins/doctor/internal/bun-link-detect";
import {
  generateJoinCode,
  generateToken,
  generateWorkspaceId,
  pushFeed,
  touchNode,
} from "../../src/api/workspace-helpers";
import type { Workspace } from "../../src/api/workspace-types";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "maw-bun-link-workspace-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_test",
    name: "Test Workspace",
    token: "token",
    joinCode: "ABC123",
    joinCodeExpiresAt: Date.now() + 1000,
    createdAt: "2026-05-18T00:00:00.000Z",
    creatorNodeId: "node-a",
    nodes: [],
    agents: [],
    feed: [],
    ...overrides,
  };
}

describe("detectBunLinkedCheckout", () => {
  test("returns null when global maw-js entry is absent", () => {
    withTempDir((globalNodeModules) => {
      expect(detectBunLinkedCheckout(globalNodeModules)).toBeNull();
    });
  });

  test("resolves a relative bun link to a maw-js checkout", () => {
    withTempDir((root) => {
      const globalNodeModules = join(root, "global", "node_modules");
      const checkout = join(root, "checkout", "maw-js");
      mkdirSync(globalNodeModules, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "maw-js" }));

      symlinkSync("../../checkout/maw-js", join(globalNodeModules, "maw-js"));

      expect(detectBunLinkedCheckout(globalNodeModules)).toBe(checkout);
    });
  });

  test("returns null for wrong package names and unreadable package json", () => {
    withTempDir((root) => {
      const globalNodeModules = join(root, "global", "node_modules");
      const checkout = join(root, "checkout");
      mkdirSync(globalNodeModules, { recursive: true });
      mkdirSync(checkout, { recursive: true });
      symlinkSync(checkout, join(globalNodeModules, "maw-js"));

      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "not-maw" }));
      expect(detectBunLinkedCheckout(globalNodeModules)).toBeNull();

      writeFileSync(join(checkout, "package.json"), "{not-json");
      expect(detectBunLinkedCheckout(globalNodeModules)).toBeNull();
    });
  });
});

describe("workspace helper utilities", () => {
  test("generates ids and tokens in the expected public formats", () => {
    expect(generateWorkspaceId()).toMatch(/^ws_[0-9a-f-]{8}$/);
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateJoinCode()).toMatch(/^[A-Z0-9_-]{6}$/);
  });

  test("touchNode updates only the matching node", () => {
    const ws = makeWorkspace({
      nodes: [
        { nodeId: "node-a", joinedAt: "a-joined", lastSeen: "a-old" },
        { nodeId: "node-b", joinedAt: "b-joined", lastSeen: "b-old" },
      ],
    });

    touchNode(ws, "node-a");

    expect(ws.nodes[0].lastSeen).not.toBe("a-old");
    expect(Date.parse(ws.nodes[0].lastSeen)).not.toBeNaN();
    expect(ws.nodes[1].lastSeen).toBe("b-old");

    touchNode(ws, "missing-node");
    expect(ws.nodes.map((node) => node.nodeId)).toEqual(["node-a", "node-b"]);
  });

  test("pushFeed appends an id and trims oldest events past the max feed size", () => {
    const ws = makeWorkspace({
      feed: Array.from({ length: 200 }, (_, index) => ({
        id: `old-${index}`,
        nodeId: "node-a",
        type: "note",
        message: `old ${index}`,
        ts: index,
      })),
    });

    pushFeed(ws, {
      nodeId: "node-b",
      type: "status",
      message: "new event",
      ts: 201,
    });

    expect(ws.feed).toHaveLength(200);
    expect(ws.feed[0].id).toBe("old-1");
    expect(ws.feed.at(-1)).toMatchObject({
      nodeId: "node-b",
      type: "status",
      message: "new event",
      ts: 201,
    });
    expect(ws.feed.at(-1)?.id).toMatch(/^[0-9a-f-]{8}$/);
  });
});
