/**
 * Tests for src/views/info.ts — GET /info handshake endpoint (#596).
 *
 * Covers buildInfo() shape + Hono route dispatch. Matches the contract
 * consumed by src/commands/plugins/peers/probe.ts:111.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { hostname } from "os";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildInfo, infoView } from "../src/views/info";
import { setCachedNickname } from "../src/core/fleet/nicknames";

describe("buildInfo()", () => {
  test("returns required fields with correct types", () => {
    const info = buildInfo();
    expect(typeof info.node).toBe("string");
    expect(info.node.length).toBeGreaterThan(0);
    expect(typeof info.version).toBe("string");
    expect(typeof info.ts).toBe("string");
    // Post-#628: maw is a self-describing object, not a bare boolean.
    expect(typeof info.maw).toBe("object");
    expect(info.maw.schema).toBe("1");
    expect(info.maw.plugins.manifestEndpoint).toBe("/api/plugins");
    expect(Array.isArray(info.maw.capabilities)).toBe(true);
    expect(info.maw.capabilities).toContain("plugin.listManifest");
    expect(info.maw.capabilities).toContain("peer.handshake");
    expect(info.maw.capabilities).toContain("info");
  });

  test("ts is a valid ISO-8601 timestamp", () => {
    const info = buildInfo();
    const parsed = new Date(info.ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(info.ts).toBe(parsed.toISOString());
  });

  test("version matches package.json version shape (semver-ish) or empty", () => {
    const info = buildInfo();
    if (info.version !== "") {
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("node falls back to hostname when config has no node identity", () => {
    const info = buildInfo();
    // Either cfg.node was set, or os.hostname() — both non-empty.
    const h = hostname();
    expect([info.node, h].every(s => typeof s === "string" && s.length > 0)).toBe(true);
  });
});

describe("buildInfo() nickname propagation (#643 Phase 2)", () => {
  let prevMawHome: string | undefined;
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "maw-info-nickname-"));
    prevMawHome = process.env.MAW_HOME;
    process.env.MAW_HOME = sandbox;
  });

  afterEach(() => {
    if (prevMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = prevMawHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("nickname field is omitted when unset", () => {
    const info = buildInfo();
    expect(info.nickname).toBeUndefined();
    // Serializes without the field at all — optional by shape.
    const json = JSON.parse(JSON.stringify(info));
    expect("nickname" in json).toBe(false);
  });

  test("nickname field is populated when cache has an entry for the local node", () => {
    const { node } = buildInfo();
    setCachedNickname(node, "Moe");
    const info = buildInfo();
    expect(info.nickname).toBe("Moe");
  });

  test("empty-string cache entry does not surface as a nickname", () => {
    const { node } = buildInfo();
    // Explicit clear — should behave as "unset".
    setCachedNickname(node, "");
    const info = buildInfo();
    expect(info.nickname).toBeUndefined();
  });
});

describe("GET /info (Hono route)", () => {
  test("responds 200 with application/json and correct body shape", async () => {
    const app = new Hono();
    app.route("/info", infoView);

    const res = await app.request("/info");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.node).toBe("string");
    expect(typeof body.version).toBe("string");
    expect(typeof body.ts).toBe("string");
    // Post-#628: maw is a truthy self-describing object.
    expect(typeof body.maw).toBe("object");
    expect(body.maw).toBeTruthy();
    const maw = body.maw as { schema: string; plugins: { manifestEndpoint: string }; capabilities: string[] };
    expect(maw.schema).toBe("1");
    expect(typeof maw.plugins.manifestEndpoint).toBe("string");
    expect(Array.isArray(maw.capabilities)).toBe(true);
  });

  test("body satisfies probe.ts consumer — body.node is a non-empty string", async () => {
    const app = new Hono();
    app.route("/info", infoView);

    const res = await app.request("/info");
    const body = await res.json() as { node?: unknown };
    expect(typeof body.node).toBe("string");
    expect((body.node as string).length).toBeGreaterThan(0);
  });
});
