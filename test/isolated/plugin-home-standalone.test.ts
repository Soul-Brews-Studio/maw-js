import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// #2316 plugin-coverage-gate: the Company-Home git engine lives in src/core/home/*
// (+ the worklog company-scope resolver). The `home` plugin is the thin CLI shell
// over that engine, so these deep imports are the EXPLICIT, intended coupling —
// pin the boundary here so extraction drift is visible (ADR 0002).

describe("home command plugin standalone boundary", () => {
  test("home shells the core/home store (+ worklog company-scope) over the SDK", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "home",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [
        /^(?:\.\.\/){3}core\/home\//,
        /^(?:\.\.\/){3}core\/worklog\/company-scope$/,
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("CLI dispatches the two documented subcommands", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/home/index.ts"),
      "utf8",
    );
    for (const sub of ['subcmd === "init"', 'subcmd === "commit"']) {
      expect(src).toContain(sub);
    }
    expect(src).toContain("initHome");
    expect(src).toContain("commitHome");
  });

  // cli-reorg (ADR docs/company/0001): dispatch is a shared `runHome` runner so
  // `maw company home` (company plugin) and the top-level shim share ONE copy.
  // The top-level handler is now a deprecation shim that prints "moved" + forwards.
  test("exports a shared runHome runner and the top-level handler is a deprecation shim", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/home/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runHome");
    expect(src).toContain("moved → 'maw company home'"); // shim notice
    expect(src).toContain("await runHome("); // handler forwards to the shared runner
    // transparent forward: bad-input error surfaces (notice must not shadow it)
    expect(src).toContain("error: r.error");
  });

  test("manifest keeps the `home` command as a deprecation alias", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/home/plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("home");
    expect(manifest.cli.command).toBe("home"); // still registered — it's the shim
    expect(manifest.cli.help).toMatch(/DEPRECATED/);
  });
});
