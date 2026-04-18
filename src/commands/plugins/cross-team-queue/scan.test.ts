import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseFrontmatter, scanVault } from "./scan";

describe("parseFrontmatter — YAML subset", () => {
  it("parses key: value strings", () => {
    const raw = `---\nrecipient: neo\nteam: fleet\n---\nbody`;
    const { data, error } = parseFrontmatter(raw, "a.md");
    expect(error).toBeUndefined();
    expect(data.recipient).toBe("neo");
    expect(data.team).toBe("fleet");
  });

  it("parses lists", () => {
    const raw = `---\ntags: [urgent, review, fleet]\n---\n`;
    const { data, error } = parseFrontmatter(raw, "a.md");
    expect(error).toBeUndefined();
    expect(data.tags).toEqual(["urgent", "review", "fleet"]);
  });

  it("parses empty list", () => {
    const raw = `---\ntags: []\n---\n`;
    const { data } = parseFrontmatter(raw, "a.md");
    expect(data.tags).toEqual([]);
  });

  it("parses booleans and numbers", () => {
    const raw = `---\npinned: true\ndraft: false\npriority: 3\n---\n`;
    const { data } = parseFrontmatter(raw, "a.md");
    expect(data.pinned).toBe(true);
    expect(data.draft).toBe(false);
    expect(data.priority).toBe(3);
  });

  it("flags missing frontmatter", () => {
    const { error } = parseFrontmatter("no fence here\njust body", "a.md");
    expect(error?.reason).toBe("missing frontmatter");
  });

  it("flags unterminated frontmatter", () => {
    const { error } = parseFrontmatter(`---\nkey: value\nno closing fence`, "a.md");
    expect(error?.reason).toBe("unterminated frontmatter");
  });

  it("flags malformed lines (missing colon)", () => {
    const { error } = parseFrontmatter(`---\nbroken line without colon\n---\n`, "a.md");
    expect(error?.reason).toBe("malformed frontmatter");
  });

  it("strips surrounding quotes from strings", () => {
    const raw = `---\nsubject: "hello world"\n---\n`;
    const { data } = parseFrontmatter(raw, "a.md");
    expect(data.subject).toBe("hello world");
  });
});

describe("scanVault — adversarial: no silent fallback", () => {
  const origRoot = process.env.MAW_VAULT_ROOT;
  afterEach(() => {
    if (origRoot === undefined) delete process.env.MAW_VAULT_ROOT;
    else process.env.MAW_VAULT_ROOT = origRoot;
  });

  it("surfaces missing MAW_VAULT_ROOT as a loud error (no silent default)", () => {
    delete process.env.MAW_VAULT_ROOT;
    const r = scanVault();
    expect(r.items).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.reason).toBe("MAW_VAULT_ROOT not set");
    expect(r.errors[0]?.file).toBe("<config>");
  });

  it("surfaces nonexistent vault root as a loud error", () => {
    process.env.MAW_VAULT_ROOT = join(tmpdir(), "ctq-does-not-exist-" + Date.now());
    const r = scanVault();
    expect(r.errors[0]?.reason).toBe("vault root does not exist");
  });
});

describe("scanVault — fixture fleet", () => {
  let tmpRoot: string;
  const origRoot = process.env.MAW_VAULT_ROOT;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ctq-"));
    process.env.MAW_VAULT_ROOT = tmpRoot;
    // two oracles: neo + david
    for (const oracle of ["neo", "david"]) {
      const inbox = join(tmpRoot, oracle, "ψ", "memory", oracle, "inbox");
      mkdirSync(inbox, { recursive: true });
    }
    writeFileSync(
      join(tmpRoot, "neo", "ψ", "memory", "neo", "inbox", "m1.md"),
      `---\nrecipient: neo\nteam: fleet\ntype: ask\nsubject: "hello"\n---\nbody`,
    );
    writeFileSync(
      join(tmpRoot, "david", "ψ", "memory", "david", "inbox", "m2.md"),
      `---\nrecipient: david\nteam: dev\ntype: review\n---\nbody`,
    );
    writeFileSync(
      join(tmpRoot, "neo", "ψ", "memory", "neo", "inbox", "malformed.md"),
      `not a note at all`,
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.MAW_VAULT_ROOT;
    else process.env.MAW_VAULT_ROOT = origRoot;
  });

  it("returns items + stats + errors from a real fleet layout", () => {
    const r = scanVault();
    expect(r.items).toHaveLength(2);
    expect(r.stats.totalScanned).toBe(3);
    expect(r.stats.totalReturned).toBe(2);
    expect(r.stats.oracles).toBe(2);
    expect(r.errors.some((e) => e.reason === "missing frontmatter")).toBe(true);
  });

  it("filters by recipient", () => {
    const r = scanVault({ recipient: "neo" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.oracle).toBe("neo");
  });

  it("filters by type", () => {
    const r = scanVault({ type: "review" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.type).toBe("review");
  });

  it("filters by maxAgeHours (age computed from mtime)", () => {
    // age out m1 by setting mtime 48h ago
    const old = (Date.now() - 48 * 3_600_000) / 1000;
    utimesSync(join(tmpRoot, "neo", "ψ", "memory", "neo", "inbox", "m1.md"), old, old);
    const r = scanVault({ maxAgeHours: 1 });
    expect(r.items.every((it) => it.oracle !== "neo" || it.subject !== "hello")).toBe(true);
  });

  it("aggregates byType in stats", () => {
    const r = scanVault();
    expect(r.stats.byType.ask).toBe(1);
    expect(r.stats.byType.review).toBe(1);
  });
});
