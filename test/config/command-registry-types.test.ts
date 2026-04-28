/**
 * Tests for src/cli/command-registry-types.ts — WASM safety constants.
 */
import { describe, it, expect } from "bun:test";
import {
  WASM_MEMORY_MAX_PAGES,
  WASM_COMMAND_TIMEOUT_MS,
  commands,
  wasmInstances,
} from "../../src/cli/command-registry-types";

describe("WASM safety constants", () => {
  it("WASM_MEMORY_MAX_PAGES is 256 (16MB)", () => {
    expect(WASM_MEMORY_MAX_PAGES).toBe(256);
  });

  it("WASM_COMMAND_TIMEOUT_MS is 5 seconds", () => {
    expect(WASM_COMMAND_TIMEOUT_MS).toBe(5_000);
  });

  it("max memory is 16MB (pages * 64KB)", () => {
    expect(WASM_MEMORY_MAX_PAGES * 64 * 1024).toBe(16 * 1024 * 1024);
  });
});

describe("registry state", () => {
  it("commands is a Map", () => {
    expect(commands instanceof Map).toBe(true);
  });

  it("wasmInstances is a Map", () => {
    expect(wasmInstances instanceof Map).toBe(true);
  });
});
