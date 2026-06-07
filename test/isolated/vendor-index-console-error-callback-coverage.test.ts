/** Targeted coverage for console.error capture callbacks in thin vendor/command index handlers. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Ctx = { source: "cli" | "api"; args: unknown; writer?: (...args: unknown[]) => void };

type Call = { name: string; args: unknown[] };

let calls: Call[] = [];
let throws = new Set<string>();

function mockBoth(spec: string, factory: () => Record<string, unknown>) {
  mock.module(import.meta.resolve(spec), factory);
  if (!spec.endsWith(".ts")) mock.module(import.meta.resolve(`${spec}.ts`), factory);
}

function record(name: string, ...args: unknown[]) {
  calls.push({ name, args });
  console.error(`${name}:stderr:${args.map(String).join("|") || "<none>"}`);
  if (throws.has(name)) throw new Error(`${name} exploded`);
  console.log(`${name}:stdout`);
}

mockBoth("../../src/vendor/mpr-plugins/about/internal/impl-about", () => ({
  cmdOracleAbout: async (oracle: string) => record("about", oracle),
}));

mockBoth("../../src/vendor/mpr-plugins/archive/impl", () => ({
  cmdArchive: async (oracle: string, opts: unknown) => record("archive", oracle, JSON.stringify(opts)),
}));

mockBoth("../../src/vendor/mpr-plugins/attach/impl", () => ({
  cmdAttach: async (name: string, opts: unknown) => record("attach", name, JSON.stringify(opts)),
}));

mockBoth("../../src/vendor/mpr-plugins/avengers/impl", () => ({
  cmdAvengers: async (sub: string) => record("avengers", sub),
}));

mockBoth("../../src/vendor/mpr-plugins/capture/impl", () => ({
  cmdCapture: async (target: string, opts: unknown) => record("capture", target, JSON.stringify(opts)),
}));

mockBoth("../../src/vendor/mpr-plugins/contacts/impl", () => ({
  cmdContactsLs: async () => record("contacts-ls"),
  cmdContactsAdd: async (name: string, args: string[]) => record("contacts-add", name, args.join(",")),
  cmdContactsRm: async (name: string) => record("contacts-rm", name),
}));

mockBoth("../../src/vendor/mpr-plugins/doctor/impl", () => ({
  cmdDoctor: async (args: string[]) => {
    record("doctor", args.join(","));
    return { ok: !throws.has("doctor-result") };
  },
}));

mockBoth("../../src/vendor/mpr-plugins/sleep/impl", () => ({
  cmdSleepOne: async (oracle: string, window?: string) => record("sleep", oracle, window ?? ""),
}));

mockBoth("../../src/vendor/mpr-plugins/split/impl", () => ({
  cmdSplit: async (target: string, opts: unknown) => record("split", target, JSON.stringify(opts)),
}));

mockBoth("../../src/vendor/mpr-plugins/tag/impl", () => ({
  cmdTag: async (target: string, opts: unknown) => record("tag", target, JSON.stringify(opts)),
}));

mockBoth("../../src/vendor/mpr-plugins/zoom/impl", () => ({
  cmdZoom: async (target: string, opts: unknown) => record("zoom", target, JSON.stringify(opts)),
}));

mockBoth("../../src/commands/shared/transport", () => ({
  cmdTransportStatus: async () => record("transport"),
}));

const about = await import("../../src/vendor/mpr-plugins/about/index.ts?vendor-index-console-error-callback-coverage");
const archive = await import("../../src/vendor/mpr-plugins/archive/index.ts?vendor-index-console-error-callback-coverage");
const attach = await import("../../src/vendor/mpr-plugins/attach/index.ts?vendor-index-console-error-callback-coverage");
const avengers = await import("../../src/vendor/mpr-plugins/avengers/index.ts?vendor-index-console-error-callback-coverage");
const capture = await import("../../src/vendor/mpr-plugins/capture/index.ts?vendor-index-console-error-callback-coverage");
const contacts = await import("../../src/vendor/mpr-plugins/contacts/index.ts?vendor-index-console-error-callback-coverage");
const doctor = await import("../../src/vendor/mpr-plugins/doctor/index.ts?vendor-index-console-error-callback-coverage");
const sleep = await import("../../src/vendor/mpr-plugins/sleep/index.ts?vendor-index-console-error-callback-coverage");
const split = await import("../../src/vendor/mpr-plugins/split/index.ts?vendor-index-console-error-callback-coverage");
const tag = await import("../../src/vendor/mpr-plugins/tag/index.ts?vendor-index-console-error-callback-coverage");
const zoom = await import("../../src/vendor/mpr-plugins/zoom/index.ts?vendor-index-console-error-callback-coverage");
const transport = await import("../../src/commands/plugins/transport/index.ts?vendor-index-console-error-callback-coverage");

function ctx(source: Ctx["source"], args: unknown): Ctx {
  return { source, args };
}

beforeEach(() => {
  calls = [];
  throws = new Set();
});

describe("thin index handlers capture console.error without a writer", () => {
  test("covers stderr capture callbacks across many vendor and command indexes", async () => {
    const cases: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: "about", run: () => about.default(ctx("cli", ["neo"])) },
      { name: "archive", run: () => archive.default(ctx("cli", ["neo", "--dry-run"])) },
      { name: "attach", run: () => attach.default(ctx("cli", ["neo", "--dry-run", "--yes"])) },
      { name: "avengers", run: () => avengers.default(ctx("cli", ["best"])) },
      { name: "capture", run: () => capture.default(ctx("cli", ["neo", "--pane", "2", "--lines", "5", "--full"])) },
      { name: "contacts-ls", run: () => contacts.default(ctx("cli", [])) },
      { name: "contacts-add", run: () => contacts.default(ctx("api", { method: "POST", action: "add", name: "neo", transport: "maw://neo" })) },
      { name: "contacts-rm", run: () => contacts.default(ctx("api", { method: "POST", action: "rm", name: "neo" })) },
      { name: "doctor", run: () => doctor.default(ctx("api", { check: "install" })) },
      { name: "sleep", run: () => sleep.default(ctx("cli", ["neo", "main"])) },
      { name: "split", run: () => split.default(ctx("api", { target: "neo", pct: 40, vertical: true, noAttach: true })) },
      { name: "tag", run: () => tag.default(ctx("api", { target: "neo", pane: 3, title: "Focus", meta: ["role=test"] })) },
      { name: "zoom", run: () => zoom.default(ctx("api", { target: "neo", pane: 1 })) },
      { name: "transport", run: () => transport.default(ctx("api", { sub: "status" })) },
    ];

    for (const entry of cases) {
      await expect(entry.run()).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining(`${entry.name}:stderr`),
      });
    }

    expect(calls.map((call) => call.name)).toEqual(cases.map((entry) => entry.name));
  });

  test("covered callbacks feed captured stderr into error fallbacks", async () => {
    throws = new Set(["attach", "capture", "split", "tag", "zoom", "transport"]);

    await expect(attach.default(ctx("cli", ["neo"]))).resolves.toMatchObject({
      ok: false,
      error: "attach exploded",
      output: expect.stringContaining("attach:stderr:neo"),
    });
    await expect(capture.default(ctx("api", { target: "neo" }))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("capture:stderr:neo"),
    });
    await expect(split.default(ctx("cli", ["neo"]))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("split:stderr:neo"),
    });
    await expect(tag.default(ctx("cli", ["neo"]))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("tag:stderr:neo"),
    });
    await expect(zoom.default(ctx("cli", ["neo"]))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("zoom:stderr:neo"),
    });
    await expect(transport.default(ctx("cli", []))).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("transport:stderr"),
    });
  });

  test("doctor check failures preserve stderr output while using the fixed failure message", async () => {
    throws = new Set(["doctor-result"]);

    await expect(doctor.default(ctx("cli", ["peers"]))).resolves.toEqual({
      ok: false,
      output: "doctor:stderr:peers\ndoctor:stdout",
      error: "one or more checks failed",
    });
  });
});
