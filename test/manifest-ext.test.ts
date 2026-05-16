import { describe, test, expect } from "bun:test";
import { parseManifest } from "../src/plugin/manifest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Minimal valid WASM bytes (same as plugin-manifest.test.ts)
const MINIMAL_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "maw-manifest-ext-test-"));
}

// ---------------------------------------------------------------------------
// Backward compat — old manifests still parse
// ---------------------------------------------------------------------------

describe("backward compat", () => {
  test("minimal wasm manifest with no new fields still parses", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({ name: "old-plugin", version: "1.0.0", wasm: "plugin.wasm", sdk: "^1.0.0" }),
        dir,
      );
      expect(m.name).toBe("old-plugin");
      expect(m.hooks).toBeUndefined();
      expect(m.cron).toBeUndefined();
      expect(m.module).toBeUndefined();
      expect(m.transport).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("old cli shape (command + help only) still works", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "cli-old",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          cli: { command: "oldcmd", help: "old help" },
        }),
        dir,
      );
      expect(m.cli?.command).toBe("oldcmd");
      expect(m.cli?.help).toBe("old help");
      expect(m.cli?.aliases).toBeUndefined();
      expect(m.cli?.flags).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// New fields — happy path
// ---------------------------------------------------------------------------

describe("new manifest fields accepted", () => {
  test("accepts hooks with all sub-arrays", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "hook-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          hooks: { gate: ["before:send"], filter: ["msg:inbound"], on: ["msg:out"], late: ["session:end"] },
        }),
        dir,
      );
      expect(m.hooks?.gate).toEqual(["before:send"]);
      expect(m.hooks?.filter).toEqual(["msg:inbound"]);
      expect(m.hooks?.on).toEqual(["msg:out"]);
      expect(m.hooks?.late).toEqual(["session:end"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts cron with schedule and optional handler", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "cron-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          cron: { schedule: "0 * * * *", handler: "onTick" },
        }),
        dir,
      );
      expect(m.cron?.schedule).toBe("0 * * * *");
      expect(m.cron?.handler).toBe("onTick");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts module with exports and path", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "mod-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          module: { exports: ["greet", "ping"], path: "./lib.ts" },
        }),
        dir,
      );
      expect(m.module?.exports).toEqual(["greet", "ping"]);
      expect(m.module?.path).toBe("./lib.ts");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts transport.peer boolean", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "transport-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          transport: { peer: true },
        }),
        dir,
      );
      expect(m.transport?.peer).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts cli.aliases and cli.flags", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "cli-ext-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          cli: {
            command: "greet",
            aliases: ["hi", "hello"],
            help: "Say hello",
            flags: { verbose: "boolean", name: "string", count: "number" },
          },
        }),
        dir,
      );
      expect(m.cli?.command).toBe("greet");
      expect(m.cli?.aliases).toEqual(["hi", "hello"]);
      expect(m.cli?.flags).toEqual({ verbose: "boolean", name: "string", count: "number" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts plugin dependencies", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "dep-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          dependencies: { plugins: ["trace", "dig"] },
        }),
        dir,
      );
      expect(m.dependencies?.plugins).toEqual(["trace", "dig"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts plugin-owned capability namespaces", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "message-ledger-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          capabilityNamespaces: ["messages", "storage", "events"],
          capabilities: ["messages:ledger", "storage:sqlite", "events:message-lifecycle"],
        }),
        dir,
      );
      expect(m.capabilityNamespaces).toEqual(["messages", "storage", "events"]);
      expect(m.capabilities).toEqual(["messages:ledger", "storage:sqlite", "events:message-lifecycle"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts engine.serve persistent process metadata", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({
          name: "engine-plugin",
          version: "1.0.0",
          wasm: "plugin.wasm",
          sdk: "*",
          engine: {
            serve: {
              command: "bun run serve",
              prefix: "/api/hey-ledger",
              health: "/health",
              eventPath: "/events",
              events: ["MessageSend", "MessageDeliver"],
            },
          },
        }),
        dir,
      );
      expect(m.engine?.serve).toEqual({
        command: "bun run serve",
        prefix: "/api/hey-ledger",
        health: "/health",
        eventPath: "/events",
        events: ["MessageSend", "MessageDeliver"],
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("TS plugin with all new fields validates cleanly", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "index.ts"), `export default async function handler(args: string[]) { console.log("ok"); }`);
      const m = parseManifest(
        JSON.stringify({
          name: "full-ts-plugin",
          version: "2.0.0",
          entry: "index.ts",
          sdk: "^1.0.0",
          description: "Full feature plugin",
          author: "Nat",
          cli: { command: "full", aliases: ["f"], help: "do everything", flags: { dry: "boolean" } },
          api: { path: "/full", methods: ["GET", "POST"] },
          hooks: { on: ["msg:out"], late: ["session:end"] },
          cron: { schedule: "*/5 * * * *" },
          module: { exports: ["doStuff"], path: "./lib.ts" },
          transport: { peer: true },
          engine: { serve: { prefix: "/api/full", health: "/health", eventPath: "/events" } },
        }),
        dir,
      );
      expect(m.name).toBe("full-ts-plugin");
      expect(m.cli?.aliases).toEqual(["f"]);
      expect(m.hooks?.on).toEqual(["msg:out"]);
      expect(m.cron?.schedule).toBe("*/5 * * * *");
      expect(m.module?.exports).toEqual(["doStuff"]);
      expect(m.transport?.peer).toBe(true);
      expect(m.engine?.serve?.prefix).toBe("/api/full");
      expect(m.engine?.serve?.eventPath).toBe("/events");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation failures for new fields
// ---------------------------------------------------------------------------

describe("new field validation failures", () => {
  test("hooks non-object is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "bad", version: "1.0.0", wasm: "plugin.wasm", sdk: "*", hooks: "bad" }),
          dir,
        ),
      ).toThrow(/hooks/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("hooks.on with non-string array item is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "bad", version: "1.0.0", wasm: "plugin.wasm", sdk: "*", hooks: { on: [42] } }),
          dir,
        ),
      ).toThrow(/hooks\.on/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("cron without schedule is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "bad", version: "1.0.0", wasm: "plugin.wasm", sdk: "*", cron: { handler: "onTick" } }),
          dir,
        ),
      ).toThrow(/cron\.schedule/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("module with empty exports array is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "bad", version: "1.0.0", wasm: "plugin.wasm", sdk: "*", module: { exports: [], path: "./lib.ts" } }),
          dir,
        ),
      ).toThrow(/module\.exports/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("cli.flags with invalid type value is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad",
            version: "1.0.0",
            wasm: "plugin.wasm",
            sdk: "*",
            cli: { command: "go", flags: { x: "int" } },
          }),
          dir,
        ),
      ).toThrow(/cli\.flags/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("dependencies.plugins with invalid names is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad",
            version: "1.0.0",
            wasm: "plugin.wasm",
            sdk: "*",
            dependencies: { plugins: ["Trace"] },
          }),
          dir,
        ),
      ).toThrow(/dependencies\.plugins/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("capabilityNamespaces with invalid slug is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-capns",
            version: "1.0.0",
            wasm: "plugin.wasm",
            sdk: "*",
            capabilityNamespaces: ["Bad Namespace"],
          }),
          dir,
        ),
      ).toThrow(/capabilityNamespaces/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("engine.serve with non-api prefix is rejected", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({
            name: "bad-engine",
            version: "1.0.0",
            wasm: "plugin.wasm",
            sdk: "*",
            engine: { serve: { prefix: "/hey-ledger" } },
          }),
          dir,
        ),
      ).toThrow(/engine\.serve\.prefix/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
