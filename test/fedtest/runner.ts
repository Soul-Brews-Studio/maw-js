/**
 * fedtest — runner (#655 Phase 1).
 *
 * Loads every `scenarios/*.ts`, picks a backend from `process.env.BACKEND`
 * (default "emulated"), and wraps each scenario in a `bun:test` `test()`.
 * No custom harness loop — failures surface as normal bun-test failures.
 *
 * Usage:
 *   bun test test/fedtest/runner.ts                   # emulated (default)
 *   BACKEND=emulated bun test test/fedtest/runner.ts  # explicit
 *   BACKEND=docker bun test test/fedtest/runner.ts    # wraps compose
 */

import { describe, test } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import type { BaseFederationBackend, BackendName } from "./backend";
import { EmulatedBackend } from "./emulated";
import { DockerBackend } from "./docker";
import { runScenario, type Scenario } from "./scenario";

const BACKEND = (process.env.BACKEND ?? "emulated") as BackendName;
const SCENARIOS_DIR = join(import.meta.dir, "scenarios");

function pickBackend(name: BackendName): BaseFederationBackend {
  if (name === "emulated") return new EmulatedBackend();
  if (name === "docker") return new DockerBackend();
  throw new Error(`unknown BACKEND="${name}" — expected "emulated" or "docker"`);
}

const skipDocker = BACKEND === "docker" && !DockerBackend.available();

// Eager-load scenarios so `describe` calls happen at import time (bun test
// discovers tests synchronously). Dynamic import() is awaited at the top
// level via an IIFE guard; scenarios/*.ts are tiny and synchronous.
const scenarioFiles = readdirSync(SCENARIOS_DIR)
  .filter(f => f.endsWith(".ts"))
  .sort();

const scenarios = await Promise.all(
  scenarioFiles.map(async (file) => {
    const mod = await import(join(SCENARIOS_DIR, file));
    const scenario = mod.default as Scenario | undefined;
    if (!scenario) throw new Error(`${file}: missing default export`);
    return scenario;
  }),
);

describe(`fedtest [${BACKEND}]`, () => {
  for (const scenario of scenarios) {
    const supported = !scenario.backends || scenario.backends.includes(BACKEND);

    if (!supported) {
      test.skip(`${scenario.name} (backend "${BACKEND}" not in scenario.backends)`, () => {});
      continue;
    }

    if (skipDocker) {
      test.skip(`${scenario.name} (docker not available)`, () => {});
      continue;
    }

    test(scenario.name, async () => {
      const backend = pickBackend(BACKEND);
      await runScenario(scenario, backend);
    }, scenario.backends?.includes("docker") && BACKEND === "docker" ? 180_000 : 30_000);
  }
});
