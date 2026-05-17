import { describe, expect, test } from "bun:test";

const { withContext, refreshContext } = await import("../src/lib/context");

function fakeContext() {
  const values = new Map<string, unknown>();
  return {
    values,
    context: {
      set(key: string, value: unknown) {
        values.set(key, value);
      },
    },
  };
}

function fakeConfig(label: string) {
  return {
    host: "local",
    port: 3456,
    oracleUrl: "http://localhost:47779",
    env: {},
    commands: { default: "codex" },
    sessions: {},
    label,
  };
}

describe("withContext default-suite coverage", () => {
  test("loads config once, injects it into context, and awaits next", async () => {
    refreshContext();
    const calls: string[] = [];
    const middleware = withContext(() => {
      calls.push("load");
      return fakeConfig("cached") as never;
    });
    const first = fakeContext();
    const second = fakeContext();
    const events: string[] = [];

    await middleware(first.context as never, async () => {
      events.push("first-next");
    });
    await middleware(second.context as never, async () => {
      events.push("second-next");
    });

    const firstConfig = first.values.get("config");
    expect(firstConfig).toBeTruthy();
    expect(second.values.get("config")).toBe(firstConfig);
    expect(calls).toEqual(["load"]);
    expect(events).toEqual(["first-next", "second-next"]);
  });

  test("refreshContext is idempotent and clears middleware cache before reuse", async () => {
    refreshContext();
    refreshContext();
    const middleware = withContext(() => fakeConfig("after-refresh") as never);
    const ctx = fakeContext();

    await middleware(ctx.context as never, async () => undefined);

    expect(ctx.values.get("config")).toMatchObject({ label: "after-refresh" });
    expect(refreshContext()).toBeUndefined();
  });
});
