import { describe, expect, test } from "bun:test";
import {
  analyzeSdkSurfaceParity,
  compareSdkSurface,
  formatSdkSurfaceParityFailure,
  type SymbolUse,
} from "../scripts/check-sdk-surface-parity";

function use(symbol: string): SymbolUse {
  return { symbol, file: "src/vendor/mpr-plugins/example/index.ts", line: 1, kind: "import" };
}

describe("SDK surface parity gate (#2750)", () => {
  test(
    "current packages/sdk/index.d.ts covers vendor maw-js/sdk imports",
    () => {
      const result = analyzeSdkSurfaceParity();
      expect(result.ok).toBe(true);
      expect(result.missingDeclarations).toEqual([]);
      expect(result.unreviewedPublicExports).toEqual([]);
      expect(result.vendorImports.length).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );

  test("injected vendor import drift fails when declaration is missing", () => {
    const result = compareSdkSurface(new Set(["definePlugin"]), [use("definePlugin"), use("__InjectedSdkDrift")]);
    expect(result.ok).toBe(false);
    expect(result.missingDeclarations).toEqual(["__InjectedSdkDrift"]);
  });

  test("injected public declaration drift fails until reviewed or used", () => {
    const result = compareSdkSurface(new Set(["definePlugin", "__InjectedPublicDrift"]), [use("definePlugin")]);
    expect(result.ok).toBe(false);
    expect(result.unreviewedPublicExports).toEqual(["__InjectedPublicDrift"]);
  });

  test("failure output points at the parity gate and offending symbol", () => {
    const base = compareSdkSurface(new Set(["definePlugin"]), [use("__InjectedSdkDrift")]);
    const message = formatSdkSurfaceParityFailure({ ...base, usesBySymbol: { __InjectedSdkDrift: [use("__InjectedSdkDrift")] } });
    expect(message).toContain("SDK surface parity gate failed (#2750)");
    expect(message).toContain("__InjectedSdkDrift");
    expect(message).toContain("src/vendor/mpr-plugins/example/index.ts:1");
  });
});
