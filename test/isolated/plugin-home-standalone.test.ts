import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";

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

  // kobo-216 — home resolves its company through the STRICT resolver: a multi-company
  // oracle with no positional/flag throws "ambiguous" instead of silently first-matching.
  test("company resolution uses companyOfOracleStrict (kobo-216 option-a)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/home/index.ts"),
      "utf8",
    );
    expect(src).toContain("companyOfOracleStrict");
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

  // cli-reorg kobo-26: `maw home` is HARD-REMOVED (no shim). The plugin exports
  // the shared `runHome` runner (imported by the company plugin for
  // `maw company home`) but registers NO cli command and NO default handler.
  test("exports runHome but has no shim handler / no default export", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/home/index.ts"),
      "utf8",
    );
    expect(src).toContain("export async function runHome");
    expect(src).not.toContain("export default"); // no top-level command handler
    expect(src).not.toContain("moved →"); // no deprecation shim notice
  });

  // Authoritative manifest via loadManifestFromDir (plugin.ts-first) — guards
  // against plugin.ts/json drift hiding a still-registered `maw home` (kobo-26).
  test("loaded manifest is a module surface with NO cli command (maw home → unknown)", () => {
    const manifest = loadManifestFromDir(join(import.meta.dir, "../../src/vendor/mpr-plugins/home"))!.manifest;
    expect(manifest.name).toBe("home");
    expect(manifest.cli).toBeUndefined(); // hard-removed — not dispatchable as `maw home`
    expect(manifest.module?.exports).toContain("runHome"); // company imports this
  });
});
