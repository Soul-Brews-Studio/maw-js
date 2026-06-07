/**
 * Extra isolated coverage for best-effort MQTT publishing.
 * @maw-test-isolate
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let broker: string | undefined;
let nodeName: string | undefined;
const connectCalls: unknown[][] = [];
const publishCalls: unknown[][] = [];
const onCalls: unknown[][] = [];

mock.module("../../src/config", () => ({
  loadConfig: () => ({ node: nodeName, mqttPublish: broker ? { broker } : undefined }),
}));

mock.module("mqtt", () => ({
  default: {
    connect: (...args: unknown[]) => {
      connectCalls.push(args);
      return {
        on: (...onArgs: unknown[]) => {
          onCalls.push(onArgs);
          return undefined;
        },
        publish: (...publishArgs: unknown[]) => {
          publishCalls.push(publishArgs);
          return undefined;
        },
      };
    },
  },
}));

const { mqttPublish } = await import("../../src/core/transport/mqtt-publish.ts?coverage");

beforeEach(() => {
  broker = undefined;
  nodeName = undefined;
  connectCalls.length = 0;
  publishCalls.length = 0;
  onCalls.length = 0;
});

describe("mqttPublish", () => {
  test("is a no-op when no publish broker is configured", () => {
    mqttPublish("maw/feed", { ok: true });

    expect(connectCalls).toEqual([]);
    expect(publishCalls).toEqual([]);
  });

  test("connects once with node-scoped client id and publishes JSON best-effort", () => {
    broker = "mqtt://broker.local";
    nodeName = "alpha";

    mqttPublish("maw/feed", { event: "one" });
    mqttPublish("maw/feed", { event: "two" });

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0][0]).toBe("mqtt://broker.local");
    expect(connectCalls[0][1]).toMatchObject({
      clean: true,
      reconnectPeriod: 5000,
    });
    expect((connectCalls[0][1] as { clientId: string }).clientId).toMatch(/^maw-alpha-\d+$/);
    expect(onCalls).toEqual([["error", expect.any(Function)]]);
    expect(() => (onCalls[0][1] as () => void)()).not.toThrow();
    expect(publishCalls).toEqual([
      ["maw/feed", JSON.stringify({ event: "one" }), { qos: 0 }],
      ["maw/feed", JSON.stringify({ event: "two" }), { qos: 0 }],
    ]);
  });
});
