import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readFileSync as rf } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  STATUS_REPORTER_SH, statusReporterPath, ensureStatusReporterScript,
} from "../../src/core/status-reporter";

describe("status-reporter", () => {
  test("embedded content matches scripts/hooks/status-reporter.sh", () => {
    const onDisk = readFileSync(join(import.meta.dir, "../../scripts/hooks/status-reporter.sh"), "utf8");
    expect(STATUS_REPORTER_SH).toBe(onDisk);
  });

  test("embedded script is a sane reporter (posts to /api/feed)", () => {
    expect(STATUS_REPORTER_SH.startsWith("#!/bin/bash")).toBe(true);
    expect(STATUS_REPORTER_SH).toContain("/api/feed");
    expect(STATUS_REPORTER_SH).toContain("CLAUDE_HOOK_EVENT");
  });

  test("statusReporterPath is under <home>/.config/maw/hooks", () => {
    expect(statusReporterPath("/h")).toBe("/h/.config/maw/hooks/status-reporter.sh");
  });

  test("ensure: creates when missing, idempotent on second call", () => {
    const home = mkdtempSync(join(tmpdir(), "maw-reporter-"));
    const r1 = ensureStatusReporterScript(home);
    expect(r1.created).toBe(true);
    expect(existsSync(r1.path)).toBe(true);
    expect(rf(r1.path, "utf8")).toBe(STATUS_REPORTER_SH);

    const r2 = ensureStatusReporterScript(home);
    expect(r2.created).toBe(false); // already there
  });

  test("ensure: non-destructive — keeps an existing custom script", () => {
    const home = mkdtempSync(join(tmpdir(), "maw-reporter-"));
    const path = statusReporterPath(home);
    ensureStatusReporterScript(home); // create dirs + default
    writeFileSync(path, "#!/bin/bash\n# custom\n");
    const r = ensureStatusReporterScript(home);
    expect(r.created).toBe(false);
    expect(rf(path, "utf8")).toBe("#!/bin/bash\n# custom\n"); // untouched
  });
});
