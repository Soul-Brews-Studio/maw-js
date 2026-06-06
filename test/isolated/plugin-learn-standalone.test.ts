import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const { default: learnHandler } = await import("../../src/vendor/mpr-plugins/learn/index.ts?plugin-learn-standalone");
const { resolveMode } = await import("../../src/vendor/mpr-plugins/learn/impl.ts?plugin-learn-standalone");

describe("learn plugin standalone boundary (#2113)", () => {
  test("has no direct core/shared/lib/plugin imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/learn", file), "utf8"),
    );
    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|plugin)(?:\/|\")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    expect(files.join("\n")).toContain('from "maw-js/sdk"');
  });

  test("validates flags and returns standalone scaffold output", async () => {
    expect(resolveMode(false, false)).toBe("default");
    expect(resolveMode(true, false)).toBe("fast");
    expect(() => resolveMode(true, true)).toThrow("mutually exclusive");

    const ok = await learnHandler({ source: "cli", args: ["Soul-Brews-Studio/maw-js", "--deep"] } as any);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('learn: deep mode on "Soul-Brews-Studio/maw-js"');

    await expect(learnHandler({ source: "cli", args: ["repo", "--fast", "--deep"] } as any)).resolves.toMatchObject({
      ok: false,
      error: "maw learn: --fast and --deep are mutually exclusive",
    });
    await expect(learnHandler({ source: "cli", args: [] } as any)).resolves.toMatchObject({
      ok: false,
      error: "usage: maw learn <repo> [--fast|--deep]",
    });
  });
});
