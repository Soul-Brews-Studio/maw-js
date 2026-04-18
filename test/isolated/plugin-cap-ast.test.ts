/**
 * Phase B Wave 1A — isolated tests for AST-based capability inference.
 *
 * Covers all four patterns the Phase A regex misses:
 *   1. Direct import + call          — `import maw from "@maw-js/sdk"; maw.identity()`
 *   2. Destructured usage            — `const { identity } = maw; identity()`
 *   3. Aliased binding               — `const m = maw; m.wake()`
 *   4. Dynamic member access         — `maw["wake"]()`
 *
 * Plus: re-export chain, named imports, namespace imports, multiple SDK specifiers,
 * non-SDK module caps (node:fs, node:child_process, bun:ffi), global fetch(),
 * dynamic require(), invariant check (AST ≥ regex).
 *
 * These tests run in isolation (one bun process) via scripts/test-isolated.sh
 * to prevent mock pollution from other test files.
 */

import { describe, test, expect } from "bun:test";
import { inferCapabilitiesAst } from "../../src/plugin/cap-infer-ast";
import { inferCapabilitiesRegex } from "../../src/commands/plugins/plugin/build-impl";

// ─── Pattern 1: Direct import + call ─────────────────────────────────────────

describe("AST: direct import + call", () => {
  test("default import → maw.identity()", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw.identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("multiple verbs", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw.identity();
      maw.send("a", "b");
      maw.wake("agent");
    `);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
    expect(caps).toContain("sdk:wake");
  });

  test("aliased default import", () => {
    const caps = inferCapabilitiesAst(`
      import mawSdk from "@maw-js/sdk";
      mawSdk.identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("namespace import (import * as maw)", () => {
    const caps = inferCapabilitiesAst(`
      import * as maw from "@maw-js/sdk";
      maw.identity();
      maw.send("x", "y");
    `);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
  });

  test("alternative SDK specifiers: 'maw'", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "maw";
      maw.identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("alternative SDK specifiers: 'maw-sdk'", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "maw-sdk";
      maw.wake("agent");
    `);
    expect(caps).toContain("sdk:wake");
  });

  test("alternative SDK specifiers: 'maw/sdk'", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "maw/sdk";
      maw.identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("output is sorted and deduplicated", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw.identity();
      maw.identity();
      maw.send("a", "b");
      maw.identity();
    `);
    // Sorted, unique
    expect(caps).toEqual(["sdk:identity", "sdk:send"]);
  });
});

// ─── Pattern 2: Destructured usage ───────────────────────────────────────────

describe("AST: destructured usage", () => {
  test("named import: import { identity } from '@maw-js/sdk'", () => {
    const caps = inferCapabilitiesAst(`
      import { identity } from "@maw-js/sdk";
      identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("named import with rename: import { identity as id }", () => {
    const caps = inferCapabilitiesAst(`
      import { identity as id, send as s } from "@maw-js/sdk";
      id();
      s("a", "b");
    `);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
  });

  test("destructure from maw variable: const { identity } = maw", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      const { identity } = maw;
      identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("destructure with rename from maw variable: const { identity: id } = maw", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      const { identity: id, send: s } = maw;
      id();
      s("a", "b");
    `);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
  });

  test("destructure from aliased maw binding", () => {
    const caps = inferCapabilitiesAst(`
      import mawSdk from "@maw-js/sdk";
      const m = mawSdk;
      const { identity } = m;
      identity();
    `);
    expect(caps).toContain("sdk:identity");
  });
});

// ─── Pattern 3: Aliased binding ──────────────────────────────────────────────

describe("AST: aliased binding", () => {
  test("const m = maw; m.wake()", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      const m = maw;
      m.wake("agent");
    `);
    expect(caps).toContain("sdk:wake");
  });

  test("let alias = maw; alias.identity()", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      let alias = maw;
      alias.identity();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("nested alias chain: const a = maw; const b = a; b.send()", () => {
    // Note: current walker does a single pre-pass. If a = maw, then b = a,
    // b should also be tracked since collectVariableAliases runs recursively.
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      const a = maw;
      const b = a;
      b.send("x", "y");
    `);
    // a is added in first pass, b should be added when a is already in set
    // The recursive walk ensures b = a is caught after a is added.
    expect(caps).toContain("sdk:send");
  });
});

// ─── Pattern 4: Dynamic member access ────────────────────────────────────────

describe("AST: dynamic member access", () => {
  test("maw['wake']() — static string bracket access", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw["wake"]("agent");
    `);
    expect(caps).toContain("sdk:wake");
  });

  test("maw['identity']() — another static bracket", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw["identity"]();
    `);
    expect(caps).toContain("sdk:identity");
  });

  test("maw[varKey]() — dynamic bracket emits sdk:*dynamic*", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      const key = "wake";
      maw[key]("agent");
    `);
    // Dynamic key — we don't know which method; sentinel emitted
    expect(caps).toContain("sdk:*dynamic*");
  });

  test("maw[computedKey()]() — dynamic bracket emits sdk:*dynamic*", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      function getKey() { return "send"; }
      maw[getKey()]("a", "b");
    `);
    expect(caps).toContain("sdk:*dynamic*");
  });
});

// ─── Re-export chain ─────────────────────────────────────────────────────────

