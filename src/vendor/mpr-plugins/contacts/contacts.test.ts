import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { InvokeContext } from "maw-js/sdk";

mock.module("./impl", () => ({
  cmdContactsLs: async () => {
    console.log("CONTACTS (2):");
    console.log("  neo           maw: neo@white");
  },
  cmdContactsAdd: async (name: string, args: string[]) => {
    console.log(`✓ contact ${name} saved`);
  },
  cmdContactsRm: async (name: string) => {
    console.log(`✓ contact ${name} retired`);
  },
}));

describe("contacts plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeEach(async () => {
    const mod = await import("./index");
    handler = mod.default;
  });

  it("cli: ls subcommand lists contacts", async () => {
    const result = await handler({ source: "cli", args: ["ls"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("CONTACTS");
  });

  it("cli: add subcommand adds a contact", async () => {
    const result = await handler({ source: "cli", args: ["add", "neo", "--maw", "neo@white"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("neo saved");
  });

  it("cli: rm subcommand removes a contact", async () => {
    const result = await handler({ source: "cli", args: ["rm", "neo"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("neo retired");
  });

  it("api GET: list contacts", async () => {
    const result = await handler({ source: "api", args: { method: "GET" } });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("CONTACTS");
  });

  it("api POST: add contact", async () => {
    const result = await handler({
      source: "api",
      args: { method: "POST", action: "add", name: "neo", transport: "neo@white" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("neo saved");
  });
});
