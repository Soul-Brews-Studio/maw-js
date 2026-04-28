/**
 * Tests for src/api/ui-state.ts — readUiState, writeUiState.
 * Uses temp file path override.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readUiState, writeUiState } from "../../src/api/ui-state";

const TMP_FILE = join(tmpdir(), `maw-ui-state-test-${Date.now()}.json`);

afterAll(() => { try { rmSync(TMP_FILE); } catch {} });

describe("readUiState", () => {
  it("returns empty object for non-existent file", () => {
    expect(readUiState("/tmp/nonexistent-maw-ui-state.json")).toEqual({});
  });

  it("reads valid JSON file", () => {
    writeFileSync(TMP_FILE, '{"theme":"dark"}', "utf-8");
    expect(readUiState(TMP_FILE)).toEqual({ theme: "dark" });
  });

  it("returns empty object for malformed JSON", () => {
    writeFileSync(TMP_FILE, "not valid json", "utf-8");
    expect(readUiState(TMP_FILE)).toEqual({});
  });
});

describe("writeUiState", () => {
  it("writes JSON to file", () => {
    writeUiState({ sidebar: true, zoom: 2 }, TMP_FILE);
    const result = readUiState(TMP_FILE);
    expect(result).toEqual({ sidebar: true, zoom: 2 });
  });

  it("overwrites existing state", () => {
    writeUiState({ old: true }, TMP_FILE);
    writeUiState({ new: true }, TMP_FILE);
    const result = readUiState(TMP_FILE);
    expect(result).toEqual({ new: true });
  });

  it("round-trips complex object", () => {
    const state = { panels: [1, 2, 3], settings: { a: "b" }, visible: false };
    writeUiState(state, TMP_FILE);
    expect(readUiState(TMP_FILE)).toEqual(state);
  });
});
