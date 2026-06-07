import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { MawConfig } from "../../src/config";
import { resolveTarget, type ResolveResult, type Session } from "../../src/core/routing";

type FixtureSession = Session & { source?: string };
type Fixture = {
  name: string;
  query: string;
  config?: Partial<MawConfig>;
  sessions: FixtureSession[];
  expected: ResolveResult;
};

type FixtureRoot = {
  baseConfig: MawConfig;
  cases: Fixture[];
};

const fixtureUrl = new URL("./routing.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as FixtureRoot;

function configFor(fixture: Fixture): MawConfig {
  return { ...fixtures.baseConfig, ...(fixture.config ?? {}) };
}

describe("portable routing resolveTarget fixtures (#1612)", () => {
  for (const fixture of fixtures.cases) {
    test(fixture.name, () => {
      expect(resolveTarget(fixture.query, configFor(fixture), fixture.sessions)).toEqual(fixture.expected);
    });
  }
});
