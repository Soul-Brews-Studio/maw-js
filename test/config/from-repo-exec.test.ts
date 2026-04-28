/**
 * Tests for src/commands/plugins/bud/from-repo-exec.ts — oracleMarkerBegin/End,
 * applyFromRepoInjection with real temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  oracleMarkerBegin,
  oracleMarkerEnd,
  applyFromRepoInjection,
} from "../../src/commands/plugins/bud/from-repo-exec";
import type { InjectionPlan } from "../../src/commands/plugins/bud/types";

describe("oracleMarkerBegin", () => {
  it("includes stem name", () => {
    expect(oracleMarkerBegin("spark")).toContain("spark");
  });

  it("is an HTML comment", () => {
    expect(oracleMarkerBegin("test")).toMatch(/^<!--.*-->$/);
  });

  it("different stems produce different markers", () => {
    expect(oracleMarkerBegin("spark")).not.toBe(oracleMarkerBegin("forge"));
  });
});

describe("oracleMarkerEnd", () => {
  it("includes stem name", () => {
    expect(oracleMarkerEnd("spark")).toContain("spark");
  });

  it("is an HTML comment", () => {
    expect(oracleMarkerEnd("test")).toMatch(/^<!--.*-->$/);
  });

  it("differs from begin marker", () => {
    expect(oracleMarkerEnd("spark")).not.toBe(oracleMarkerBegin("spark"));
  });
});

describe("applyFromRepoInjection", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-from-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makePlan(overrides: Partial<InjectionPlan> = {}): InjectionPlan {
    return {
      target: tmp,
      blockers: [],
      ...overrides,
    } as InjectionPlan;
  }

  const silentLog = () => {};

  it("creates ψ/ vault directories", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    expect(existsSync(join(tmp, "ψ", "memory", "learnings"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "inbox"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "outbox"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "plans"))).toBe(true);
  });

  it("creates .claude/settings.local.json when absent", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    expect(existsSync(join(tmp, ".claude", "settings.local.json"))).toBe(true);
  });

  it("does not overwrite existing settings", async () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.local.json"), '{"custom": true}');
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    const content = readFileSync(join(tmp, ".claude", "settings.local.json"), "utf8");
    expect(content).toContain("custom");
  });

  it("writes CLAUDE.md with stem name", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "spark", from: "" } as any, silentLog);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    expect(content).toContain("spark");
  });

  it("writes CLAUDE.md with Rule 6", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    expect(content).toContain("Rule 6");
  });

  it("includes parent lineage when from is specified", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "boom" } as any, silentLog);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    expect(content).toContain("boom");
  });

  it("appends to existing CLAUDE.md with markers", async () => {
    writeFileSync(join(tmp, "CLAUDE.md"), "# Existing Project\n\nSome content.\n");
    await applyFromRepoInjection(makePlan(), { stem: "spark", from: "" } as any, silentLog);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    expect(content).toContain("Existing Project");
    expect(content).toContain(oracleMarkerBegin("spark"));
    expect(content).toContain(oracleMarkerEnd("spark"));
  });

  it("is idempotent on CLAUDE.md append", async () => {
    writeFileSync(join(tmp, "CLAUDE.md"), "# Existing\n");
    await applyFromRepoInjection(makePlan(), { stem: "spark", from: "" } as any, silentLog);
    const content1 = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    await applyFromRepoInjection(makePlan(), { stem: "spark", from: "" } as any, silentLog);
    const content2 = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
    expect(content1).toBe(content2);
  });

  it("adds ψ/ to .gitignore", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
    expect(gitignore).toContain("ψ/");
  });

  it("does not duplicate ψ/ in .gitignore", async () => {
    writeFileSync(join(tmp, ".gitignore"), "node_modules/\nψ/\n");
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
    const count = (gitignore.match(/ψ\//g) || []).length;
    expect(count).toBe(1);
  });

  it("skips .gitignore when trackVault is true", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "", trackVault: true } as any, silentLog);
    if (existsSync(join(tmp, ".gitignore"))) {
      const gitignore = readFileSync(join(tmp, ".gitignore"), "utf8");
      expect(gitignore).not.toContain("ψ/");
    }
  });

  it("throws on plan with blockers", async () => {
    const plan = makePlan({ blockers: ["already initialized"] });
    await expect(
      applyFromRepoInjection(plan, { stem: "test", from: "" } as any, silentLog),
    ).rejects.toThrow("blocker");
  });

  it("calls logger with progress messages", async () => {
    const logs: string[] = [];
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, (m) => logs.push(m));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some(l => l.includes("vault"))).toBe(true);
  });

  it("creates 8 ψ subdirectories", async () => {
    await applyFromRepoInjection(makePlan(), { stem: "test", from: "" } as any, silentLog);
    expect(existsSync(join(tmp, "ψ", "memory", "learnings"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "retrospectives"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "traces"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "resonance"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "collaborations"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "inbox"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "outbox"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "plans"))).toBe(true);
  });
});
