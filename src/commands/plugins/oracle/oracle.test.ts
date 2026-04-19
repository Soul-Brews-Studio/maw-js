import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";

mock.module("./impl", () => ({
  cmdOracleList: async () => {
    console.log("Oracle Fleet  (1/2 awake)");
  },
  cmdOracleScan: async (_opts: any) => {
    console.log("Scanned 5 oracles locally");
  },
  cmdOracleScanStale: async (_opts: any) => {
    console.log("Stale oracle scan  (DEAD 1  STALE 2)");
  },
  cmdOracleFleet: async (_opts: any) => {
    console.log("Oracle Fleet  (5 oracles)");
  },
  cmdOracleAbout: async (name: string) => {
    console.log(`Oracle — ${name}`);
  },
}));

mock.module("./impl-nickname", () => ({
  cmdOracleSetNickname: (name: string, nickname: string) => {
    console.log(`set-nickname ${name}=${nickname}`);
  },
  cmdOracleGetNickname: (name: string) => {
    console.log(`get-nickname ${name}`);
  },
}));

describe("oracle plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeEach(async () => {
    const mod = await import("./index");
    handler = mod.default;
  });

  it("cli: ls lists oracles", async () => {
    const result = await handler({ source: "cli", args: ["ls"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Oracle Fleet");
  });

  it("cli: scan runs oracle scan", async () => {
    const result = await handler({ source: "cli", args: ["scan"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Scanned");
  });

  it("cli: scan --stale dispatches to stale classifier", async () => {
    const result = await handler({ source: "cli", args: ["scan", "--stale"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Stale oracle scan");
  });

  it("cli: fleet shows fleet", async () => {
    const result = await handler({ source: "cli", args: ["fleet"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Oracle Fleet");
  });

  it("cli: about <name> shows oracle details", async () => {
    const result = await handler({ source: "cli", args: ["about", "neo"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Oracle — neo");
  });

  it("cli: set-nickname dispatches with name + nickname", async () => {
    const result = await handler({
      source: "cli",
      args: ["set-nickname", "neo", "Moe"],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("set-nickname neo=Moe");
  });

  it("cli: set-nickname with missing nickname arg returns usage error", async () => {
    const result = await handler({ source: "cli", args: ["set-nickname", "neo"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/usage/i);
  });

  it("cli: get-nickname dispatches by name", async () => {
    const result = await handler({ source: "cli", args: ["get-nickname", "neo"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("get-nickname neo");
  });

  it("cli: get-nickname with no name returns usage error", async () => {
    const result = await handler({ source: "cli", args: ["get-nickname"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/usage/i);
  });

  it("api: set-nickname via query dispatches", async () => {
    const result = await handler({
      source: "api",
      args: { sub: "set-nickname", name: "neo", nickname: "Moe" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("set-nickname neo=Moe");
  });

  // Behavior #7: fleet deprecation alias
  // After redesign: `maw oracle fleet` shows a deprecation warning and delegates to ls.
  // Both the warning AND "Oracle Fleet" (from cmdOracleList mock) should appear in output.
  // Will fail until oracle-ls-impl ships the dispatcher change. -- alpha.53
  it("cli: fleet → deprecation warning appears alongside ls output", async () => {
    const result = await handler({ source: "cli", args: ["fleet"] });
    expect(result.ok).toBe(true);
    // Oracle Fleet still appears (from cmdOracleList being called)
    expect(result.output).toContain("Oracle Fleet");
    // Deprecation notice is emitted (console.error captured in output)
    expect(result.output).toMatch(/deprecat|alias|use.*ls|fleet.*ls/i);
  });
});
