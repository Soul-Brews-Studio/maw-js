import { describe, expect, test } from "bun:test";
import fixtures from "./bring-self-guard.fixtures.json";
import { isSelfBring } from "../../src/commands/shared/bring-flags";

describe("portable bring self-guard fixtures (#1816)", () => {
  for (const fixture of fixtures as Array<{
    name: string;
    target: string;
    callerSessionWindow: string | null;
    expected: boolean;
  }>) {
    test(fixture.name, () => {
      expect(isSelfBring(fixture.target, fixture.callerSessionWindow)).toBe(fixture.expected);
    });
  }
});
