import { beforeEach, describe, expect, mock, test } from "bun:test";

const followCalls: Array<{ target: string; opts: Record<string, unknown> }> = [];

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/follow/impl"), () => ({
  FOLLOW_USAGE: "usage: maw follow <pane> [--since=<dur>] [--json] [--grep <pattern>] [--quit-on-idle=<dur>]",
  cmdFollow: async (target: string, opts: Record<string, unknown>) => {
    followCalls.push({ target, opts });
    if (target === "explode") throw new Error("follow exploded");
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/follow/index.ts?follow-index-coverage");

function ctx(source: "cli" | "api", args: unknown) {
  return { source, args } as never;
}

beforeEach(() => {
  followCalls.length = 0;
});

describe("maw follow plugin index", () => {
  test("exports metadata and routes CLI flags into cmdFollow", async () => {
    expect(command).toEqual({
      name: "follow",
      description: "Follow live pane output through the PTY websocket bridge.",
    });

    const result = await handler(ctx("cli", [
      "50-mawjs:1.0",
      "--since",
      "5m",
      "--json",
      "--grep",
      "ready",
      "--quit-on-idle",
      "10s",
    ]));

    expect(result).toEqual({ ok: true });
    expect(followCalls.at(-1)).toEqual({
      target: "50-mawjs:1.0",
      opts: { since: "5m", json: true, grep: "ready", quitOnIdle: "10s" },
    });
  });

  test("rejects CLI help and flag-shaped targets with usage", async () => {
    await expect(handler(ctx("cli", []))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw follow") });
    await expect(handler(ctx("cli", ["--help"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw follow") });
    await expect(handler(ctx("cli", ["--bad-target"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw follow") });
  });

  test("routes API args and reports handler errors", async () => {
    await expect(handler(ctx("api", {
      target: "api-pane",
      since: "1m",
      json: true,
      grep: "tick",
      quitOnIdle: "2s",
    }))).resolves.toEqual({ ok: true });
    expect(followCalls.at(-1)).toEqual({
      target: "api-pane",
      opts: { since: "1m", json: true, grep: "tick", quitOnIdle: "2s" },
    });

    await expect(handler(ctx("api", {}))).resolves.toEqual({ ok: false, error: "target is required" });
    await expect(handler(ctx("cli", ["explode"]))).resolves.toEqual({ ok: false, error: "follow exploded" });
  });
});
