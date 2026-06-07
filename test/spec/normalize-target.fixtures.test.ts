import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeTarget } from "../../src/core/matcher/normalize-target";

type Fixture = {
  name: string;
  input: string;
  expected: string;
};

const fixtureUrl = new URL("./normalize-target.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Fixture[];

describe("portable normalize-target fixtures (#1612)", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(normalizeTarget(fixture.input)).toBe(fixture.expected);
    });
  }
});
