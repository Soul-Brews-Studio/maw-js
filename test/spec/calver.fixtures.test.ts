import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  compareBases,
  computeVersion,
  dateBase,
  effectiveBase,
  extractBaseFromVersion,
  hhmmStamp,
  isValidCalendarDate,
  maxNFromPackageJson,
  maxNFromTags,
  nextCalendarBase,
  type Channel,
} from "../../scripts/calver";

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
};

type Sign = "negative" | "zero" | "positive";

type ComputeVersionFixture = {
  name: string;
  args: {
    stable: boolean;
    channel?: Channel;
    now: DateParts;
  };
  tags: string[];
  packageVersion: string;
  expected: string;
  maxSuffix?: number;
};

type FixtureRoot = {
  dateBase: { name: string; now: DateParts; expected: string }[];
  hhmmStamp: { name: string; now: DateParts; expected: string }[];
  extractBaseFromVersion: { name: string; version: string; expected: string | null }[];
  compareBases: { name: string; a: string; b: string; expectedSign: Sign }[];
  isValidCalendarDate: { name: string; base: string; expected: boolean }[];
  nextCalendarBase: { name: string; base: string; expected: string }[];
  maxNFromTags: { name: string; base: string; channel: Channel; tags: string[]; expected: number }[];
  maxNFromPackageJson: { name: string; base: string; channel: Channel; packageVersion: string; expected: number }[];
  effectiveBase: ({ name: string; todayBase: string; packageVersion: string; expected: string } | { name: string; todayBase: string; packageVersion: string; errorIncludes: string })[];
  computeVersion: ComputeVersionFixture[];
};

const fixtureUrl = new URL("./calver.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as FixtureRoot;

function toDate(parts: DateParts): Date {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0);
}

function sign(value: number): Sign {
  if (value < 0) return "negative";
  if (value > 0) return "positive";
  return "zero";
}

describe("portable calver fixtures (#1612)", () => {
  for (const fixture of fixtures.dateBase) {
    test(`dateBase: ${fixture.name}`, () => {
      expect(dateBase(toDate(fixture.now))).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.hhmmStamp) {
    test(`hhmmStamp: ${fixture.name}`, () => {
      expect(hhmmStamp(toDate(fixture.now))).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.extractBaseFromVersion) {
    test(`extractBaseFromVersion: ${fixture.name}`, () => {
      expect(extractBaseFromVersion(fixture.version)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.compareBases) {
    test(`compareBases: ${fixture.name}`, () => {
      expect(sign(compareBases(fixture.a, fixture.b))).toBe(fixture.expectedSign);
    });
  }

  for (const fixture of fixtures.isValidCalendarDate) {
    test(`isValidCalendarDate: ${fixture.name}`, () => {
      expect(isValidCalendarDate(fixture.base)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.nextCalendarBase) {
    test(`nextCalendarBase: ${fixture.name}`, () => {
      expect(nextCalendarBase(fixture.base)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.maxNFromTags) {
    test(`maxNFromTags: ${fixture.name}`, () => {
      expect(maxNFromTags(fixture.base, fixture.channel, fixture.tags)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.maxNFromPackageJson) {
    test(`maxNFromPackageJson: ${fixture.name}`, () => {
      expect(maxNFromPackageJson(fixture.base, fixture.channel, fixture.packageVersion)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.effectiveBase) {
    test(`effectiveBase: ${fixture.name}`, () => {
      if ("errorIncludes" in fixture) {
        expect(() => effectiveBase(fixture.todayBase, fixture.packageVersion)).toThrow(fixture.errorIncludes);
        return;
      }
      expect(effectiveBase(fixture.todayBase, fixture.packageVersion)).toBe(fixture.expected);
    });
  }

  for (const fixture of fixtures.computeVersion) {
    test(`computeVersion: ${fixture.name}`, () => {
      const version = computeVersion(
        {
          stable: fixture.args.stable,
          channel: fixture.args.channel,
          check: false,
          now: toDate(fixture.args.now),
        },
        fixture.tags,
        fixture.packageVersion,
      );
      expect(version).toBe(fixture.expected);
      if (fixture.maxSuffix !== undefined) {
        const suffix = Number(version.split(".").at(-1));
        expect(suffix).toBeLessThanOrEqual(fixture.maxSuffix);
      }
    });
  }
});
