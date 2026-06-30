import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// SUBPROCESS test — spawns the REAL `bun src/cli.ts hey …` entrypoint (not an
// in-process routeComm() call) and asserts the auto-created card FILE appears.
// This closes the gap that hid the #50/#51 issues: every prior test drove
// routeComm() directly or mocked cmdSend, so none proved the actual binary
// entrypoint fires the hook. Delivery itself fails in CI (no tmux pane) — that's
// fine: the hook runs BEFORE cmdSend, so the card is written regardless.

const repoRoot = join(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "maw-acsub-"));

beforeAll(() => {
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({
      name: "kobo",
      departments: { core: { members: [{ oracle: "eq3", role: "lead" }, { oracle: "patchwork", role: "dev" }], lead: "eq3" } },
    }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function runHey(message: string): Promise<void> {
  const proc = Bun.spawn(
    ["bun", "src/cli.ts", "hey", "--from", "local:eq3", "local:ghostzzz-oracle", message],
    {
      cwd: repoRoot,
      env: { ...process.env, MAW_DATA_DIR: dir, MAW_CLI: "1", MAW_TEST_MODE: "1" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await proc.exited; // delivery may exit non-zero — we only care about the card file
}

describe("maw hey [request:] subprocess → auto-create card file (entrypoint)", () => {
  test("a fresh request id creates a card file on disk via the real binary", async () => {
    await runHey("[request:sub-fresh-1] subprocess entrypoint proof\nbody line");
    const tasksDir = join(dir, "companies", "kobo", "tasks");
    expect(existsSync(tasksDir)).toBe(true);
    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const card = JSON.parse(readFileSync(join(tasksDir, files[0]), "utf-8"));
    expect(card.requestId).toBe("sub-fresh-1");
    expect(card.by).toBe("eq3");
    expect(card.assignee).toBe("ghostzzz");
    expect(card.state).toBe("in-progress");
    expect(card.title).toBe("subprocess entrypoint proof");
  }, 30_000);

  test("re-sending the same id via the binary is idempotent (no second file)", async () => {
    await runHey("[request:sub-fresh-1] subprocess entrypoint proof\nbody line");
    const tasksDir = join(dir, "companies", "kobo", "tasks");
    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1); // still one — idempotency holds at the entrypoint
  }, 30_000);
});
