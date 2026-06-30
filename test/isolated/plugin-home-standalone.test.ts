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

  test("manifest registers the `home` command", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/home/plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("home");
    expect(manifest.cli.command).toBe("home");
  });
});
