import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const gapScript = join(repoRoot, "scripts/coverage-gap-analysis.ts");
const badgeScript = join(repoRoot, "scripts/coverage-badge.ts");

function writeFixture(root: string): void {
  mkdirSync(join(root, "src/wasm/maw-plugin-sdk-assemblyscript/assembly"), { recursive: true });
  mkdirSync(join(root, "src/wasm/examples/hello-package/assembly"), { recursive: true });
  mkdirSync(join(root, "coverage"), { recursive: true });
  mkdirSync(join(root, "docs/testing"), { recursive: true });

  writeFileSync(
    join(root, "src/runtime.ts"),
    [
      "// Bun may emit DA entries for comments; accounting ignores this.",
      "import type { Readable } from 'node:stream';",
      "interface Shape {",
      "  name: string;",
      "}",
      "export const covered = 1;",
      "export const partiallyCovered = 2;",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "src/uncovered.ts"), "export const missing = 3;\n");
  writeFileSync(
    join(root, "src/wasm/maw-plugin-sdk-assemblyscript/assembly/api.ts"),
    "export function wasmOnly(): i32 { return 1; }\n",
  );
  writeFileSync(
    join(root, "src/wasm/examples/hello-package/assembly/index.ts"),
    "export function templateOnly(): i32 { return 2; }\n",
  );
  writeFileSync(
    join(root, "coverage/lcov.info"),
    [
      "TN:",
      "SF:src/runtime.ts",
      "DA:1,0",
      "DA:2,0",
      "DA:3,0",
      "DA:4,0",
      "DA:5,0",
      "DA:6,1",
      "DA:7,0",
      "LF:7",
      "LH:1",
      "FNF:0",
      "FNH:0",
      "end_of_record",
      "",
    ].join("\n"),
  );
}

function runBunScript(cwd: string, script: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MAW_TEST_MODE: "1" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("coverage accounting for non-Bun AssemblyScript sources", () => {
  test("coverage gap report excludes asc-compiled AssemblyScript SDK files from absent-from-LCOV zero coverage", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-coverage-gap-"));
    writeFixture(root);

    const result = runBunScript(root, gapScript, ["coverage/lcov.info", "docs/testing/coverage-gap-analysis.md"]);

    expect(result.status).toBe(0);
    const report = readFileSync(join(root, "docs/testing/coverage-gap-analysis.md"), "utf8");
    expect(report).toContain("Overall line coverage: **33.3%** (1/3)");
    expect(report).not.toContain("Overall line coverage: **14.3%** (1/7)");
    expect(report).toContain("Source handled outside Bun LCOV");
    expect(report).toContain("src/wasm/maw-plugin-sdk-assemblyscript/assembly/");
    expect(report).toContain("src/wasm/examples/hello-package/assembly/");
    expect(report).toContain("asc-compiled WebAssembly");
    expect(report).toContain("`src/uncovered.ts`");
    expect(report).not.toContain("`src/wasm/maw-plugin-sdk-assemblyscript/assembly/api.ts`");
    expect(report).not.toContain("`src/wasm/examples/hello-package/assembly/index.ts`");
  });

  test("coverage badge uses the same Bun-runtime scope as the gap report", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-coverage-badge-"));
    writeFixture(root);

    const result = runBunScript(root, badgeScript, ["coverage/lcov.info", "coverage/maw-js-coverage.json"]);

    expect(result.status).toBe(0);
    const badge = JSON.parse(readFileSync(join(root, "coverage/maw-js-coverage.json"), "utf8"));
    expect(badge.message).toBe("33.3% lines");
  });
});
