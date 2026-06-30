import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Track 4 — "done my part, PR up, review me": a reply carrying a PR url, whose
// correlationId maps to an auto-created task, attaches the PR + moves the card
// to review. Tested through the real POST /api/reply handler.

const dir = mkdtempSync(join(tmpdir(), "maw-replypr-"));
const prev = process.env.MAW_DATA_DIR;
process.env.MAW_DATA_DIR = dir;

const { requestReplyApi } = await import("../../src/api/request-reply");
const { requestReplyStore } = await import("../../src/core/request-reply");
const { addTask, readTask } = await import("../../src/core/tasks/store");

const app = new Elysia({ prefix: "/api" }).use(requestReplyApi);
let server: ReturnType<typeof Bun.serve>;
let base = "";

function seedCompany() {
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }, { oracle: "patchwork" }], lead: "eq3" } } }),
  );
}

beforeAll(() => {
  seedCompany();
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});
afterAll(() => {
  server?.stop(true);
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies", "kobo"), { recursive: true, force: true }); });

async function reply(correlationId: string, text: string) {
  return fetch(`${base}/api/reply/${correlationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply: text }),
  });
}

describe("reply with PR url → task.pr + review", () => {
  test("attaches the PR and moves the mapped task to review", async () => {
    // register the request (the in-band tracking path) + the auto-created task
    requestReplyStore.register({ correlationId: "rp-1", from: "eq3", to: "patchwork", target: "patchwork", message: "[request:rp-1] do x" });
    addTask({ company: "kobo", title: "do x", by: "eq3", assignee: "patchwork", requestId: "rp-1" });

    const res = await reply("rp-1", "done → https://github.com/meganechan/maw-js/pull/77 ✅");
    expect(res.status).toBe(200);

    const task = readTask("kobo", "kobo-1")!;
    expect(task.pr).toBe(77);
    expect(task.state).toBe("review");
  });

  test("a reply with no PR url leaves the task untouched", async () => {
    requestReplyStore.register({ correlationId: "rp-2", from: "eq3", to: "patchwork", target: "patchwork", message: "[request:rp-2] y" });
    addTask({ company: "kobo", title: "y", by: "eq3", assignee: "patchwork", requestId: "rp-2" });
    await reply("rp-2", "looks good, no PR yet");
    const task = readTask("kobo", "kobo-1")!;
    expect(task.pr).toBeUndefined();
    expect(task.state).toBe("in-progress"); // assignee set at create → in-progress, unchanged
  });

  test("reply for a correlationId with no task still succeeds (no crash)", async () => {
    requestReplyStore.register({ correlationId: "rp-3", from: "eq3", to: "patchwork", target: "patchwork", message: "no task" });
    const res = await reply("rp-3", "done https://github.com/x/y/pull/9");
    expect(res.status).toBe(200);
  });
});
