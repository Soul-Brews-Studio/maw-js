import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFleetWindowResumeCommand, isFleetRuntimeIdentity, writeFleetWindowRuntime } from "./runtime-state";

describe("fleet runtime state", () => {
  test("schema-bumps one exact window without changing desired layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-fleet-runtime-"));
    const path = join(dir, "05-nntn.json");
    writeFileSync(path, JSON.stringify({
      name: "05-nntn",
      windows: [
        { name: "nntn-oracle", repo: "TTT3P/nntn" },
        { name: "nntn-codex", repo: "" },
      ],
    }));

    writeFleetWindowRuntime({
      session: "05-nntn",
      window: "nntn-codex",
      runtime: {
        engine: "codex",
        cwd: "/repo/nntn",
        nativeSessionId: "019fcafc-37c8-70c2-b5aa-0bcdb974f344",
        capturedAt: "2026-08-17T11:09:23.240Z",
      },
    }, { loadFleetEntries: () => [{ file: "05-nntn.json", path, num: 5, groupName: "nntn", session: JSON.parse(readFileSync(path, "utf8")) }] });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 2,
      name: "05-nntn",
      windows: [
        { name: "nntn-oracle", repo: "TTT3P/nntn" },
        {
          name: "nntn-codex",
          repo: "",
          runtime: {
            engine: "codex",
            cwd: "/repo/nntn",
            nativeSessionId: "019fcafc-37c8-70c2-b5aa-0bcdb974f344",
            capturedAt: "2026-08-17T11:09:23.240Z",
          },
        },
      ],
    });
  });

  test("renders engine-specific resume commands and rejects unsupported engines", () => {
    expect(buildFleetWindowResumeCommand({
      engine: "codex",
      cwd: "/repo/it's-here",
      nativeSessionId: "session-1",
      capturedAt: "2026-08-17T11:09:23.240Z",
    })).toBe("cd '/repo/it'\\''s-here' && codex resume 'session-1'");
    expect(() => buildFleetWindowResumeCommand({
      engine: "shell",
      cwd: "/repo",
      nativeSessionId: "session-2",
      capturedAt: "2026-08-17T11:09:23.240Z",
    })).toThrow("unsupported recoverable engine");
  });

  test("launch binding restores dedicated env and ratified workRoot on recovery (#dept-roster D-5)", () => {
    expect(buildFleetWindowResumeCommand({
      engine: "codex",
      cwd: "/old/worktree",
      nativeSessionId: "session-3",
      capturedAt: "2026-08-17T11:09:23.240Z",
      launch: {
        cwd: "/ratified/workroot",
        env: { CODEX_HOME: "/homes/cookbook" },
      },
    })).toBe(
      "cd '/ratified/workroot' && CODEX_HOME='/homes/cookbook' codex resume 'session-3'",
    );
  });

  test("legacy windows without launch binding recover exactly as before", () => {
    expect(buildFleetWindowResumeCommand({
      engine: "codex",
      cwd: "/repo/legacy",
      nativeSessionId: "session-4",
      capturedAt: "2026-08-17T11:09:23.240Z",
    })).toBe("cd '/repo/legacy' && codex resume 'session-4'");
  });

  test("rejects malformed launch bindings instead of silently dropping them", () => {
    const base = {
      engine: "codex",
      cwd: "/repo",
      nativeSessionId: "session-5",
      capturedAt: "2026-08-17T11:09:23.240Z",
    };
    expect(isFleetRuntimeIdentity({ ...base, launch: { cwd: "relative/path" } })).toBe(false);
    expect(isFleetRuntimeIdentity({ ...base, launch: { env: { "BAD KEY": "x" } } })).toBe(false);
    expect(isFleetRuntimeIdentity({ ...base, launch: { argv: [] } })).toBe(false);
    expect(isFleetRuntimeIdentity({ ...base, launch: { cwd: "/ok", env: { CODEX_HOME: "/h" }, argv: ["launch-seat.sh", "cookbook"] } })).toBe(true);
  });
});
