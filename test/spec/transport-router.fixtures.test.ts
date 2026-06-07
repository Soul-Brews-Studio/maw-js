import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyError,
  TransportRouter,
  type Transport,
  type TransportResult,
  type TransportTarget,
} from "../../src/core/transport/transport";

type ClassifyFixture = {
  kind: "classifyError";
  name: string;
  error: unknown;
  expected: ReturnType<typeof classifyError>;
};

type SendAction =
  | { type: "ok" }
  | { type: "false" }
  | { type: "throw"; error: string };

type TransportFixture = {
  name: string;
  connected?: boolean;
  canReach?: boolean;
  send?: SendAction;
};

type SendFixture = {
  kind: "send";
  name: string;
  target?: TransportTarget;
  message?: string;
  from?: string;
  transports: TransportFixture[];
  expected: { result: TransportResult; sent: string[] };
};

type Fixture = ClassifyFixture | SendFixture;

const fixtureUrl = new URL("./transport-router.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Fixture[];
const defaultTarget: TransportTarget = { oracle: "neo", tmuxTarget: "neo:1" };

function fixtureTransport(fixture: TransportFixture, sent: string[]): Transport {
  const action = fixture.send ?? { type: "ok" };
  return {
    name: fixture.name,
    connected: fixture.connected ?? true,
    connect: async () => {},
    disconnect: async () => {},
    canReach: () => fixture.canReach ?? true,
    send: async () => {
      sent.push(fixture.name);
      if (action.type === "throw") throw new Error(action.error);
      return action.type === "ok";
    },
    publishPresence: async () => {},
    publishFeed: async () => {},
    onMessage: () => {},
    onPresence: () => {},
    onFeed: () => {},
  };
}

async function withoutTransportLogs<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}

describe("portable transport router fixtures (#1612)", () => {
  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      if (fixture.kind === "classifyError") {
        expect(classifyError(fixture.error)).toEqual(fixture.expected);
        return;
      }

      const router = new TransportRouter();
      const sent: string[] = [];
      for (const transport of fixture.transports) {
        router.register(fixtureTransport(transport, sent));
      }

      const result = await withoutTransportLogs(() => router.send(
        fixture.target ?? defaultTarget,
        fixture.message ?? "hello",
        fixture.from ?? "codex",
      ));

      expect(result).toEqual(fixture.expected.result);
      expect(sent).toEqual(fixture.expected.sent);
    });
  }
});
