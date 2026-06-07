import { describe, expect, mock, test, beforeEach } from "bun:test";

const activityCalls: Array<{ target: string | undefined; opts: Record<string, unknown> }> = [];

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/activity/impl"), () => ({
  ACTIVITY_USAGE: "usage: maw activity <pane> [--watch] [--json] [--stuck-only] [--window=<dur>] [--samples=N] [--sampler=peek|follow] | maw activity --all [--watch] [--json] [--stuck-only] [--window=<dur>] [--samples=N] [--sampler=peek|follow]",
  cmdActivity: async (target: string | undefined, opts: Record<string, unknown>) => {
    activityCalls.push({ target, opts });
    if (target === "explode") throw new Error("activity exploded");
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/activity/index.ts?activity-index-coverage");

function ctx(source: "cli" | "api", args: unknown) {
  return { source, args } as never;
}

beforeEach(() => {
  activityCalls.length = 0;
});

describe("maw activity plugin index", () => {
  test("exports metadata and routes CLI pane flags", async () => {
    expect(command).toEqual({
      name: "activity",
      description: "Classify pane activity by diffing peek snapshots.",
    });

    const result = await handler(ctx("cli", [
      "50-mawjs:mawjs-features",
      "--watch",
      "--json",
      "--stuck-only",
      "--window",
      "10s",
      "--samples",
      "5",
      "--sampler=follow",
    ]));

    expect(result).toEqual({ ok: true });
    expect(activityCalls.at(-1)).toEqual({
      target: "50-mawjs:mawjs-features",
      opts: { all: false, watch: true, json: true, stuckOnly: true, window: "10s", samples: 5, sampler: "follow" },
    });
  });

  test("routes --all scans without a positional target", async () => {
    await expect(handler(ctx("cli", ["--all", "--json"]))).resolves.toEqual({ ok: true });
    expect(activityCalls.at(-1)).toEqual({
      target: undefined,
      opts: { all: true, watch: false, json: true, stuckOnly: false, window: undefined, samples: undefined, sampler: undefined },
    });
  });

  test("rejects missing targets, help, and target plus --all", async () => {
    await expect(handler(ctx("cli", []))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw activity") });
    await expect(handler(ctx("cli", ["--help"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw activity") });
    await expect(handler(ctx("cli", ["pane", "--all"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw activity") });
    await expect(handler(ctx("cli", ["--bad-target"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw activity") });
  });

  test("routes API args and reports handler errors", async () => {
    await expect(handler(ctx("api", {
      target: "api-pane",
      watch: true,
      json: true,
      stuckOnly: true,
      window: "5s",
      samples: 4,
      sampler: "peek",
    }))).resolves.toEqual({ ok: true });
    expect(activityCalls.at(-1)).toEqual({
      target: "api-pane",
      opts: { all: false, watch: true, json: true, stuckOnly: true, window: "5s", samples: 4, sampler: "peek" },
    });

    await expect(handler(ctx("api", { all: true, json: true }))).resolves.toEqual({ ok: true });
    expect(activityCalls.at(-1)).toMatchObject({ target: undefined, opts: { all: true, json: true } });

    await expect(handler(ctx("api", {}))).resolves.toEqual({ ok: false, error: "target is required" });
    await expect(handler(ctx("api", { all: true, target: "pane" }))).resolves.toEqual({ ok: false, error: "target cannot be combined with all" });
    await expect(handler(ctx("cli", ["explode"]))).resolves.toEqual({ ok: false, error: "activity exploded" });
  });
});
