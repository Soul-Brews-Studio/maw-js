/**
 * Ecosystem drift guard — bun test counterpart to scripts/check-ecosystem.sh.
 *
 * Runs in the standard `bun run test` suite so local dev catches drift
 * before CI. Complements the shell script + GH Actions workflow added in
 * #576 by failing fast in the normal test loop.
 *
 * Incident this guards against (2026-04-17):
 *   src/server.ts was renamed to src/core/server.ts but ecosystem.config.cjs
 *   still referenced the old path → PM2 crash-loop.
 *
 *   Additionally, scripts/maw-boot.launcher.cjs hard-codes the CLI entry at
 *   ../src/cli.ts — if that file is renamed, the launcher silently fails in
 *   production. This test asserts that path too.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";

const REPO_ROOT = pathResolve(__dirname, "..");
const ECOSYSTEM = join(REPO_ROOT, "ecosystem.config.cjs");

describe("ecosystem.config.cjs — drift guard", () => {
  test("config file is present at repo root", () => {
    expect(existsSync(ECOSYSTEM)).toBe(true);
  });

  test("every apps[].script points to an existing file", () => {
    const config = require(ECOSYSTEM) as { apps: Array<{ name: string; script: string }> };
    expect(Array.isArray(config.apps)).toBe(true);
    expect(config.apps.length).toBeGreaterThan(0);

    const missing: Array<{ name: string; script: string }> = [];
    for (const app of config.apps) {
      const abs = join(REPO_ROOT, app.script);
      if (!existsSync(abs)) missing.push({ name: app.name, script: app.script });
    }

    if (missing.length > 0) {
      const msg = missing
        .map((m) => `  • ${m.name}: ${m.script} (not found)`)
        .join("\n");
      throw new Error(
        `ecosystem.config.cjs references missing scripts:\n${msg}\n\n` +
          `Likely a refactor renamed the file without updating the PM2 config. ` +
          `Run: bash scripts/check-ecosystem.sh for suggested paths.`,
      );
    }
  });

  test(".cjs launcher shims resolve their target entry", () => {
    // Launcher shims (e.g. scripts/maw-boot.launcher.cjs) hard-code the
    // real entry file they spawn. Static-parse their `path.join(..., "src", "cli.ts")`
    // style references and assert each resolves. Catches the class of failure
    // where a refactor moves the entry but the shim still points at the old one.
    const config = require(ECOSYSTEM) as { apps: Array<{ name: string; script: string }> };
    const launchers = config.apps
      .map((a) => a.script)
      .filter((s) => s.endsWith(".launcher.cjs") || s.endsWith(".cjs"));

    for (const launcherRel of launchers) {
      const launcherAbs = join(REPO_ROOT, launcherRel);
      const launcherDir = dirname(launcherAbs);
      const src = readFileSync(launcherAbs, "utf8");

      // Look for `path.join(__dirname, "..", "src", "foo.ts")` style refs.
      const joinRe = /path\.join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g;
      const matches = [...src.matchAll(joinRe)];
      for (const m of matches) {
        const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
        if (parts.length === 0) continue;
        const target = pathResolve(launcherDir, ...parts);
        // Only assert paths that look like source files (have an extension).
        if (/\.(ts|js|cjs|mjs)$/.test(target)) {
          if (!existsSync(target)) {
            throw new Error(
              `${launcherRel} references missing target: ${target}\n` +
                `Launcher shims must be updated in lockstep with source refactors.`,
            );
          }
        }
      }
    }
  });
});
