import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ACTIVE_PLUGINS_1500,
  DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1514,
  DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1523,
  DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1524,
  DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1531,
  DEFAULT_ACTIVE_PLUGINS_1531_MIGRATION,
  DEFAULT_ACTIVE_PLUGINS_1854,
  DEFAULT_ACTIVE_PLUGINS_1854_MIGRATION,
  isDefaultActive1514Plugin,
  isDefaultActive1523Plugin,
  isDefaultActive1524Plugin,
  isDefaultActive1531Plugin,
  isDefaultActive1854Plugin,
  isDefaultActivePlugin,
} from "../../src/plugin/default-active";
import { DEFAULT_TIER, KNOWN_TIERS } from "../../src/plugin/manifest-constants";
import { weightToTier } from "../../src/plugin/tier";
import type { PluginTier } from "../../src/plugin/types";

type DefaultActiveKey = "1500" | "1514" | "1523" | "1524" | "1531" | "1854";

type WeightFixture = {
  name: string;
  weight: number;
  expected: PluginTier;
};

type DefaultActiveGroupFixture = {
  name: string;
  key: DefaultActiveKey;
  migration: string;
  expectedPlugins: string[];
  excludedPlugins: string[];
};

type FixtureRoot = {
  constants: {
    knownTiers: string[];
    defaultTier: string;
  };
  weightToTier: WeightFixture[];
  defaultActiveGroups: DefaultActiveGroupFixture[];
};

const fixtureUrl = new URL("./plugin-policy.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as FixtureRoot;

const defaultActivePolicy: Record<DefaultActiveKey, {
  plugins: readonly string[];
  migration: string;
  includes: (name: string) => boolean;
}> = {
  "1500": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1500,
    migration: DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION,
    includes: isDefaultActivePlugin,
  },
  "1514": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1514,
    migration: DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION,
    includes: isDefaultActive1514Plugin,
  },
  "1523": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1523,
    migration: DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION,
    includes: isDefaultActive1523Plugin,
  },
  "1524": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1524,
    migration: DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION,
    includes: isDefaultActive1524Plugin,
  },
  "1531": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1531,
    migration: DEFAULT_ACTIVE_PLUGINS_1531_MIGRATION,
    includes: isDefaultActive1531Plugin,
  },
  "1854": {
    plugins: DEFAULT_ACTIVE_PLUGINS_1854,
    migration: DEFAULT_ACTIVE_PLUGINS_1854_MIGRATION,
    includes: isDefaultActive1854Plugin,
  },
};

describe("portable plugin policy fixtures (#1612)", () => {
  test("known tier constants stay portable", () => {
    expect([...KNOWN_TIERS]).toEqual(fixtures.constants.knownTiers);
    expect(DEFAULT_TIER).toBe(fixtures.constants.defaultTier);
  });

  for (const fixture of fixtures.weightToTier) {
    test(`weightToTier: ${fixture.name}`, () => {
      expect(weightToTier(fixture.weight)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.defaultActiveGroups) {
    test(`default-active: ${fixture.name}`, () => {
      const policy = defaultActivePolicy[fixture.key];

      expect([...policy.plugins]).toEqual(fixture.expectedPlugins);
      expect(policy.migration).toBe(fixture.migration);
      for (const plugin of fixture.expectedPlugins) {
        expect(policy.includes(plugin)).toBe(true);
      }
      for (const plugin of fixture.excludedPlugins) {
        expect(policy.includes(plugin)).toBe(false);
      }
    });
  }
});
