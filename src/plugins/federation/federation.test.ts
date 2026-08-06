import { describe, it, expect } from "bun:test";
import type { InvokeContext } from "../../../plugin/types";
import handler, { command } from "./index";

describe("federation plugin — smoke", () => {
  it("exports command metadata", () => {
    expect(command.name).toBe("federation");
    expect(command.description).toBeTruthy();
  });

  it("CLI — unknown sub returns usage error", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["bogus-sub"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("usage");
    expect(result.error ?? "").toContain("status|sync");
  });

  it("CLI — --help treated as unknown sub, returns usage", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["--help"] };
    const result = await handler(ctx);
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("usage");
  });

  // status/ls (no sub) dynamically imports shared/federation and hits peers.
  // sync path imports shared/federation-sync and writes to disk / rsyncs peers.
  it.skip("CLI — status pings federation peers (requires live federation)", () => {});
  it.skip("CLI — sync runs across peers (requires live federation + disk writes)", () => {});
});
