import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { requestReplyApi } from "../../src/api/request-reply";
import { requestReplyStore } from "../../src/core/request-reply";

// SUBPROCESS + server integration — proves the full `maw hey [request:id]` →
// `maw reply id` loop works at the real entrypoint (the gap that hid #50/#51).
// A real server (this process) holds the store; a spawned `bun src/cli.ts hey`
// registers into it over HTTP; then the real cmdReply path replies. No mocks.

const repoRoot = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "maw-rr-"));
let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "lek" }, { oracle: "kang" }], lead: "lek" } } }),
  );
  const app = new Elysia({ prefix: "/api" }).use(requestReplyApi);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  port = server.port;
});
afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function spawnMaw(args: string[]): Promise<void> {
  // subprocess inherits MAW_PORT → CLI HTTP calls hit OUR test server (real CLI
  // reads MAW_PORT at its own module load, so the port is correct here).
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, MAW_DATA_DIR: dir, MAW_PORT: String(port), MAW_CLI: "1", MAW_TEST_MODE: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited.then(() => undefined);
}

const spawnHey = (message: string) => spawnMaw(["hey", "--from", "local:lek", "kang", message]);
const spawnReply = (id: string, reply: string) => spawnMaw(["reply", id, reply]);

describe("maw hey [request:id] → reply (subprocess + server, no mocks)", () => {
  test("hey registers the correlationId so reply --list / reply find it", async () => {
    await spawnHey("[request:t-1] do the thing\nmore");
    // the spawned hey POSTed /api/request/track into our store
    const entry = requestReplyStore.get("t-1");
    expect(entry).toBeDefined();
    expect(entry!.from).toBe("lek");
    expect(entry!.to).toBe("kang");
    expect(entry!.status).toBe("pending");
    expect(requestReplyStore.pendingFor("kang").some((e) => e.correlationId === "t-1")).toBe(true);

    // …and the real `maw reply` CLI resolves it (POST /api/reply/:id, our server)
    await spawnReply("t-1", "pong");
    expect(requestReplyStore.get("t-1")!.status).toBe("replied");
    expect(requestReplyStore.get("t-1")!.reply).toBe("pong");
  }, 30_000);

  test("idempotent — re-send same [request:id] does not duplicate or reset", async () => {
    await spawnHey("[request:t-2] first");
    await spawnReply("t-2", "answered");
    await spawnHey("[request:t-2] first"); // re-send after reply
    const matches = requestReplyStore.getAll().filter((e) => e.correlationId === "t-2");
    expect(matches.length).toBe(1);
    expect(matches[0].status).toBe("replied"); // not reset to pending
  }, 30_000);

  test("a normal hey (no [request:]) registers nothing", async () => {
    await spawnHey("just a normal message");
    expect(requestReplyStore.getAll().some((e) => e.message === "just a normal message")).toBe(false);
  }, 30_000);
});
