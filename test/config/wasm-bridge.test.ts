/**
 * Tests for src/cli/wasm-bridge.ts — readString, writeString.
 * Pure memory ops using real WebAssembly.Memory — no WASM module needed.
 */
import { describe, it, expect } from "bun:test";
import { readString, writeString, textEncoder } from "../../src/cli/wasm-bridge";

const mem = () => new WebAssembly.Memory({ initial: 1 }); // 64KB page

describe("readString", () => {
  it("reads ASCII string from memory", () => {
    const m = mem();
    const bytes = textEncoder.encode("hello");
    new Uint8Array(m.buffer).set(bytes, 0);
    expect(readString(m, 0, bytes.length)).toBe("hello");
  });

  it("reads from non-zero offset", () => {
    const m = mem();
    const bytes = textEncoder.encode("world");
    new Uint8Array(m.buffer).set(bytes, 100);
    expect(readString(m, 100, bytes.length)).toBe("world");
  });

  it("reads empty string", () => {
    expect(readString(mem(), 0, 0)).toBe("");
  });

  it("reads UTF-8 multibyte characters", () => {
    const m = mem();
    const bytes = textEncoder.encode("日本語");
    new Uint8Array(m.buffer).set(bytes, 0);
    expect(readString(m, 0, bytes.length)).toBe("日本語");
  });

  it("reads emoji", () => {
    const m = mem();
    const bytes = textEncoder.encode("🔥🦁");
    new Uint8Array(m.buffer).set(bytes, 0);
    expect(readString(m, 0, bytes.length)).toBe("🔥🦁");
  });
});

describe("writeString", () => {
  it("writes string with 4-byte length prefix", () => {
    const m = mem();
    let nextPtr = 0;
    const alloc = (size: number) => { const p = nextPtr; nextPtr += size; return p; };

    const ptr = writeString(m, alloc, "hi");
    const view = new DataView(m.buffer);
    // First 4 bytes = length of "hi" in UTF-8 = 2
    expect(view.getUint32(ptr, true)).toBe(2);
    // Next bytes = "hi"
    expect(readString(m, ptr + 4, 2)).toBe("hi");
  });

  it("writes empty string", () => {
    const m = mem();
    let nextPtr = 0;
    const alloc = (size: number) => { const p = nextPtr; nextPtr += size; return p; };

    const ptr = writeString(m, alloc, "");
    const view = new DataView(m.buffer);
    expect(view.getUint32(ptr, true)).toBe(0);
  });

  it("writes multibyte UTF-8 with correct byte length", () => {
    const m = mem();
    let nextPtr = 0;
    const alloc = (size: number) => { const p = nextPtr; nextPtr += size; return p; };

    const ptr = writeString(m, alloc, "日本");
    const view = new DataView(m.buffer);
    // "日本" = 6 bytes in UTF-8
    expect(view.getUint32(ptr, true)).toBe(6);
    expect(readString(m, ptr + 4, 6)).toBe("日本");
  });

  it("allocates exactly 4 + byteLength", () => {
    const m = mem();
    let allocatedSize = 0;
    const alloc = (size: number) => { allocatedSize = size; return 0; };

    writeString(m, alloc, "test");
    expect(allocatedSize).toBe(4 + 4); // 4 prefix + 4 bytes for "test"
  });

  it("round-trips through readString", () => {
    const m = mem();
    let nextPtr = 0;
    const alloc = (size: number) => { const p = nextPtr; nextPtr += size; return p; };

    const original = "Hello, World! 🌍";
    const ptr = writeString(m, alloc, original);
    const view = new DataView(m.buffer);
    const len = view.getUint32(ptr, true);
    expect(readString(m, ptr + 4, len)).toBe(original);
  });

  it("handles consecutive writes at different offsets", () => {
    const m = mem();
    let nextPtr = 0;
    const alloc = (size: number) => { const p = nextPtr; nextPtr += size; return p; };

    const ptr1 = writeString(m, alloc, "first");
    const ptr2 = writeString(m, alloc, "second");
    expect(ptr2).toBeGreaterThan(ptr1);

    const view = new DataView(m.buffer);
    const len1 = view.getUint32(ptr1, true);
    const len2 = view.getUint32(ptr2, true);
    expect(readString(m, ptr1 + 4, len1)).toBe("first");
    expect(readString(m, ptr2 + 4, len2)).toBe("second");
  });
});
