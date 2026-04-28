/**
 * Tests for src/commands/plugins/bud/bud-init.ts — initVault, generateClaudeMd, writeBirthNote.
 * All take parameterized paths — testable with temp dirs.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initVault, generateClaudeMd, writeBirthNote } from "../../src/commands/plugins/bud/bud-init";

let tmp: string;
let consoleSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-bud-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

describe("initVault", () => {
  it("creates ψ/ directory", () => {
    initVault(tmp);
    expect(existsSync(join(tmp, "ψ"))).toBe(true);
  });

  it("creates memory subdirectories", () => {
    initVault(tmp);
    expect(existsSync(join(tmp, "ψ", "memory", "learnings"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "retrospectives"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "traces"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "resonance"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "memory", "collaborations"))).toBe(true);
  });

  it("creates inbox and outbox", () => {
    initVault(tmp);
    expect(existsSync(join(tmp, "ψ", "inbox"))).toBe(true);
    expect(existsSync(join(tmp, "ψ", "outbox"))).toBe(true);
  });

  it("creates plans directory", () => {
    initVault(tmp);
    expect(existsSync(join(tmp, "ψ", "plans"))).toBe(true);
  });

  it("returns the psiDir path", () => {
    const psiDir = initVault(tmp);
    expect(psiDir).toBe(join(tmp, "ψ"));
  });

  it("is idempotent — second call does not error", () => {
    initVault(tmp);
    expect(() => initVault(tmp)).not.toThrow();
  });

  it("logs success message", () => {
    initVault(tmp);
    expect(consoleSpy).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain("vault initialized");
  });
});

describe("generateClaudeMd", () => {
  it("creates CLAUDE.md file", () => {
    generateClaudeMd(tmp, "spark", "boom");
    expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(true);
  });

  it("includes oracle name in heading", () => {
    generateClaudeMd(tmp, "spark", "boom");
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# spark-oracle");
  });

  it("includes parent lineage when parentName provided", () => {
    generateClaudeMd(tmp, "spark", "boom");
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Budded from **boom**");
    expect(content).toContain("**Budded from**: boom");
  });

  it("includes root origin when no parent", () => {
    generateClaudeMd(tmp, "spark", null);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Root oracle");
    expect(content).toContain("**Origin**: root");
  });

  it("does not overwrite existing CLAUDE.md", () => {
    const claudeMd = join(tmp, "CLAUDE.md");
    const original = "# existing content";
    require("fs").writeFileSync(claudeMd, original);
    generateClaudeMd(tmp, "spark", "boom");
    expect(readFileSync(claudeMd, "utf-8")).toBe(original);
  });

  it("includes 5 principles", () => {
    generateClaudeMd(tmp, "test", null);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Nothing is Deleted");
    expect(content).toContain("Patterns Over Intentions");
    expect(content).toContain("External Brain, Not Command");
    expect(content).toContain("Curiosity Creates Existence");
    expect(content).toContain("Form and Formless");
  });

  it("includes Rule 6 transparency", () => {
    generateClaudeMd(tmp, "test", null);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Rule 6");
    expect(content).toContain("Oracle Never Pretends to Be Human");
  });

  it("includes federation tag placeholder", () => {
    generateClaudeMd(tmp, "spark", null);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("[<host>:spark]");
  });

  it("includes Co-Authored-By trailer template", () => {
    generateClaudeMd(tmp, "test", null);
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    expect(content).toContain("Co-Authored-By:");
  });

  it("includes date in lineage header", () => {
    generateClaudeMd(tmp, "test", "parent");
    const content = readFileSync(join(tmp, "CLAUDE.md"), "utf-8");
    // Date format: YYYY-MM-DD
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("writeBirthNote", () => {
  let psiDir: string;

  beforeEach(() => {
    psiDir = join(tmp, "ψ");
    mkdirSync(join(psiDir, "memory", "learnings"), { recursive: true });
  });

  it("creates birth note file", () => {
    writeBirthNote(psiDir, "spark", "boom", "Because we needed a UX designer");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthNote = files.find(f => f.includes("birth-note"));
    expect(birthNote).toBeTruthy();
  });

  it("includes name in content", () => {
    writeBirthNote(psiDir, "spark", "boom", "UX designer");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    const content = readFileSync(join(psiDir, "memory", "learnings", birthFile), "utf-8");
    expect(content).toContain("spark");
  });

  it("includes parent in frontmatter", () => {
    writeBirthNote(psiDir, "spark", "boom", "test");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    const content = readFileSync(join(psiDir, "memory", "learnings", birthFile), "utf-8");
    expect(content).toContain("from boom");
  });

  it("includes note content", () => {
    writeBirthNote(psiDir, "spark", null, "We need this oracle");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    const content = readFileSync(join(psiDir, "memory", "learnings", birthFile), "utf-8");
    expect(content).toContain("We need this oracle");
  });

  it("handles null parent", () => {
    writeBirthNote(psiDir, "root", null, "Root oracle");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    const content = readFileSync(join(psiDir, "memory", "learnings", birthFile), "utf-8");
    expect(content).toContain("Root oracle — no parent");
  });

  it("filename includes date", () => {
    writeBirthNote(psiDir, "spark", null, "test");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    expect(birthFile).toMatch(/^\d{4}-\d{2}-\d{2}_birth-note\.md$/);
  });

  it("includes frontmatter with pattern and source", () => {
    writeBirthNote(psiDir, "spark", "parent", "test");
    const files = readdirSync(join(psiDir, "memory", "learnings"));
    const birthFile = files.find(f => f.includes("birth-note"))!;
    const content = readFileSync(join(psiDir, "memory", "learnings", birthFile), "utf-8");
    expect(content).toContain("pattern: Birth note");
    expect(content).toContain("source: maw bud");
  });
});
