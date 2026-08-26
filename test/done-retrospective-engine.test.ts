import { describe, expect, test } from "bun:test";
import type { FleetEntry } from "../src/core/fleet/fleet-load-core";
import {
  inferRetrospectiveCommand,
  resolveWindowEngine,
  retrospectiveCommandForEngine,
} from "../src/vendor/mpr-plugins/done/retrospective-command";

/** Minimal fleet record naming one window's captured engine (undefined = no runtime). */
function fleetEntry(session: string, window: string, engine?: string): FleetEntry {
  return {
    file: `1-${session}.json`,
    num: 1,
    groupName: session,
    session: {
      name: session,
      windows: [{
        name: window,
        repo: "acme/widget",
        runtime: engine
          ? { engine, cwd: "/tmp/wt", nativeSessionId: "sess-1", capturedAt: "2026-08-26T00:00:00.000Z" }
          : undefined,
      }],
    },
  };
}

const noMarker = () => undefined;

describe("retrospectiveCommandForEngine (engine → retro form)", () => {
  test("codex worker gets $rrr (D3 regression: was /rrr / skipped)", () => {
    expect(retrospectiveCommandForEngine("codex")).toBe("$rrr");
  });

  test("claude worker gets /rrr", () => {
    expect(retrospectiveCommandForEngine("claude")).toBe("/rrr");
  });

  test("oh-my-codex aliases also get $rrr", () => {
    expect(retrospectiveCommandForEngine("omx")).toBe("$rrr");
    expect(retrospectiveCommandForEngine("oh-my-codex")).toBe("$rrr");
  });

  test("engine name is case/whitespace tolerant", () => {
    expect(retrospectiveCommandForEngine("  CODEX ")).toBe("$rrr");
    expect(retrospectiveCommandForEngine("Claude")).toBe("/rrr");
  });

  test("engines without a retro equivalent are skipped", () => {
    expect(retrospectiveCommandForEngine("aider")).toBeNull();
    expect(retrospectiveCommandForEngine("opencode")).toBeNull();
  });

  test("unresolved engine fails closed (skip, never guess)", () => {
    expect(retrospectiveCommandForEngine(undefined)).toBeNull();
    expect(retrospectiveCommandForEngine("")).toBeNull();
    expect(retrospectiveCommandForEngine("   ")).toBeNull();
  });

  test("unknown claude-family engine keeps the historical /rrr default", () => {
    expect(retrospectiveCommandForEngine("thclaws")).toBe("/rrr");
  });
});

describe("resolveWindowEngine (authoritative MAW state, never pane command)", () => {
  test("fleet runtime.engine resolves a codex window", () => {
    const engine = resolveWindowEngine("26-team", "team-1-worker", "/tmp/wt", {
      fleetEntries: [fleetEntry("26-team", "team-1-worker", "codex")],
      readWorktreeEngineFile: noMarker,
    });
    expect(engine).toBe("codex");
  });

  test("fleet runtime.engine resolves a claude window", () => {
    const engine = resolveWindowEngine("26-team", "team-1-worker", "/tmp/wt", {
      fleetEntries: [fleetEntry("26-team", "team-1-worker", "claude")],
      readWorktreeEngineFile: noMarker,
    });
    expect(engine).toBe("claude");
  });

  test("falls back to the worktree .maw-engine marker when fleet has no runtime", () => {
    const engine = resolveWindowEngine("26-team", "team-1-worker", "/tmp/wt", {
      fleetEntries: [fleetEntry("26-team", "team-1-worker", undefined)],
      readWorktreeEngineFile: (p) => (p === "/tmp/wt" ? "codex" : undefined),
    });
    expect(engine).toBe("codex");
  });

  test("fleet runtime.engine wins over the .maw-engine marker", () => {
    const engine = resolveWindowEngine("26-team", "team-1-worker", "/tmp/wt", {
      fleetEntries: [fleetEntry("26-team", "team-1-worker", "codex")],
      readWorktreeEngineFile: () => "claude", // ignored: fleet is authoritative
    });
    expect(engine).toBe("codex");
  });

  test("an invalid .maw-engine marker is treated as unresolved (fail-closed)", () => {
    const engine = resolveWindowEngine("26-team", "team-1-worker", "/tmp/wt", {
      fleetEntries: [],
      readWorktreeEngineFile: () => { throw new Error("invalid worktree engine marker"); },
    });
    expect(engine).toBeUndefined();
  });

  test("no fleet record and no marker → undefined (STOP: cannot resolve from MAW state)", () => {
    const engine = resolveWindowEngine("26-team", "ghost", "", {
      fleetEntries: [fleetEntry("26-team", "other-window", "codex")],
      readWorktreeEngineFile: noMarker,
    });
    expect(engine).toBeUndefined();
  });
});

describe("end-to-end: MAW state → retro form (the two required cases)", () => {
  function retroFor(session: string, window: string, engine?: string): string | null {
    const resolved = resolveWindowEngine(session, window, "/tmp/wt", {
      fleetEntries: [fleetEntry(session, window, engine)],
      readWorktreeEngineFile: noMarker,
    });
    return retrospectiveCommandForEngine(resolved);
  }

  test("codex target window → $rrr", () => {
    expect(retroFor("26-team", "team-1-worker", "codex")).toBe("$rrr");
  });

  test("claude target window → /rrr", () => {
    expect(retroFor("26-team", "team-1-worker", "claude")).toBe("/rrr");
  });

  test("window with no captured engine → retro skipped (no misfire)", () => {
    expect(retroFor("26-team", "team-1-worker", undefined)).toBeNull();
  });
});

describe("inferRetrospectiveCommand (deprecated pane-command path, unchanged)", () => {
  test("still classifies by pane command for the un-migrated consumer", () => {
    expect(inferRetrospectiveCommand("omx")).toBe("$rrr");
    expect(inferRetrospectiveCommand("codex")).toBeNull();
    expect(inferRetrospectiveCommand("node")).toBe("/rrr");
  });
});
