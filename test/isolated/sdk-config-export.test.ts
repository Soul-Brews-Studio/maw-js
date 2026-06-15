/**
 * sdk-config-export.test.ts
 *
 * Verifies `loadConfigWithProvenance` is exported from @maw-js/sdk after
 * extraction widening.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadConfigWithProvenance } from "../../packages/sdk";

const INDEX_DTS = resolve(__dirname, "..", "..", "packages", "sdk", "index.d.ts");

describe("@maw-js/sdk config export surface", () => {
  test("loadConfigWithProvenance is importable from the package surface", () => {
    expect(typeof loadConfigWithProvenance).toBe("function");
  });

  test("index.d.ts declares loadConfigWithProvenance", () => {
    const dts = readFileSync(INDEX_DTS, "utf8");
    expect(dts).toMatch(/export interface LoadedConfigWithProvenance/);
    expect(dts).toMatch(/export interface ConfigSource/);
    expect(dts).toMatch(/export interface ConfigProvenanceEntry/);
    expect(dts).toMatch(/export interface LoadConfigOptions/);
    expect(dts).toMatch(/export declare function loadConfigWithProvenance/);
  });

  test("index.d.ts remains self-contained (no parent-relative imports)", () => {
    const dts = readFileSync(INDEX_DTS, "utf8");
    expect(dts).not.toMatch(/from ["']\.\.{1,2}\//);
  });
});
