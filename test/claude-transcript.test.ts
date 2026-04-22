import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readTranscript,
  tailLatestAssistant,
  tailLatestUser,
} from "../src/core/fleet/claude-transcript";

const TMP = join(tmpdir(), `claude-transcript-test-${process.pid}`);
const JSONL = join(TMP, "sess.jsonl");

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-04-22T00:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "first user message" }, timestamp: "2026-04-22T00:00:01Z" }),
    JSON.stringify({ type: "hook_success", timestamp: "2026-04-22T00:00:02Z" }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "here is my answer" },
        { type: "tool_use", name: "Bash" },
      ]},
      timestamp: "2026-04-22T00:00:03Z",
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: "second user message" }, timestamp: "2026-04-22T00:00:04Z" }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
      timestamp: "2026-04-22T00:00:05Z",
    }),
    "", // blank line
    "garbage not-json", // malformed
  ].join("\n") + "\n";
  await writeFile(JSONL, lines);
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("readTranscript", () => {
  test("filters out queue/hook/system noise by default", async () => {
    const entries = await readTranscript(JSONL);
    expect(entries.length).toBe(4); // 2 user + 2 assistant
    expect(entries.map(e => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("extracts text + tool names from assistant content array", async () => {
    const entries = await readTranscript(JSONL);
    const firstAssistant = entries.find(e => e.role === "assistant" && e.text.includes("here"));
    expect(firstAssistant).toBeDefined();
    expect(firstAssistant!.text).toContain("here is my answer");
    expect(firstAssistant!.text).toContain("[tool: Bash]");
    expect(firstAssistant!.tools).toEqual(["Bash"]);
  });

  test("skips malformed lines gracefully", async () => {
    const entries = await readTranscript(JSONL);
    expect(entries.length).toBeGreaterThan(0);
  });

  test("raw=true keeps more types", async () => {
    const entries = await readTranscript(JSONL, { raw: true });
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  test("truncates text at maxTextLen", async () => {
    const big = "x".repeat(10000);
    const bigFile = join(TMP, "big.jsonl");
    await writeFile(bigFile, JSON.stringify({
      type: "user", message: { role: "user", content: big },
    }) + "\n");
    const entries = await readTranscript(bigFile, { maxTextLen: 50 });
    expect(entries[0].text.length).toBeLessThanOrEqual(51); // +1 for "…"
    expect(entries[0].text).toEndWith("…");
  });
});

describe("tailLatestAssistant / tailLatestUser", () => {
  test("returns last assistant message text, truncated to 200", async () => {
    const s = await tailLatestAssistant(JSONL);
    expect(s).toBe("final answer");
  });

  test("returns last user message text", async () => {
    const s = await tailLatestUser(JSONL);
    expect(s).toBe("second user message");
  });

  test("returns null for empty/nonexistent file", async () => {
    const missing = join(TMP, "does-not-exist.jsonl");
    expect(await tailLatestAssistant(missing)).toBeNull();
  });
});
