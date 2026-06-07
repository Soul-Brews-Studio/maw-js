import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

type ConsentAction = "hey" | "team-invite" | "plugin-install";
type Pending = { id: string; from: string; to: string; action: ConsentAction; summary: string; status: string };
type Trust = { from: string; to: string; action: ConsentAction; approvedAt: string };

const root = join(import.meta.dir, "../..");
let pendingRows: Pending[] = [];
let trustRows: Trust[] = [];
let config: Record<string, unknown> = { node: "m5" };
const recordedTrust: unknown[] = [];
const removeCalls: Array<{ from: string; to: string; action: ConsentAction }> = [];
let approveResult: { ok: boolean; error?: string; entry?: { from: string; to: string; action: ConsentAction } } = {
  ok: true,
  entry: { from: "m5", to: "oracle", action: "hey" },
};
let rejectResult: { ok: boolean; error?: string } = { ok: true };
let removeResult = true;

const sdkMock = {
  listPending: () => pendingRows,
  listTrust: () => trustRows,
  recordTrust: (entry: unknown) => recordedTrust.push(entry),
  removeTrust: (from: string, to: string, action: ConsentAction) => {
    removeCalls.push({ from, to, action });
    return removeResult;
  },
  approveConsent: async () => approveResult,
  rejectConsent: () => rejectResult,
  loadConfig: () => config,
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const { default: consentHandler, command } = await import("../../src/vendor/mpr-plugins/consent/index.ts");

beforeEach(() => {
  pendingRows = [];
  trustRows = [];
  config = { node: "m5" };
  recordedTrust.length = 0;
  removeCalls.length = 0;
  approveResult = { ok: true, entry: { from: "m5", to: "oracle", action: "hey" } };
  rejectResult = { ok: true };
  removeResult = true;
});

describe("consent plugin standalone boundary (#2250)", () => {
  test("imports consent helpers only through the SDK boundary", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/consent/index.ts"), "utf8");
    expect(command).toMatchObject({ name: "consent" });
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);

    const sdkSource = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(sdkSource).toContain("../core/consent");
  });

  test("lists pending requests through SDK helpers", async () => {
    pendingRows = [{
      id: "req-1",
      from: "neo",
      to: "m5",
      action: "hey",
      status: "pending",
      summary: "approve cross-oracle hey",
    }];

    const result = await consentHandler({ source: "cli", args: ["list"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("req-1");
    expect(result.output).toContain("neo → m5");
    expect(result.output).toContain("approve cross-oracle hey");
  });

  test("trust writes use loadConfig node and recordTrust from SDK", async () => {
    config = { node: "codex-5" };

    const result = await consentHandler({ source: "cli", args: ["trust", "oracle", "team-invite"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("codex-5 → oracle:team-invite");
    expect(recordedTrust).toEqual([{
      from: "codex-5",
      to: "oracle",
      action: "team-invite",
      approvedAt: expect.any(String),
      approvedBy: "human",
      requestId: null,
    }]);
  });

  test("approve, reject, and untrust route through SDK results", async () => {
    const approved = await consentHandler({ source: "cli", args: ["approve", "req-1", "123456"] } as any);
    expect(approved.ok).toBe(true);
    expect(approved.output).toContain("approved req-1");

    rejectResult = { ok: false, error: "already rejected" };
    const rejected = await consentHandler({ source: "cli", args: ["reject", "req-1"] } as any);
    expect(rejected).toEqual({ ok: false, error: "already rejected" });

    const untrusted = await consentHandler({ source: "cli", args: ["untrust", "oracle"] } as any);
    expect(untrusted.ok).toBe(true);
    expect(removeCalls).toEqual([{ from: "m5", to: "oracle", action: "hey" }]);
  });

  test("invalid subcommands and actions stay local validation errors", async () => {
    const badAction = await consentHandler({ source: "cli", args: ["trust", "oracle", "dance"] } as any);
    expect(badAction.ok).toBe(false);
    expect(badAction.error).toContain("unknown action 'dance'");

    const badSub = await consentHandler({ source: "cli", args: ["wat"] } as any);
    expect(badSub.ok).toBe(false);
    expect(badSub.error).toContain("unknown subcommand: wat");
    expect(badSub.error).toContain("usage:");
  });
});
