/**
 * Fleet-child runtime recovery — reader-side component coverage (#dept-roster D-5).
 *
 * Fixtures mirror the shape classes observed in real ~/.maw/fleet/*.json rows:
 *   class 1  runtime + launch      (e.g. cookbook)
 *   class 2a runtime, no launch    (e.g. nntn-codex)     — valid, resumable
 *   class 2b partial runtime       (e.g. finance-oracle) — {engine} only, NOT resumable
 *   class 3  no runtime            (e.g. cookbook-dev)   — absent, NOT resumable
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isFleetRuntimeIdentity,
  isValidLaunchBinding,
  isResumableEngine,
  buildFleetWindowResumeCommand,
} from "../../src/core/fleet/runtime-state";
import type { FleetRuntimeIdentity } from "../../src/core/fleet/fleet-load-core";
import { loadFleet } from "../../src/core/fleet/fleet-load-core";
import { ensureFleetSessionEntry } from "../../src/commands/shared/fleet-ensure";

const CAPTURED_AT = "2026-08-19T21:10:00.000Z";

const cls1: FleetRuntimeIdentity = {
  engine: "codex",
  cwd: "/Users/x/tt3p/product-hub/nntn-cookbook",
  nativeSessionId: "sess-abc",
  capturedAt: CAPTURED_AT,
  launch: {
    cwd: "/Users/x/tt3p/ratified-root",
    env: { CODEX_HOME: "/Users/x/.codex-cookbook", OMX_ROOT: "/Users/x/omx" },
    argv: ["codex", "--home", "/Users/x/.codex-cookbook", "resume"],
  },
};
const cls2a: FleetRuntimeIdentity = {
  engine: "codex",
  cwd: "/Users/x/tt3p/product-hub/nntn-cookbook",
  nativeSessionId: "sess-def",
  capturedAt: CAPTURED_AT,
};
const cls2b = { engine: "codex" } as unknown; // partial: {engine} only

describe("isFleetRuntimeIdentity — class matrix", () => {
  test("class 1 (runtime+launch) is recoverable", () => {
    expect(isFleetRuntimeIdentity(cls1)).toBe(true);
  });
  test("class 2a (runtime, no launch) is recoverable", () => {
    expect(isFleetRuntimeIdentity(cls2a)).toBe(true);
  });
  test("class 2b (partial {engine}) is NOT recoverable", () => {
    expect(isFleetRuntimeIdentity(cls2b)).toBe(false);
  });
  test("class 3 (absent) is NOT recoverable", () => {
    expect(isFleetRuntimeIdentity(undefined)).toBe(false);
  });
  test("runtime with an invalid launch binding is NOT recoverable", () => {
    expect(isFleetRuntimeIdentity({ ...cls2a, launch: { cwd: "relative" } })).toBe(false);
  });
});

describe("buildFleetWindowResumeCommand", () => {
  test("class 1: launch.cwd overrides captured cwd and launch.env is exported ahead", () => {
    const cmd = buildFleetWindowResumeCommand(cls1);
    // launch.cwd wins over runtime.cwd
    expect(cmd).toContain("cd '/Users/x/tt3p/ratified-root'");
    expect(cmd).not.toContain("nntn-cookbook");
    // env exported ahead of the resume command
    expect(cmd).toContain("CODEX_HOME='/Users/x/.codex-cookbook'");
    expect(cmd).toContain("OMX_ROOT='/Users/x/omx'");
    expect(cmd).toContain("codex resume 'sess-abc'");
    // ordering: cd ... && <env prefix> codex resume
    expect(cmd).toMatch(/^cd '[^']+' && CODEX_HOME=.* codex resume 'sess-abc'$/);
  });

  test("class 2a: no launch → byte-identical legacy resume string (golden)", () => {
    const cmd = buildFleetWindowResumeCommand(cls2a);
    expect(cmd).toBe("cd '/Users/x/tt3p/product-hub/nntn-cookbook' && codex resume 'sess-def'");
  });

  test("prompt is appended and shell-quoted", () => {
    const cmd = buildFleetWindowResumeCommand(cls2a, "resume please");
    expect(cmd).toBe("cd '/Users/x/tt3p/product-hub/nntn-cookbook' && codex resume 'sess-def' 'resume please'");
  });

  test("claude engine resumes with --resume", () => {
    const cmd = buildFleetWindowResumeCommand({ ...cls2a, engine: "claude" });
    expect(cmd).toBe("cd '/Users/x/tt3p/product-hub/nntn-cookbook' && claude --resume 'sess-def'");
  });

  test("throws on an invalid identity rather than emitting a bad command", () => {
    expect(() => buildFleetWindowResumeCommand(cls2b as FleetRuntimeIdentity)).toThrow();
  });
});

describe("isValidLaunchBinding — G5 validation", () => {
  test("undefined (legacy, no binding) is valid", () => {
    expect(isValidLaunchBinding(undefined)).toBe(true);
  });
  test("a fully-formed binding is valid", () => {
    expect(isValidLaunchBinding(cls1.launch)).toBe(true);
  });
  test("relative launch.cwd is rejected", () => {
    expect(isValidLaunchBinding({ cwd: "relative/path" })).toBe(false);
  });
  test("env key not matching a shell identifier is rejected", () => {
    expect(isValidLaunchBinding({ env: { "1BAD": "x" } })).toBe(false);
  });
  test("non-string env value is rejected", () => {
    expect(isValidLaunchBinding({ env: { K: 5 } })).toBe(false);
  });
  test("empty argv is rejected", () => {
    expect(isValidLaunchBinding({ argv: [] })).toBe(false);
  });
  test("argv containing an empty string is rejected", () => {
    expect(isValidLaunchBinding({ argv: ["ok", ""] })).toBe(false);
  });
  test("array (not an object) is rejected", () => {
    expect(isValidLaunchBinding([])).toBe(false);
  });
});

describe("isResumableEngine — recovery is only attempted for engines we can resume", () => {
  test.each(["codex", "claude", "CODEX", "Claude"])("resumable: %s", (e) => {
    expect(isResumableEngine(e)).toBe(true);
  });
  test.each(["gemini", "gpt", "bash", "zsh", ""])("not resumable: %s", (e) => {
    expect(isResumableEngine(e)).toBe(false);
  });
});

describe("migration: real fleet writer preserves runtime.launch (load→write→reload)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "maw-src03-mig-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("adding a sibling window via ensureFleetSessionEntry does not drop an existing window's runtime.launch", () => {
    const fleetDir = join(scratch, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    // A real fleet file: window 'cookbook' carries runtime+launch.
    const session = {
      name: "25-cookbook",
      windows: [{ name: "cookbook", repo: "org/nntn-cookbook", runtime: cls1 }],
    };
    const fleetFile = join(fleetDir, "25-cookbook.json");
    writeFileSync(fleetFile, JSON.stringify(session, null, 2) + "\n", "utf-8");

    // A ghq layout so the writer can derive a repo for the new sibling window.
    const ghqRoot = join(scratch, "ghq");
    const newRepoCwd = join(ghqRoot, "github.com", "org", "sibling-repo");
    mkdirSync(newRepoCwd, { recursive: true });

    const result = ensureFleetSessionEntry(
      { session: "25-cookbook", window: "sibling", cwd: newRepoCwd, createdBy: "test" },
      {
        fleetDirsForRead: () => [fleetDir],
        fleetDirForWrite: () => fleetDir,
        getGhqRoot: () => ghqRoot,
      },
    );
    expect(result.status).toBe("updated"); // the writer actually rewrote the file

    // Reload through the real loader and prove the original binding survived.
    const reloaded = loadFleet([fleetDir]);
    const cookbookWin = reloaded
      .flatMap((s) => s.windows)
      .find((w) => w.name === "cookbook");
    expect(cookbookWin?.runtime).toEqual(cls1);
    expect(isFleetRuntimeIdentity(cookbookWin?.runtime)).toBe(true);
    // and the sibling was added
    expect(reloaded.flatMap((s) => s.windows).some((w) => w.name === "sibling")).toBe(true);
  });
});