describe("AST: re-export chain", () => {
  test("re-exported maw methods are tracked as named bindings", () => {
    // If a file re-exports from @maw-js/sdk and calls the methods,
    // named imports are tracked regardless of re-export in other files.
    // (We scan per-file; each file's imports are tracked independently.)
    const caps = inferCapabilitiesAst(`
      import { identity, send } from "@maw-js/sdk";
      export { identity, send };  // re-export
      // Call sites in same file:
      identity();
      send("a", "b");
    `);
    expect(caps).toContain("sdk:identity");
    expect(caps).toContain("sdk:send");
  });

  test("re-export without local call — no false positives", () => {
    // Re-exporting without calling should NOT add capabilities
    // (capability = usage, not declaration)
    const caps = inferCapabilitiesAst(`
      export { identity, send } from "@maw-js/sdk";
    `);
    // Re-exports via export...from don't create local call bindings
    expect(caps).not.toContain("sdk:identity");
    expect(caps).not.toContain("sdk:send");
  });
});

// ─── Non-SDK module capabilities ─────────────────────────────────────────────

describe("AST: non-SDK module capabilities", () => {
  test("import 'node:fs' → fs:read", () => {
    expect(inferCapabilitiesAst(`import fs from "node:fs"; fs.readFileSync("a");`)).toContain("fs:read");
  });

  test("import { readFileSync } from 'node:fs' → fs:read", () => {
    expect(inferCapabilitiesAst(`import { readFileSync } from "node:fs"; readFileSync("a");`)).toContain("fs:read");
  });

  test("import from 'node:fs/promises' → fs:read", () => {
    expect(inferCapabilitiesAst(`import { readFile } from "node:fs/promises";`)).toContain("fs:read");
  });

  test("import 'node:child_process' → proc:spawn", () => {
    expect(inferCapabilitiesAst(`import { spawnSync } from "node:child_process";`)).toContain("proc:spawn");
  });

  test("import 'bun:ffi' → ffi:any", () => {
    expect(inferCapabilitiesAst(`import { dlopen } from "bun:ffi";`)).toContain("ffi:any");
  });

  test("dynamic require('node:fs') → fs:read", () => {
    expect(inferCapabilitiesAst(`const fs = require("node:fs");`)).toContain("fs:read");
  });

  test("dynamic require('node:child_process') → proc:spawn", () => {
    expect(inferCapabilitiesAst(`const cp = require("node:child_process");`)).toContain("proc:spawn");
  });

  test("global fetch() → net:fetch", () => {
    expect(inferCapabilitiesAst(`const r = await fetch("https://example.com/api");`)).toContain("net:fetch");
  });

  test("maw.fetch() does NOT add net:fetch (sdk method, not global)", () => {
    const caps = inferCapabilitiesAst(`
      import maw from "@maw-js/sdk";
      maw.fetch("https://x");
    `);
    expect(caps).toContain("sdk:fetch");
    expect(caps).not.toContain("net:fetch");
  });
});

// ─── Invariant: AST ≥ regex (equal-or-stricter) ──────────────────────────────

describe("invariant: AST catches everything regex catches", () => {
  // For inputs where BOTH paths operate on the same source text, AST must
  // detect at least what regex detects. (In practice, regex runs on bundle
  // text while AST runs on source — but for inputs valid for both, the
  // invariant must hold.)

  const sharedCases = [
    ["node:fs import", `import fs from "node:fs";`],
    ["node:fs/promises import", `import { readFile } from "node:fs/promises";`],
    ["node:child_process import", `import { spawn } from "node:child_process";`],
    ["bun:ffi import", `import { dlopen } from "bun:ffi";`],
    ["global fetch", `const r = await fetch("https://x");`],
    ["no capabilities", `const x = 42;`],
  ] as [string, string][];

  for (const [label, src] of sharedCases) {
    test(`${label}: AST ≥ regex`, () => {
      const regexCaps = new Set(inferCapabilitiesRegex(src));
      const astCaps = new Set(inferCapabilitiesAst(src));
      for (const cap of regexCaps) {
        expect(astCaps).toContain(cap);
      }
    });
  }

  test("AST catches destructured usage missed by regex", () => {
    const src = `
      import maw from "@maw-js/sdk";
      const { identity } = maw;
      identity();
    `;
    // Regex: sees no `maw.X()` call (identity() is not prefixed with maw.)
    const regexCaps = inferCapabilitiesRegex(src);
    expect(regexCaps).not.toContain("sdk:identity"); // regex misses this!

    // AST: correctly detects identity as a maw binding
    const astCaps = inferCapabilitiesAst(src);
    expect(astCaps).toContain("sdk:identity");
  });

  test("AST catches aliased maw missed by regex", () => {
    const src = `
      import maw from "@maw-js/sdk";
      const m = maw;
      m.wake("agent");
    `;
    // Regex: `maw\.(\w+)` sees `maw` binding but `m.wake()` is NOT caught
    const regexCaps = inferCapabilitiesRegex(src);
    // Regex would miss m.wake — confirm
    expect(regexCaps).not.toContain("sdk:wake");

    // AST: correctly detects m as maw alias
    const astCaps = inferCapabilitiesAst(src);
    expect(astCaps).toContain("sdk:wake");
  });

  test("AST catches bracket access missed by regex", () => {
    const src = `
      import maw from "@maw-js/sdk";
      maw["wake"]("agent");
    `;
    // Regex pattern `\bmaw\.(\w+)\b` does NOT match `maw["wake"]`
    const regexCaps = inferCapabilitiesRegex(src);
    expect(regexCaps).not.toContain("sdk:wake"); // regex misses this!

    // AST: correctly detects bracket access
    const astCaps = inferCapabilitiesAst(src);
    expect(astCaps).toContain("sdk:wake");
  });
});
