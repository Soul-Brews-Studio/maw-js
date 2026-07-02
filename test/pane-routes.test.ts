/**
 * test/pane-routes.test.ts — kobo-36 (eq3-036) pane-route registry store.
 *
 * Exercises the on-disk channel→pane map via a temp MAW_HOME so no real state
 * dir is touched. Covers set/get/remove/list + oracle-key normalization
 * (node prefix / -oracle suffix / .pane suffix all collapse to one key).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPaneRoute,
  setPaneRoute,
  removePaneRoute,
  listPaneRoutes,
  paneRouteOracleKey,
  loadPaneRoutes,
  CHANNEL_TASK_EVENTS,
} from "../src/core/pane-routes";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-pane-routes-"));
  prevHome = process.env.MAW_HOME;
  process.env.MAW_HOME = dir; // mawStatePath → MAW_HOME
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("pane-routes registry", () => {
  test("get returns null when nothing declared", () => {
    expect(getPaneRoute("eq3", CHANNEL_TASK_EVENTS)).toBeNull();
    expect(loadPaneRoutes()).toEqual({});
  });

  test("set then get round-trips", () => {
    setPaneRoute("eq3", "task-events", 1);
    expect(getPaneRoute("eq3", "task-events")).toBe(1);
  });

  test("oracle key normalizes node prefix, -oracle suffix, and .pane suffix", () => {
    expect(paneRouteOracleKey("mba:eq3-oracle")).toBe("eq3");
    expect(paneRouteOracleKey("local:eq3")).toBe("eq3");
    expect(paneRouteOracleKey("eq3-oracle.1")).toBe("eq3");
    expect(paneRouteOracleKey("EQ3")).toBe("eq3");

    setPaneRoute("eq3", "task-events", 2);
    // All spellings resolve to the same stored entry.
    expect(getPaneRoute("mba:eq3-oracle", "task-events")).toBe(2);
    expect(getPaneRoute("local:eq3", "task-events")).toBe(2);
  });

  test("set overwrites (idempotent) and supports multiple channels", () => {
    setPaneRoute("eq3", "task-events", 1);
    setPaneRoute("eq3", "task-events", 3);
    setPaneRoute("eq3", "exec", 2);
    expect(getPaneRoute("eq3", "task-events")).toBe(3);
    expect(getPaneRoute("eq3", "exec")).toBe(2);
  });

  test("rejects a negative / non-integer pane index", () => {
    expect(() => setPaneRoute("eq3", "task-events", -1)).toThrow();
    expect(() => setPaneRoute("eq3", "task-events", 1.5)).toThrow();
  });

  test("remove a single channel; prunes the oracle when empty", () => {
    setPaneRoute("eq3", "task-events", 1);
    setPaneRoute("eq3", "exec", 2);
    expect(removePaneRoute("eq3", "task-events")).toBe(true);
    expect(getPaneRoute("eq3", "task-events")).toBeNull();
    expect(getPaneRoute("eq3", "exec")).toBe(2);
    // removing the last channel drops the oracle key entirely
    expect(removePaneRoute("eq3", "exec")).toBe(true);
    expect(loadPaneRoutes()).toEqual({});
    // removing a missing mapping is a no-op false
    expect(removePaneRoute("eq3", "task-events")).toBe(false);
  });

  test("remove whole oracle entry when channel omitted", () => {
    setPaneRoute("eq3", "task-events", 1);
    setPaneRoute("eq3", "exec", 2);
    expect(removePaneRoute("eq3")).toBe(true);
    expect(loadPaneRoutes()).toEqual({});
  });

  test("list all vs single oracle", () => {
    setPaneRoute("eq3", "task-events", 1);
    setPaneRoute("patchwork", "task-events", 2);
    expect(listPaneRoutes("eq3")).toEqual({ eq3: { "task-events": 1 } });
    expect(listPaneRoutes()).toEqual({
      eq3: { "task-events": 1 },
      patchwork: { "task-events": 2 },
    });
  });
});
