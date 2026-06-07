/** Focused isolated coverage for src/plugins/builtin/mqtt-publish.ts. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let nodeName: string | undefined = "alpha";
const publishCalls: Array<[string, unknown]> = [];

mock.module(import.meta.resolve("../../src/config"), () => ({
  loadConfig: () => ({ node: nodeName }),
}));

const missingDependencyModule = await import("../../src/plugins/builtin/mqtt-publish.ts?builtin-mqtt-missing-dependency");
let missingDependencyOnCalls = 0;
missingDependencyModule.default({
  on: () => {
    missingDependencyOnCalls++;
  },
} as any);

mock.module(import.meta.resolve("../../src/mqtt-publish"), () => ({
  mqttPublish: (topic: string, payload: unknown) => {
    publishCalls.push([topic, payload]);
  },
}));

const { default: registerMqttPublishBuiltin } = await import(
  "../../src/plugins/builtin/mqtt-publish.ts?builtin-mqtt-publish-coverage"
);

beforeEach(() => {
  nodeName = "alpha";
  publishCalls.length = 0;
});

describe("builtin mqtt-publish plugin", () => {
  test("skips silently when the legacy mqtt-publish dependency is absent", () => {
    expect(missingDependencyOnCalls).toBe(0);
  });

  test("does not subscribe when config has no node name", () => {
    nodeName = undefined;
    let onCalls = 0;

    registerMqttPublishBuiltin({
      on: () => {
        onCalls++;
      },
    } as any);

    expect(onCalls).toBe(0);
    expect(publishCalls).toEqual([]);
  });

  test("publishes feed events to oracle and node topics", () => {
    let eventName: string | undefined;
    let handler: ((event: { oracle: string; event: string; payload?: unknown }) => void) | undefined;

    registerMqttPublishBuiltin({
      on: (name: string, fn: typeof handler) => {
        eventName = name;
        handler = fn;
      },
    } as any);

    const event = { oracle: "mawjs", event: "task.done", payload: { ok: true } };
    handler!(event);

    expect(eventName).toBe("*");
    expect(publishCalls).toEqual([
      ["maw/v1/oracle/mawjs/feed", event],
      ["maw/v1/node/alpha/feed", event],
    ]);
  });
});
