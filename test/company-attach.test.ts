import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setCompaniesDir,
  createCompany, addDepartment, assignMember,
} from "../src/vendor/mpr-plugins/company/company-helpers";
import {
  fuzzyResolveCompany, fuzzyResolveDept,
  findIdleMember, deptBusyReport, nextNewMemberName,
  type BusyCheck,
} from "../src/vendor/mpr-plugins/company/company-attach";
import handler from "../src/vendor/mpr-plugins/company/index";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-company-attach-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Build an injected busy-check from a name → status map. Default "ready". */
function busyCheckFrom(statuses: Record<string, string>): BusyCheck {
  return async (oracle: string) => {
    const status = statuses[oracle] ?? "unknown";
    return { busy: status === "busy", status, oracle };
  };
}

describe("fuzzy company resolution", () => {
  beforeEach(() => {
    createCompany("kob-bank");
    createCompany("acme");
  });

  test("exact match wins", () => {
    expect(fuzzyResolveCompany("kob-bank")).toBe("kob-bank");
  });

  test("typo resolves to nearest", () => {
    expect(fuzzyResolveCompany("kob")).toBe("kob-bank");
    expect(fuzzyResolveCompany("akme")).toBe("acme");
  });

  test("no match returns null", () => {
    expect(fuzzyResolveCompany("zzzzzz")).toBeNull();
    expect(fuzzyResolveCompany("")).toBeNull();
  });
});

describe("fuzzy department resolution", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
    addDepartment("kob", "frontend");
  });

  test("exact match wins", () => {
    expect(fuzzyResolveDept("kob", "payment")).toBe("payment");
  });

  test("typo resolves to nearest", () => {
    expect(fuzzyResolveDept("kob", "paymen")).toBe("payment");
    expect(fuzzyResolveDept("kob", "frontnd")).toBe("frontend");
  });

  test("no match returns null", () => {
    expect(fuzzyResolveDept("kob", "zzzzzz")).toBeNull();
    expect(fuzzyResolveDept("kob", "")).toBeNull();
  });

  test("unknown company returns null", () => {
    expect(fuzzyResolveDept("ghost", "payment")).toBeNull();
  });
});

describe("findIdleMember (injected busy-check)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
    assignMember("kob", "payment", "p1", "dev");
    assignMember("kob", "payment", "p2", "dev");
    assignMember("kob", "payment", "p3", "dev");
  });

  test("returns null when ALL members busy", async () => {
    const isBusy = busyCheckFrom({ p1: "busy", p2: "busy", p3: "busy" });
    expect(await findIdleMember("kob", "payment", isBusy)).toBeNull();
  });

  test("returns the single idle member", async () => {
    const isBusy = busyCheckFrom({ p1: "busy", p2: "ready", p3: "busy" });
    expect(await findIdleMember("kob", "payment", isBusy)).toEqual({
      oracle: "p2",
      status: "ready",
    });
  });

  test("respects member order — picks the first non-busy", async () => {
    const isBusy = busyCheckFrom({ p1: "busy", p2: "ready", p3: "ready" });
    expect((await findIdleMember("kob", "payment", isBusy))?.oracle).toBe("p2");
  });

  test("an unknown-status member is treated as idle (asleep → wakeable)", async () => {
    const isBusy = busyCheckFrom({ p1: "busy", p2: "unknown", p3: "ready" });
    expect((await findIdleMember("kob", "payment", isBusy))?.oracle).toBe("p2");
  });

  test("empty department → null", async () => {
    addDepartment("kob", "empty");
    expect(await findIdleMember("kob", "empty", busyCheckFrom({}))).toBeNull();
  });
});

describe("deptBusyReport counts", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
    assignMember("kob", "payment", "p1", "dev");
    assignMember("kob", "payment", "p2", "dev");
    assignMember("kob", "payment", "p3", "dev");
    assignMember("kob", "payment", "p4", "dev");
  });

  test("classifies busy / idle / sleeping", async () => {
    const isBusy = busyCheckFrom({
      p1: "busy",
      p2: "ready",
      p3: "unknown",
      p4: "offline",
    });
    const r = await deptBusyReport("kob", "payment", isBusy);
    expect(r).toEqual({
      total: 4,
      busy: 1,
      idle: 1,
      sleeping: 2,
      sleepingMembers: ["p3", "p4"],
    });
  });

  test("all busy → busy === total, no sleeping", async () => {
    const isBusy = busyCheckFrom({ p1: "busy", p2: "busy", p3: "busy", p4: "busy" });
    const r = await deptBusyReport("kob", "payment", isBusy);
    expect(r.busy).toBe(4);
    expect(r.total).toBe(4);
    expect(r.sleepingMembers).toEqual([]);
  });
});

describe("nextNewMemberName collision-avoidance", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
  });

  test("base convention <company>-<dept>-<role> when free", () => {
    expect(nextNewMemberName("kob", "payment", "dev")).toBe("kob-payment-dev");
  });

  test("defaults role to dev", () => {
    expect(nextNewMemberName("kob", "payment")).toBe("kob-payment-dev");
  });

  test("appends -2, -3 on collision", () => {
    assignMember("kob", "payment", "kob-payment-dev", "dev");
    expect(nextNewMemberName("kob", "payment", "dev")).toBe("kob-payment-dev-2");
    assignMember("kob", "payment", "kob-payment-dev-2", "dev");
    expect(nextNewMemberName("kob", "payment", "dev")).toBe("kob-payment-dev-3");
  });

  test("role is reflected in the name", () => {
    expect(nextNewMemberName("kob", "payment", "qa")).toBe("kob-payment-qa");
  });
});

describe("handler failure path — single-print contract (#15 error dupe)", () => {
  // The dispatcher prints result.output then, on !ok, also prints result.error.
  // When output already carries the user-facing message, error must be
  // undefined so the dispatcher doesn't reprint it. ok:false is preserved
  // (exit code unchanged). Uses the no-company path: errors WITHOUT spawning.
  test("output carries the message, error is suppressed (no reprint)", async () => {
    const res = await handler({
      source: "cli",
      args: ["attach", "nope-xyz", "web"],
      matchedName: "company",
    } as any);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/no company/i);
    expect(res.error).toBeUndefined();
  });
});
