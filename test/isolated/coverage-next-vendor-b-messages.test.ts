import { describe, expect, test } from "bun:test";

const { installServeShutdown } = await import("../../src/vendor/mpr-plugins/messages/index.ts?coverage-next-vendor-b-messages");

describe("coverage-next vendor-b messages shutdown", () => {
  test("shutdown handler is idempotent and stops after unregister settles", async () => {
    const callbacks = new Map<string, () => void>();
    const stops: boolean[] = [];
    const exits: number[] = [];
    let unregisterCalls = 0;

    const shutdown = installServeShutdown("http://engine.local", {
      stop: (force?: boolean) => { stops.push(Boolean(force)); },
    }, {
      once: ((event: string, cb: () => void) => {
        callbacks.set(event, cb);
        return process;
      }) as typeof process.once,
      unregister: async () => { unregisterCalls += 1; },
      exit: ((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit,
    });

    expect(callbacks.has("SIGTERM")).toBe(true);
    expect(callbacks.has("SIGINT")).toBe(true);

    await shutdown();
    callbacks.get("SIGINT")?.();

    expect(unregisterCalls).toBe(1);
    expect(stops).toEqual([true]);
    expect(exits).toEqual([0]);
  });
});
