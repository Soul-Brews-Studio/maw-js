import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { InvokeContext } from "../../../plugin/types";
import handler, { command } from "./index";

describe("cross-team-queue plugin — smoke + surfaces", () => {
  it("exports command metadata", () => {
    expect(command.name).toBe("cross-team-queue");
    expect(command.description).toBeTruthy();
  });

  it("API surface — missing MAW_VAULT_ROOT returns ok with config error in body (no silent-200)", async () => {
    const orig = process.env.MAW_VAULT_ROOT;
    delete process.env.MAW_VAULT_ROOT;
    try {
      const ctx: InvokeContext = { source: "api", args: {} };
      const result = await handler(ctx);
      expect(result.ok).toBe(true);
      const body = JSON.parse(result.output ?? "{}");
      expect(body.items).toEqual([]);
      expect(body.errors.length).toBeGreaterThan(0);
      expect(body.errors[0].reason).toBe("MAW_VAULT_ROOT not set");
    } finally {
      if (orig !== undefined) process.env.MAW_VAULT_ROOT = orig;
    }
  });
});

describe("cross-team-queue plugin — fixture fleet", () => {
  let tmpRoot: string;
  const origRoot = process.env.MAW_VAULT_ROOT;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ctq-plugin-"));
    process.env.MAW_VAULT_ROOT = tmpRoot;
    const inbox = join(tmpRoot, "neo", "ψ", "memory", "neo", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, "m1.md"),
      `---\nrecipient: neo\nteam: fleet\ntype: ask\nsubject: "hi"\n---\nbody`,
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.MAW_VAULT_ROOT;
    else process.env.MAW_VAULT_ROOT = origRoot;
  });

  it("API surface — returns JSON with items + stats + errors keys", async () => {
    const ctx: InvokeContext = { source: "api", args: {} };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    const body = JSON.parse(result.output ?? "{}");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.stats).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].recipient).toBe("neo");
    expect(body.stats.totalReturned).toBe(1);
  });

  it("API surface — query filter narrows results", async () => {
    const ctx: InvokeContext = { source: "api", args: { recipient: "nobody" } };
    const result = await handler(ctx);
    const body = JSON.parse(result.output ?? "{}");
    expect(body.items).toHaveLength(0);
  });

  it("API surface — accepts max-age-hours as string (query params)", async () => {
    const ctx: InvokeContext = { source: "api", args: { "max-age-hours": "1000" } };
    const result = await handler(ctx);
    const body = JSON.parse(result.output ?? "{}");
    expect(body.items.length).toBeGreaterThanOrEqual(0);
  });

  it("CLI surface — renders human-readable output", async () => {
    const ctx: InvokeContext = { source: "cli", args: [] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("cross-team-queue");
  });

  it("CLI surface — --json emits JSON instead of pretty", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["--json"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(true);
    const body = JSON.parse(result.output ?? "{}");
    expect(body.items).toHaveLength(1);
  });
});
