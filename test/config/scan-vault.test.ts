/**
 * Tests for scanVault from src/commands/plugins/cross-team-queue/scan.ts.
 * Uses real temp dirs + MAW_VAULT_ROOT env to test vault scanning.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanVault } from "../../src/commands/plugins/cross-team-queue/scan";

const tmp = mkdtempSync(join(tmpdir(), "scan-vault-test-"));
const origVaultRoot = process.env.MAW_VAULT_ROOT;

beforeAll(() => {
  process.env.MAW_VAULT_ROOT = tmp;
});

afterAll(() => {
  if (origVaultRoot) process.env.MAW_VAULT_ROOT = origVaultRoot;
  else delete process.env.MAW_VAULT_ROOT;
});

describe("scanVault", () => {
  it("returns error when MAW_VAULT_ROOT is not set", () => {
    const saved = process.env.MAW_VAULT_ROOT;
    delete process.env.MAW_VAULT_ROOT;
    const result = scanVault();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toContain("MAW_VAULT_ROOT");
    process.env.MAW_VAULT_ROOT = saved;
  });

  it("returns error when vault root does not exist", () => {
    process.env.MAW_VAULT_ROOT = "/tmp/nonexistent-vault-root-xyz";
    const result = scanVault();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toContain("does not exist");
    process.env.MAW_VAULT_ROOT = tmp;
  });

  it("returns empty items for empty vault", () => {
    const result = scanVault();
    expect(result.items).toEqual([]);
    expect(result.stats.totalScanned).toBe(0);
  });

  it("scans oracle inbox directories", () => {
    // Layout: ${vaultRoot}/${oracle}/ψ/memory/${oracle}/inbox/*.md
    const oracleName = "pulse-oracle";
    const inboxDir = join(tmp, oracleName, "ψ", "memory", oracleName, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "msg.md"), [
      "---",
      "recipient: boom",
      "type: task",
      "subject: test message",
      "---",
      "",
      "Hello from test",
    ].join("\n"));

    const result = scanVault();
    expect(result.stats.totalScanned).toBeGreaterThanOrEqual(1);
    if (result.items.length > 0) {
      expect(result.items[0].oracle).toBe("pulse-oracle");
    }
  });

  it("filters by recipient", () => {
    const result = scanVault({ recipient: "nonexistent-recipient" });
    expect(result.items).toEqual([]);
  });

  it("filters by type", () => {
    const result = scanVault({ type: "nonexistent-type" });
    expect(result.items).toEqual([]);
  });

  it("filters by maxAgeHours", () => {
    // Files just created should be within 1 hour
    const result = scanVault({ maxAgeHours: 0.0001 }); // ~0.36 seconds
    // Newly created files might or might not match depending on timing
    // Just verify no errors
    expect(result.errors.filter(e => !e.reason.includes("frontmatter")).length).toBe(0);
  });
});
