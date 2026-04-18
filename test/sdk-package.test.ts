/**
 * @maw-js/sdk workspace package tests — verifies the package is installable
 * from an external project via bun's file: protocol, that types resolve,
 * and that the runtime import of `maw` exposes the expected surface.
 *
 * sdk-consumer's Round 5 condition: "Red squigglies = build fails."
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const SDK_PKG_DIR = resolve(__dirname, "..", "packages", "sdk");

describe("@maw-js/sdk workspace package", () => {
  test("package.json declares expected fields", () => {
    const pkg = JSON.parse(
      require("fs").readFileSync(join(SDK_PKG_DIR, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@maw-js/sdk");
    expect(pkg.version).toBe("1.0.0-alpha.1");
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./index.ts");
    expect(pkg.types).toBe("./index.d.ts");
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["./plugin"]).toBeDefined();
  });

  test("ships self-contained .d.ts files (no external path imports)", () => {
    const indexDts = require("fs").readFileSync(
      join(SDK_PKG_DIR, "index.d.ts"),
      "utf8",
    );
    const pluginDts = require("fs").readFileSync(
      join(SDK_PKG_DIR, "plugin.d.ts"),
      "utf8",
    );
    // Declaration files must not reference paths outside the package —
    // otherwise file:/tarball installs from outside the repo break.
    expect(indexDts).not.toMatch(/from ["']\.\.\//);
    expect(pluginDts).not.toMatch(/from ["']\.\.\//);
    // Must declare the top-level exports plugins rely on.
    expect(indexDts).toMatch(/export declare const maw/);
    expect(indexDts).toMatch(/export interface Identity/);
    expect(pluginDts).toMatch(/export interface InvokeContext/);
    expect(pluginDts).toMatch(/export interface InvokeResult/);
  });

  test(
    "file: install from an outside project exposes maw runtime",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "maw-sdk-install-"));
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "maw-sdk-consumer-test",
            type: "module",
            dependencies: { "@maw-js/sdk": `file:${SDK_PKG_DIR}` },
          }),
        );
        const install = spawnSync("bun", ["install"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(install.status).toBe(0);

        // node_modules/@maw-js/sdk should resolve to our source
        const resolved = join(dir, "node_modules", "@maw-js", "sdk", "index.ts");
        expect(existsSync(resolved)).toBe(true);

        // Runtime import exposes the maw object
        writeFileSync(
          join(dir, "probe.ts"),
          `import { maw } from "@maw-js/sdk";
import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";
const h: (ctx: InvokeContext) => Promise<InvokeResult> = async () => ({ ok: true });
console.log(typeof maw.identity, typeof maw.federation, typeof maw.baseUrl, typeof h);
`,
        );
        const run = spawnSync("bun", ["run", "probe.ts"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(run.status).toBe(0);
        expect(run.stdout.trim()).toBe("function function function function");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
