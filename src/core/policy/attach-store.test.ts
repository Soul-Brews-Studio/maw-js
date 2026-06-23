/**
 * Tests for the company/dept attach marker store. Isolated via a temp
 * COMPANIES_DIR (`_setCompaniesDir`) so nothing touches the real registry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _setCompaniesDir } from "../../vendor/mpr-plugins/company/company-helpers";
import {
  attachDir,
  setPolicyAttach,
  getPolicyAttach,
  isPolicyAttached,
  clearPolicyAttach,
} from "./attach-store";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-attach-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("attach marker store", () => {
  test("set → get roundtrip preserves company/dept and stamps an ISO timestamp", () => {
    setPolicyAttach("kob-core-dev", { company: "kob", dept: "core" });
    const m = getPolicyAttach("kob-core-dev");
    expect(m).not.toBeNull();
    expect(m!.company).toBe("kob");
    expect(m!.dept).toBe("core");
    // attachedAt parses as a valid ISO timestamp.
    expect(typeof m!.attachedAt).toBe("string");
    expect(m!.attachedAt).toBe(new Date(m!.attachedAt).toISOString());
  });

  test("isPolicyAttached is false before set and true after", () => {
    expect(isPolicyAttached("kob-core-dev")).toBe(false);
    setPolicyAttach("kob-core-dev", { company: "kob", dept: "core" });
    expect(isPolicyAttached("kob-core-dev")).toBe(true);
  });

  test("clearPolicyAttach returns true then false on second call", () => {
    setPolicyAttach("kob-core-dev", { company: "kob", dept: "core" });
    expect(clearPolicyAttach("kob-core-dev")).toBe(true);
    expect(clearPolicyAttach("kob-core-dev")).toBe(false);
    expect(isPolicyAttached("kob-core-dev")).toBe(false);
  });

  test("getPolicyAttach returns null for an unknown oracle", () => {
    expect(getPolicyAttach("never-attached")).toBeNull();
  });

  test("getPolicyAttach returns null for a malformed marker file", () => {
    mkdirSync(attachDir(), { recursive: true });
    writeFileSync(join(attachDir(), "broken.json"), "{ not valid json");
    expect(getPolicyAttach("broken")).toBeNull();
  });

  test("unsafe oracle name is a no-op for set and getPolicyAttach returns null", () => {
    setPolicyAttach("../x", { company: "kob", dept: "core" });
    expect(getPolicyAttach("../x")).toBeNull();
    expect(isPolicyAttached("../x")).toBe(false);
    expect(clearPolicyAttach("../x")).toBe(false);
  });
});
