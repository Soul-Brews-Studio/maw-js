import { beforeEach, describe, expect, mock, test } from "bun:test";

const streamCalls: Array<{ target: string; opts: Record<string, unknown> }> = [];

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/stream/impl"), () => ({
  STREAM_USAGE: "usage: maw stream <session>:<win> [--into <session>] [--name <alias>] | maw stream --unlink <session>:<alias>",
  cmdStream: async (target: string, opts: Record<string, unknown>) => {
    streamCalls.push({ target, opts });
    if (target === "explode:main") throw new Error("stream exploded");
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/stream/index.ts?stream-index-coverage");

function ctx(source: "cli" | "api", args: unknown) {
  return { source, args } as never;
}

beforeEach(() => {
  streamCalls.length = 0;
});

describe("maw stream plugin index", () => {
  test("exports metadata and routes CLI link flags into cmdStream", async () => {
    expect(command).toEqual({
      name: "stream",
      description: "Mirror a tmux window into another session with link-window.",
    });

    const result = await handler(ctx("cli", [
      "50-mawjs:mawjs-features",
      "--into",
      "observer",
      "--name=features-copy",
    ]));

    expect(result).toEqual({ ok: true });
    expect(streamCalls.at(-1)).toEqual({
      target: "50-mawjs:mawjs-features",
      opts: { into: "observer", name: "features-copy", unlink: false },
    });
  });

  test("routes unlink without accepting link-only flags", async () => {
    await expect(handler(ctx("cli", ["--unlink", "observer:features-copy"]))).resolves.toEqual({ ok: true });
    expect(streamCalls.at(-1)).toEqual({
      target: "observer:features-copy",
      opts: { into: undefined, name: undefined, unlink: true },
    });

    await expect(handler(ctx("cli", ["--unlink", "observer:features-copy", "--name", "copy"])))
      .resolves.toEqual({ ok: false, error: "stream: --unlink takes only <session>:<alias>" });
    await expect(handler(ctx("api", { target: "observer:features-copy", unlink: true, into: "other" })))
      .resolves.toEqual({ ok: false, error: "stream: --unlink takes only <session>:<alias>" });
  });

  test("rejects missing, help, flag-shaped, and extra positional CLI args with usage", async () => {
    await expect(handler(ctx("cli", []))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw stream") });
    await expect(handler(ctx("cli", ["--help"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw stream") });
    await expect(handler(ctx("cli", ["--bad-target"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw stream") });
    await expect(handler(ctx("cli", ["source:main", "extra"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw stream") });
  });

  test("routes API args and reports handler errors", async () => {
    await expect(handler(ctx("api", {
      target: "api-session:main",
      into: "api-view",
      name: "mirror",
    }))).resolves.toEqual({ ok: true });
    expect(streamCalls.at(-1)).toEqual({
      target: "api-session:main",
      opts: { into: "api-view", name: "mirror", unlink: false },
    });

    await expect(handler(ctx("api", {}))).resolves.toEqual({ ok: false, error: "target is required" });
    await expect(handler(ctx("cli", ["explode:main"]))).resolves.toEqual({ ok: false, error: "stream exploded" });
  });
});
