/**
 * Tests for src/plugin/cap-infer-ast.ts — inferCapabilitiesAst.
 * Pure AST analysis, no I/O. Uses TypeScript compiler API.
 */
import { describe, it, expect } from "bun:test";
import { inferCapabilitiesAst } from "../../src/plugin/cap-infer-ast";

describe("inferCapabilitiesAst", () => {
  it("detects maw.identity() via default import", () => {
    const src = `import maw from "@maw-js/sdk";\nmaw.identity();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:identity");
  });

  it("detects maw.send() via namespace import", () => {
    const src = `import * as maw from "@maw-js/sdk";\nmaw.send("neo", "hi");`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:send");
  });

  it("detects named import usage", () => {
    const src = `import { identity, send } from "@maw-js/sdk";\nidentity();\nsend("neo", "hi");`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
  });

  it("detects aliased named import", () => {
    const src = `import { identity as id } from "@maw-js/sdk";\nid();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:identity");
  });

  it("detects bracket access with string literal", () => {
    const src = `import maw from "@maw-js/sdk";\nmaw["wake"]();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:wake");
  });

  it("detects bracket access with dynamic key", () => {
    const src = `import maw from "@maw-js/sdk";\nconst key = "wake";\nmaw[key]();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:*dynamic*");
  });

  it("detects alias pattern (const m = maw)", () => {
    const src = `import maw from "@maw-js/sdk";\nconst m = maw;\nm.identity();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:identity");
  });

  it("detects destructure pattern", () => {
    const src = `import maw from "@maw-js/sdk";\nconst { identity } = maw;\nidentity();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("sdk:identity");
  });

  it("detects node:fs module capability", () => {
    const src = `import { readFileSync } from "node:fs";`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("fs:read");
  });

  it("detects node:child_process module capability", () => {
    const src = `import { exec } from "node:child_process";`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("proc:spawn");
  });

  it("detects bun:ffi module capability", () => {
    const src = `import { dlopen } from "bun:ffi";`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("ffi:any");
  });

  it("detects global fetch()", () => {
    const src = `const res = await fetch("http://example.com");`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("net:fetch");
  });

  it("returns sorted, deduplicated results", () => {
    const src = `import maw from "@maw-js/sdk";\nmaw.send();\nmaw.send();\nmaw.identity();`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toEqual([...new Set(caps)].sort());
  });

  it("returns empty for source with no capabilities", () => {
    const src = `const x = 1 + 2;\nconsole.log(x);`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toEqual([]);
  });

  it("handles dynamic require('node:fs')", () => {
    const src = `const fs = require("node:fs");`;
    const caps = inferCapabilitiesAst(src);
    expect(caps).toContain("fs:read");
  });
});
